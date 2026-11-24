import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import Database from 'better-sqlite3'
import { spawnServer, type ServerHandle } from '../../test/compat/helpers/spawnServer.js'
import { createClient, type RisuClient } from '../../test/compat/helpers/client.js'
import io from './assetFileIO.cjs'
import { isWebp, markedPicture, picture } from './mediaTranscodeTestKit'

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

// The names of a backup archive's entries, in order and with repeats.
function archiveNames(data: Buffer) {
    const names: string[] = []
    for (let offset = 0; offset < data.length;) {
        const nameLength = data.readUInt32LE(offset); offset += 4
        names.push(data.subarray(offset, offset + nameLength).toString()); offset += nameLength
        offset += 4 + data.readUInt32LE(offset)
    }
    return names
}

describe('inlays through the server', () => {
    const read = (client: RisuClient, key: string) => client.fetch('/api/read', { headers: { 'file-path': hex(key) } })
    const remove = (client: RisuClient, key: string) => client.fetch('/api/remove', { headers: { 'file-path': hex(key) } })
    const listed = async (client: RisuClient) => (await (await client.fetch('/api/list', { headers: { 'key-prefix': 'inlay/' } })).json()).content as string[]
    const putInlay = (client: RisuClient, id: string, png: Buffer, ext = 'png') => put(client, `inlay/${id}`, Buffer.from(JSON.stringify(
        { ext, name: `${id} picture`, type: 'image', width: 640, height: 480, data: `data:image/${ext};base64,${png.toString('base64')}` })))
    const exported = async (client: RisuClient) => {
        const response = await client.fetch('/api/backup/export')
        expect(response.status).toBe(200)
        return archiveNames(Buffer.from(await response.arrayBuffer()))
    }

    it('converts an old PNG inlay and everything that shows it keeps working', async () => {
        // Inlays are held back until the scene is set, then switched on in the running server.
        const { server, client, saveDir, asset } = await boot({ enabled: true, inlays: false, paceMs: 0, sweepMinutes: 0.01 })
        const id = 'picture-one'
        const png = await picture()
        const inlayDir = path.join(saveDir, 'inlays')
        await putInlay(client, id, png)
        const meta = Buffer.from(JSON.stringify({ createdAt: 1700000000000, updatedAt: 1700000001000, charId: 'char-1', chatId: 'chat-1' }))
        await put(client, `inlay_meta/${id}`, meta)
        const when = (Date.now() - 60 * DAY) / 1000
        utimesSync(path.join(inlayDir, `${id}.png`), when, when)
        expect((await asset(`inlay_thumb/${id}`)).status).toBe(200)
        const oldThumbs = readdirSync(path.join(inlayDir, '.thumbs'))
        expect(oldThumbs).toHaveLength(1)
        expect((await asset(`inlay/${id}`)).headers.get('content-type')).toContain('image/png')

        writeFileSync(path.join(saveDir, 'media-transcode.json'), JSON.stringify({ enabled: true, paceMs: 0, sweepMinutes: 0.01 }))
        const converted = await until('the WebP to be served', async () => {
            const response = await asset(`inlay/${id}`)
            return response.headers.get('content-type')?.includes('image/webp') ? response : null
        })
        const body = Buffer.from(await converted.arrayBuffer())
        expect(isWebp(body)).toBe(true)
        expect(body.length).toBeLessThan(png.length)
        expect(readdirSync(inlayDir).filter(name => name.startsWith(id)).sort()).toEqual([`${id}.meta.json`, `${id}.webp`])

        // What the inlay screens read: the payload, its record, the list, the thumbnail.
        const payload = JSON.parse(Buffer.from(await (await read(client, `inlay/${id}`)).arrayBuffer()).toString())
        expect(payload).toMatchObject({ ext: 'webp', name: `${id} picture`, type: 'image', width: 640, height: 480 })
        expect(payload.data.startsWith('data:image/webp;base64,')).toBe(true)
        expect(JSON.parse(Buffer.from(await (await read(client, `inlay_info/${id}`)).arrayBuffer()).toString()))
            .toEqual({ ext: 'webp', name: `${id} picture`, type: 'image', width: 640, height: 480 })
        expect(Buffer.from(await (await read(client, `inlay_meta/${id}`)).arrayBuffer()).equals(meta)).toBe(true)
        expect((await listed(client)).filter(key => key === `inlay/${id}`)).toHaveLength(1)
        const thumb = await asset(`inlay_thumb/${id}`)
        expect(thumb.status).toBe(200)
        expect(thumb.headers.get('content-type')).toContain('image/webp')
        const thumbs = readdirSync(path.join(inlayDir, '.thumbs'))
        expect(thumbs).toHaveLength(1)
        expect(thumbs).not.toEqual(oldThumbs)

        // A stale client sends back the record it had: the extension stays what the file is.
        await put(client, `inlay_info/${id}`, Buffer.from(JSON.stringify({ ext: 'png', name: 'renamed', type: 'image', width: 640, height: 480 })))
        expect(JSON.parse(Buffer.from(await (await read(client, `inlay_info/${id}`)).arrayBuffer()).toString())).toMatchObject({ ext: 'webp', name: 'renamed' })

        // The original waits in quarantine and is asked to be pinned.
        const relative = `media-originals/inlays/${createHash('sha256').update(png).digest('hex')}.png`
        expect(readFileSync(path.join(saveDir, relative)).equals(png)).toBe(true)
        const wantPath = path.join(saveDir, 'media-originals', 'want.list')
        await until('the want list', () => existsSync(wantPath) && readFileSync(wantPath, 'utf-8').includes(relative))

        // An archive carries the inlay once, as what it is now.
        const names = await exported(client)
        expect(names.filter(name => name.startsWith('inlay/'))).toEqual([`inlay/${id}.webp`])
        expect(names.filter(name => name === `inlay_sidecar/${id}`)).toHaveLength(1)
        expect(names).toContain(`inlay_meta/${id}`)

        // Removing it removes it; the original stays for the pin.
        expect((await remove(client, `inlay/${id}`)).status).toBe(200)
        expect((await remove(client, `inlay_info/${id}`)).status).toBe(200)
        expect(readdirSync(inlayDir).filter(name => name.startsWith(id))).toEqual([])
        expect(await listed(client)).not.toContain(`inlay/${id}`)
        expect(existsSync(path.join(saveDir, relative))).toBe(true)
        await server.stop('SIGTERM')
    }, 120_000)

    it('treats two payloads of one id, as an interrupted conversion leaves them, as one inlay', async () => {
        const { client, saveDir } = await boot(null)
        const inlayDir = path.join(saveDir, 'inlays')
        const png = await picture()
        // The sidecar still names the PNG; a WebP lies next to it.
        await putInlay(client, 'first', png)
        writeFileSync(path.join(inlayDir, 'first.webp'), 'stray')
        // The sidecar already names the WebP; the PNG lies next to it.
        await putInlay(client, 'second', png)
        writeFileSync(path.join(inlayDir, 'second.webp'), Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP')]))
        writeFileSync(path.join(inlayDir, 'second.meta.json'), JSON.stringify({ ext: 'webp', name: 'second picture', type: 'image', width: 640, height: 480 }))
        await putInlay(client, 'third', png)
        writeFileSync(path.join(inlayDir, 'third.webp'), 'stray')

        expect((await listed(client)).filter(key => /^inlay\/(first|second|third)$/.test(key)).sort()).toEqual(['inlay/first', 'inlay/second', 'inlay/third'])
        const names = await exported(client)
        expect(names.filter(name => name.startsWith('inlay/')).sort()).toEqual(['inlay/first.png', 'inlay/second.webp', 'inlay/third.png'])
        expect(names.filter(name => name.startsWith('inlay_sidecar/')).sort()).toEqual(['inlay_sidecar/first', 'inlay_sidecar/second', 'inlay_sidecar/third'])

        // Removing an inlay takes both files; so does writing it anew.
        expect((await remove(client, 'inlay/first')).status).toBe(200)
        expect((await remove(client, 'inlay/second')).status).toBe(200)
        await putInlay(client, 'third', png, 'jpg')
        expect(readdirSync(inlayDir).filter(name => /^(first|second|third)\./.test(name)).sort()).toEqual(['third.jpg', 'third.meta.json'])
        expect(await listed(client)).not.toContain('inlay/first')
        expect(await listed(client)).not.toContain('inlay/second')
    }, 60_000)
})
