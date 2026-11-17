// @vitest-environment node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient } from '../../test/compat/helpers/client.js'
import { spawnServer, type ServerHandle } from '../../test/compat/helpers/spawnServer.js'
import pkg from './comfy/assetStore.cjs'

const { createComfyAssetStore } = pkg as {
    createComfyAssetStore: (options: { inlayDir: string, stagingDir: string }) => {
        readInputAsset(assetId: string): Promise<any>
    }
}

const servers: ServerHandle[] = []

afterEach(async () => {
    for (const server of servers.splice(0)) await server.cleanup()
})

describe('canonical external-image inlay journey', { timeout: 30_000 }, () => {
    it('preserves wire bytes and publishes the sidecar Comfy requires', async () => {
        const core = await spawnServer({
            env: {
                RISU_TUNNEL_DISABLED: 'true',
                RISU_UPDATE_CHECK: 'false',
            },
        })
        servers.push(core)
        const client = await createClient(core.port, core.password)
        const assetId = 'plugin-inlay-contract'
        const ext = 'png'
        const mimeType = 'image/png'
        const bytes = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex')
        const serialized = Buffer.from(JSON.stringify({
            data: `data:${mimeType};base64,${bytes.toString('base64')}`,
            ext,
            name: assetId,
            type: 'image',
        }))

        const response = await client.fetch('/api/write', {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'file-path': Buffer.from(`inlay/${assetId}`, 'utf8').toString('hex'),
            },
            body: serialized as any,
        })
        expect(response.status).toBe(200)

        const inlayDir = path.join(core.cwd, 'save', 'inlays')
        expect(await readFile(path.join(inlayDir, `${assetId}.${ext}`))).toEqual(bytes)
        expect(JSON.parse(await readFile(
            path.join(inlayDir, `${assetId}.meta.json`),
            'utf8',
        ))).toEqual({
            ext,
            name: assetId,
            type: 'image',
        })

        const comfy = createComfyAssetStore({
            inlayDir,
            stagingDir: path.join(core.cwd, 'save', 'comfy-staging-contract'),
        })
        await expect(comfy.readInputAsset(assetId)).resolves.toMatchObject({
            assetId,
            ext,
            mimeType,
            name: assetId,
            size: bytes.length,
            hash: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
            bytes,
        })
    })
})

describe('inlay metadata writes', { timeout: 30_000 }, () => {
    const hexKey = (key: string) => Buffer.from(key, 'utf8').toString('hex')
    const write = (client: Awaited<ReturnType<typeof createClient>>, key: string, value: unknown) => client.fetch('/api/write', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'file-path': hexKey(key) },
        body: Buffer.from(JSON.stringify(value)) as any,
    })

    it('keeps the ext of the stored file when a client sends a stale one', async () => {
        const core = await spawnServer({ env: { RISU_TUNNEL_DISABLED: 'true', RISU_UPDATE_CHECK: 'false' } })
        servers.push(core)
        const client = await createClient(core.port, core.password)
        const assetId = 'converted-inlay'
        // 'RIFF....WEBP': the image is stored as WebP (as after a PNG -> WebP conversion).
        const bytes = Buffer.from('524946460400000057454250', 'hex')
        expect((await write(client, `inlay/${assetId}`, {
            data: `data:image/webp;base64,${bytes.toString('base64')}`,
            ext: 'webp',
            name: assetId,
            type: 'image',
        })).status).toBe(200)

        // A client that still holds the old PNG in memory, and whose metadata read
        // failed, writes the metadata it has: ext "png".
        expect((await write(client, `inlay_info/${assetId}`, {
            ext: 'png',
            name: 'renamed',
            type: 'image',
            width: 1216,
            height: 832,
        })).status).toBe(200)

        const inlayDir = path.join(core.cwd, 'save', 'inlays')
        expect(JSON.parse(await readFile(path.join(inlayDir, `${assetId}.meta.json`), 'utf8'))).toEqual({
            ext: 'webp',
            name: 'renamed',
            type: 'image',
            width: 1216,
            height: 832,
        })
        expect(await readFile(path.join(inlayDir, `${assetId}.webp`))).toEqual(bytes)
        const comfy = createComfyAssetStore({ inlayDir, stagingDir: path.join(core.cwd, 'save', 'comfy-staging-contract') })
        await expect(comfy.readInputAsset(assetId)).resolves.toMatchObject({ assetId, ext: 'webp', bytes })
    })

    it('keeps a stored ext that itself contains a dot', async () => {
        const core = await spawnServer({ env: { RISU_TUNNEL_DISABLED: 'true', RISU_UPDATE_CHECK: 'false' } })
        servers.push(core)
        const client = await createClient(core.port, core.password)
        const assetId = 'dotted.id'
        expect((await write(client, `inlay/${assetId}`, {
            data: `data:audio/vnd.wave;base64,${Buffer.from('RIFF').toString('base64')}`,
            ext: 'vnd.wave',
            name: assetId,
            type: 'audio',
        })).status).toBe(200)
        expect((await write(client, `inlay_info/${assetId}`, { ext: 'wav', name: 'renamed', type: 'audio' })).status).toBe(200)

        const inlayDir = path.join(core.cwd, 'save', 'inlays')
        expect(await readFile(path.join(inlayDir, `${assetId}.vnd.wave`), 'utf8')).toBe('RIFF')
        expect(JSON.parse(await readFile(path.join(inlayDir, `${assetId}.meta.json`), 'utf8')))
            .toEqual({ ext: 'vnd.wave', name: 'renamed', type: 'audio' })
    })

    it('stores the metadata as sent while the sidecar points at no file', async () => {
        const core = await spawnServer({ env: { RISU_TUNNEL_DISABLED: 'true', RISU_UPDATE_CHECK: 'false' } })
        servers.push(core)
        const client = await createClient(core.port, core.password)
        const sidecar = async () => JSON.parse(await readFile(path.join(core.cwd, 'save', 'inlays', 'no-file-yet.meta.json'), 'utf8'))
        expect((await write(client, 'inlay_info/no-file-yet', { ext: 'png', name: 'pending', type: 'image' })).status).toBe(200)
        expect(await sidecar()).toEqual({ ext: 'png', name: 'pending', type: 'image' })
        // Still no file behind that sidecar, so a later write is free to change the ext.
        expect((await write(client, 'inlay_info/no-file-yet', { ext: 'webp', name: 'pending', type: 'image' })).status).toBe(200)
        expect(await sidecar()).toEqual({ ext: 'webp', name: 'pending', type: 'image' })
    })

    it('does not take the ext from another inlay whose id starts with this one', async () => {
        const core = await spawnServer({ env: { RISU_TUNNEL_DISABLED: 'true', RISU_UPDATE_CHECK: 'false' } })
        servers.push(core)
        const client = await createClient(core.port, core.password)
        expect((await write(client, 'inlay/foo.bar', {
            data: `data:image/webp;base64,${Buffer.from('524946460400000057454250', 'hex').toString('base64')}`,
            ext: 'webp',
            name: 'foo.bar',
            type: 'image',
        })).status).toBe(200)
        expect((await write(client, 'inlay_info/foo', { ext: 'png', name: 'foo', type: 'image' })).status).toBe(200)
        expect(JSON.parse(await readFile(path.join(core.cwd, 'save', 'inlays', 'foo.meta.json'), 'utf8')))
            .toEqual({ ext: 'png', name: 'foo', type: 'image' })
    })
})
