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
