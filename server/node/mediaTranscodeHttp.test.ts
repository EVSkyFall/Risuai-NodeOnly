import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { spawnServer, type ServerHandle } from '../../test/compat/helpers/spawnServer.js'
import { createClient, type RisuClient } from '../../test/compat/helpers/client.js'
import io from './assetFileIO.cjs'
import { isWebp, markedPicture } from './mediaTranscodeTestKit'

const servers: ServerHandle[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.cleanup() })
const hex = (key: string) => Buffer.from(key).toString('hex')
const DAY = 86_400_000

async function boot(config: Record<string, unknown> | null) {
    const server = await spawnServer({
        env: { RISU_TUNNEL_DISABLED: 'true', RISU_UPDATE_CHECK: 'false' },
        seedSave: async (saveDir) => {
            if (config) await writeFile(path.join(saveDir, 'media-transcode.json'), JSON.stringify(config))
        },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const session = await client.fetch('/api/session', { method: 'POST' })
    const cookie = session.headers.get('set-cookie')!.split(';')[0]
    const saveDir = path.join(server.cwd, 'save')
    const sql = <T>(action: (db: any) => T): T => {
        const db = new Database(path.join(saveDir, 'risuai.db'))
        db.pragma('busy_timeout = 5000')
        try { return action(db) } finally { db.close() }
    }
    const asset = (key: string) => client.fetch('/api/asset/' + hex(key), { headers: { cookie } })
    return { server, client, saveDir, sql, asset }
}

async function put(client: RisuClient, key: string, value: Buffer) {
    const response = await client.fetch('/api/write', { method: 'POST', headers: { 'file-path': hex(key), 'content-type': 'application/octet-stream' }, body: new Uint8Array(value) })
    expect(response.status).toBe(200)
}

async function until<T>(what: string, probe: () => Promise<T | false | null | undefined> | T | false | null | undefined, ms = 30_000): Promise<T> {
    const deadline = Date.now() + ms
    for (;;) {
        const value = await probe()
        if (value) return value
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await new Promise(resolve => setTimeout(resolve, 200))
    }
}

describe('media transcode through the server', () => {
    it('labels an asset by its bytes, whatever its key says', async () => {
        const { client, asset } = await boot(null)
        const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP')])
        const avif = Buffer.concat([Buffer.from([0, 0, 0, 28]), Buffer.from('ftypavif'), Buffer.alloc(16)])
        const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 28]), Buffer.from('ftypisom'), Buffer.alloc(16)])
        await put(client, 'assets/webp-inside.png', webp)
        await put(client, 'assets/avif-inside.png', avif)
        await put(client, 'assets/text-inside.png', Buffer.from('neither image nor video'))
        await put(client, 'assets/movie.mp4', mp4)
        await put(client, 'assets/avif-named-video.mp4', avif)
        expect((await asset('assets/webp-inside.png')).headers.get('content-type')).toContain('image/webp')
        expect((await asset('assets/avif-inside.png')).headers.get('content-type')).toContain('image/avif')
        expect((await asset('assets/text-inside.png')).headers.get('content-type')).toContain('image/png')
        expect((await asset('assets/movie.mp4')).headers.get('content-type')).toContain('video/mp4')
        expect((await asset('assets/avif-named-video.mp4')).headers.get('content-type')).toContain('video/mp4')
    })

    it('converts an old marked PNG, serves it as WebP, and deletes the original once it is pinned', async () => {
        const { server, client, saveDir, sql, asset } = await boot({ enabled: true, paceMs: 0, sweepMinutes: 0.01 })
        const key = 'assets/illustration.png'
        const png = await markedPicture()
        await put(client, key, png)
        const first = await asset(key)
        expect(first.headers.get('content-type')).toContain('image/png')
        const firstTag = first.headers.get('etag')
        const original = sql(db => db.prepare('SELECT generationId FROM asset_file_generations WHERE key = ? AND retired = 0').get(key).generationId)

        // Nothing happens to a young image.
        await new Promise(resolve => setTimeout(resolve, 2500))
        expect((await asset(key)).headers.get('content-type')).toContain('image/png')

        sql(db => db.prepare('UPDATE asset_file_generations SET updated_at = ? WHERE generationId = ?').run(Date.now() - 60 * DAY, original))
        const converted = await until('the WebP to be served', async () => {
            const response = await asset(key)
            return response.headers.get('content-type')?.includes('image/webp') ? response : null
        })
        expect(converted.headers.get('etag')).not.toBe(firstTag)
        const body = Buffer.from(await converted.arrayBuffer())
        expect(isWebp(body)).toBe(true)
        expect(body.length).toBeLessThan(png.length)
        expect(Number(converted.headers.get('content-length'))).toBe(body.length)

        // The original is still on disk and asked to be pinned.
        const originalFile = io.generationPath(path.join(saveDir, 'assets'), original)
        const relative = `assets/${original.slice(0, 2)}/${original}.blob`
        const wantPath = path.join(saveDir, 'media-originals', 'want.list')
        await until('the want list', () => existsSync(wantPath) && readFileSync(wantPath, 'utf-8').includes(relative))
        expect(readFileSync(originalFile).equals(png)).toBe(true)

        // The backup side confirms the pin; three days later (moved up here) the original goes.
        await writeFile(path.join(saveDir, 'media-originals', 'pin-test.covered'), `${relative}\n`)
        await until('the covered list to be ingested', () => sql(db => db.prepare('SELECT count(*) n FROM media_originals WHERE covered_at IS NOT NULL').get().n === 1))
        expect(existsSync(originalFile)).toBe(true)
        sql(db => db.prepare('UPDATE asset_file_retirements SET retired_at = ? WHERE generationId = ?').run(Date.now() - 4 * DAY, original))
        await until('the original to be deleted', () => !existsSync(originalFile))
        const collectedDir = path.join(saveDir, 'media-originals', 'collected')
        await until('the deletion to be listed for the mirror', () => existsSync(collectedDir)
            && readdirSync(collectedDir).some(name => readFileSync(path.join(collectedDir, name), 'utf-8').includes(relative)))
        const after = await asset(key)
        expect(after.status).toBe(200)
        expect(isWebp(Buffer.from(await after.arrayBuffer()))).toBe(true)

        // The process ends with the scheduler running (what stop() does is covered in mediaTranscode.test.ts).
        await server.stop('SIGTERM')
    }, 120_000)

    it('with "report" it records the decision and leaves the asset as it is', async () => {
        const { client, sql, asset, saveDir } = await boot({ enabled: 'report', paceMs: 0, sweepMinutes: 0.01 })
        const key = 'assets/illustration.png'
        await put(client, key, await markedPicture())
        const original = sql(db => db.prepare('SELECT generationId FROM asset_file_generations WHERE key = ? AND retired = 0').get(key).generationId)
        sql(db => db.prepare('UPDATE asset_file_generations SET updated_at = ? WHERE generationId = ?').run(Date.now() - 60 * DAY, original))
        await until('the report row', () => sql(db => db.prepare("SELECT 1 FROM media_transcode_log WHERE id = ? AND outcome = 'would-convert'").get(original)))
        expect((await asset(key)).headers.get('content-type')).toContain('image/png')
        expect(existsSync(path.join(saveDir, 'media-originals'))).toBe(false)
    }, 60_000)
})
