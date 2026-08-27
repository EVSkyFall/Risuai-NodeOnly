import { describe, expect, it, vi } from 'vitest'

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => ({}),
    getCurrentCharacter: () => ({ chaId: 'test-char' }),
}))
vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: {
        async createAuth() {
            return 'test-jwt'
        },
    },
}))
vi.mock('../../stableDiff', () => ({
    generateAIImageTyped: async () => {
        throw new Error('the provider path must never run in putMedia tests')
    },
}))
vi.mock('../../files/inlays', () => ({
    writeInlayImage: async () => {
        throw new Error('the generated-image writer must never run in putMedia tests')
    },
    writeInlayImageBytes: async () => {
        throw new Error('the default exact-byte writer must never run in putMedia tests')
    },
    removeInlayAsset: async () => {
        throw new Error('the default inlay path must never run in putMedia tests')
    },
    getInlayAsset: async () => {
        throw new Error('the default inlay path must never run in putMedia tests')
    },
    getInlayAssetBlob: async () => {
        throw new Error('the default inlay path must never run in putMedia tests')
    },
    getInlayAssetBlobFromStorage: async () => {
        throw new Error('the default inlay path must never run in putMedia tests')
    },
    getInlayInfosBatch: async () => {
        throw new Error('the default inlay path must never run in putMedia tests')
    },
}))
vi.mock('../../illustrationJobs/imagePromptMeasurement', () => ({
    evaluateImagePromptLimits: () => ({
        pooled: false,
        combinedTokens: 0,
        combinedLimit: 0,
        withinLimits: true,
    }),
    isNaiV5ImageModel: () => false,
    measureImagePrompt: async () => {
        throw new Error('the measurement path must never run in putMedia tests')
    },
}))
vi.mock('../../illustrationJobs/settingsFingerprint', () => ({
    canonicalizeNaiSettings: () => ({}),
    computeCanonicalNaiSettingsFingerprint: async () => 'nai-fingerprint',
}))

const { createPluginImagesApi } = await import('../pluginImages')
const { createPluginInlayMediaApi } = await import('../pluginInlayMedia')
type PluginImagesDependencies = import('../pluginImages').PluginImagesDependencies

const INSTALL_ID = '11111111-1111-4111-8111-111111111111'
const PNG_BYTES = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])
const MP3_BYTES = Uint8Array.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00])
const OGG_BYTES = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00])
const WAV_BYTES = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45,
])
const WEBM_BYTES = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00])

function largeMp4Bytes(): Uint8Array {
    const bytes = new Uint8Array(1024 * 1024 + 4096)
    bytes.fill(0x37)
    bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0)
    return bytes
}

function dataUrl(mimeType: string, bytes: Uint8Array): string {
    return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
}

type StoredAsset = {
    bytes: Uint8Array
    ext: string
    mimeType: string
    name: string
    type: 'image' | 'video' | 'audio'
}

function makeHarness() {
    const assets = new Map<string, StoredAsset>()
    const infos = new Map<string, { ext: string, name: string, type: string }>()
    const writes: string[] = []
    const claims: string[] = []
    let atomicRecord: { key: string, revision: number, value: any } | null = null
    const receipts = new Map<string, { binding: string, revision: number }>()

    const atomic = {
        async read(key: string) {
            if (!atomicRecord || atomicRecord.key !== key) {
                return { ok: true, key, revision: 0, value: null, deleted: false }
            }
            return { ok: true, ...atomicRecord, deleted: false }
        },
        async cas(input: { key: string, value: any, operationKey: string, expectedRevision?: number }) {
            claims.push(input.operationKey)
            const binding = JSON.stringify({
                key: input.key,
                value: input.value,
                expectedRevision: input.expectedRevision,
            })
            const prior = receipts.get(input.operationKey)
            if (prior) {
                if (prior.binding !== binding) {
                    return {
                        ok: false,
                        code: 'PLUGIN_ATOMIC_RECEIPT_MISMATCH',
                        message: 'operationKey reused with a different binding',
                        operationKey: input.operationKey,
                    }
                }
                return { ok: true, applied: true, revision: prior.revision }
            }
            const currentRevision = atomicRecord?.revision ?? 0
            if (input.expectedRevision !== currentRevision) {
                return {
                    ok: false,
                    code: 'PLUGIN_ATOMIC_CONFLICT',
                    message: 'plugin atomic revision conflict',
                    currentRevision,
                    currentDeleted: false,
                }
            }
            const revision = currentRevision + 1
            atomicRecord = { key: input.key, revision, value: structuredClone(input.value) }
            receipts.set(input.operationKey, { binding, revision })
            return { ok: true, applied: true, revision }
        },
    }

    const putImage = {
        installId: INSTALL_ID,
        atomic: atomic as any,
        async inspectInlay(assetId: string) {
            const asset = assets.get(assetId)
            return {
                asset: asset
                    ? {
                        data: new Blob([asset.bytes.slice().buffer], { type: asset.mimeType }),
                        ext: asset.ext,
                        name: asset.name,
                        type: asset.type,
                    }
                    : null,
                info: infos.get(assetId) ?? null,
            }
        },
        async writeInlayBytes(bytes: Uint8Array, input: {
            assetId: string
            ext: string
            mimeType: string
            name: string
            type: 'image' | 'video' | 'audio'
        }) {
            writes.push(input.assetId)
            assets.set(input.assetId, {
                bytes: bytes.slice(),
                ext: input.ext,
                mimeType: input.mimeType,
                name: input.name,
                type: input.type,
            })
            infos.set(input.assetId, { ext: input.ext, name: input.name, type: input.type })
            return input.assetId
        },
    }

    const deps: PluginImagesDependencies = {
        getDatabase: () => ({}),
        getCurrentCharacter: () => ({ chaId: 'char-1' }) as any,
        generateImage: async () => {
            throw new Error('provider must not run')
        },
        measure: async () => {
            throw new Error('measurement must not run')
        },
        writeInlay: async () => {
            throw new Error('generated-image writer must not run')
        },
        async removeInlay(assetId) {
            assets.delete(assetId)
            infos.delete(assetId)
        },
        async readInlay(assetId) {
            const asset = assets.get(assetId)
            if (!asset) return null
            return {
                data: dataUrl(asset.mimeType, asset.bytes),
                ext: asset.ext,
                name: asset.name,
                type: asset.type,
            }
        },
        putImage,
    } as PluginImagesDependencies

    const media = createPluginInlayMediaApi({
        readInlay: async assetId => {
            const asset = assets.get(assetId)
            if (!asset) return null
            return {
                data: new Blob([asset.bytes.slice().buffer], { type: asset.mimeType }),
                ext: asset.ext,
                name: asset.name,
                type: asset.type,
            }
        },
    })

    return { api: createPluginImagesApi(deps), media, assets, infos, writes, claims }
}

describe('pluginInlays.putMedia', () => {
    it.each([
        ['image/png', 'png', 'image', PNG_BYTES],
        ['video/mp4', 'mp4', 'video', largeMp4Bytes()],
        ['video/webm', 'webm', 'video', WEBM_BYTES],
        ['audio/mpeg', 'mp3', 'audio', MP3_BYTES],
        ['audio/ogg', 'ogg', 'audio', OGG_BYTES],
        ['audio/wav', 'wav', 'audio', WAV_BYTES],
    ])('roundtrips %s bytes exactly and reads back through readMedia', async (mimeType, ext, type, bytes) => {
        const harness = makeHarness()
        const put = await harness.api.putMedia({
            operationKey: `roundtrip-${ext}`,
            dataUrl: dataUrl(mimeType, bytes as Uint8Array),
        })
        expect(put).toMatchObject({ status: 'succeeded', result: { assetId: expect.any(String) } })
        if (put.status !== 'succeeded') throw new Error('unreachable')

        expect(harness.assets.get(put.result.assetId)).toMatchObject({ ext, mimeType, type })
        expect(Buffer.from(harness.assets.get(put.result.assetId)!.bytes)
            .equals(Buffer.from(bytes as Uint8Array))).toBe(true)

        const read = await harness.media.readMedia({ assetId: put.result.assetId })
        expect(read).toMatchObject({ status: 'succeeded', result: { mediaType: type, mimeType, ext } })
        if (read.status !== 'succeeded') throw new Error('unreachable')
        expect(Buffer.from(await read.result.data.arrayBuffer())
            .equals(Buffer.from(bytes as Uint8Array))).toBe(true)
    })

    it('normalizes MIME aliases onto the canonical stored type', async () => {
        const harness = makeHarness()
        const put = await harness.api.putMedia({
            operationKey: 'alias-wav',
            dataUrl: dataUrl('audio/x-wav', WAV_BYTES),
        })
        if (put.status !== 'succeeded') throw new Error('unreachable')
        expect(harness.assets.get(put.result.assetId)).toMatchObject({
            ext: 'wav',
            mimeType: 'audio/wav',
            type: 'audio',
        })
    })

    it('replays the same operationKey to the same asset without another storage write', async () => {
        const harness = makeHarness()
        const input = { operationKey: 'stable-media-replay', dataUrl: dataUrl('audio/mpeg', MP3_BYTES) }

        const first = await harness.api.putMedia(input)
        const replay = await harness.api.putMedia(input)

        expect(first).toEqual(replay)
        expect(first).toMatchObject({ status: 'succeeded' })
        expect(harness.assets.size).toBe(1)
        expect(harness.writes).toHaveLength(1)
    })

    it('repairs a torn media pair at the claimed asset id', async () => {
        const harness = makeHarness()
        const input = { operationKey: 'torn-media', dataUrl: dataUrl('video/webm', WEBM_BYTES) }
        const first = await harness.api.putMedia(input)
        if (first.status !== 'succeeded') throw new Error('unreachable')
        harness.infos.delete(first.result.assetId)

        const replay = await harness.api.putMedia(input)
        expect(replay).toEqual(first)
        expect(harness.infos.get(first.result.assetId)).toMatchObject({ ext: 'webm', type: 'video' })
        expect(harness.writes).toHaveLength(2)
    })

    it('shares the putImage claim record so one operationKey names one payload', async () => {
        const converged = makeHarness()
        const image = { operationKey: 'shared-claim', dataUrl: dataUrl('image/png', PNG_BYTES) }
        const viaImage = await converged.api.putImage(image)
        const viaMedia = await converged.api.putMedia(image)
        expect(viaImage).toEqual(viaMedia)
        expect(converged.assets.size).toBe(1)
        // The second call found the first call's receipt, so it never claimed.
        expect(converged.claims).toHaveLength(1)
        expect(converged.claims[0]).toContain(`risu:pluginInlays.putImage:${INSTALL_ID}:`)

        const conflicting = makeHarness()
        await expect(conflicting.api.putImage({
            operationKey: 'crossed-claim',
            dataUrl: dataUrl('image/png', PNG_BYTES),
        })).resolves.toMatchObject({ status: 'succeeded' })
        await expect(conflicting.api.putMedia({
            operationKey: 'crossed-claim',
            dataUrl: dataUrl('audio/mpeg', MP3_BYTES),
        })).resolves.toMatchObject({
            status: 'precondition_failed',
            code: 'inlay_operation_key_reused',
        })
        expect(conflicting.assets.size).toBe(1)
        expect([...conflicting.assets.values()][0]).toMatchObject({ type: 'image' })
    })

    it('keeps putImage image-only while putMedia accepts the same payload', async () => {
        const harness = makeHarness()
        await expect(harness.api.putImage({
            operationKey: 'image-only',
            dataUrl: dataUrl('video/mp4', WEBM_BYTES),
        })).resolves.toMatchObject({
            status: 'definite_failure',
            code: 'inlay_image_mime_unsupported',
        })
        expect(harness.assets.size).toBe(0)

        await expect(harness.api.putMedia({
            operationKey: 'image-only',
            dataUrl: dataUrl('video/mp4', largeMp4Bytes()),
        })).resolves.toMatchObject({ status: 'succeeded' })
    })

    it.each([
        ['not a data URL', 'https://example.invalid/clip.mp4'],
        ['an unsupported container', 'data:video/x-matroska;base64,AAAA'],
        ['a text payload', 'data:text/plain;base64,SGVsbG8='],
        ['invalid base64', 'data:audio/mpeg;base64,%%%'],
        ['an empty payload', 'data:video/mp4;base64,'],
    ])('returns definite_failure for %s without touching storage', async (_label, malformed) => {
        const harness = makeHarness()
        const result = await harness.api.putMedia({ operationKey: 'malformed-media', dataUrl: malformed })

        expect(result).toMatchObject({ status: 'definite_failure', code: expect.any(String) })
        expect(harness.assets.size).toBe(0)
        expect(harness.claims).toHaveLength(0)
    })
})
