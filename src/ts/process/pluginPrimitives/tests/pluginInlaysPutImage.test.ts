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
        throw new Error('the provider path must never run in putImage tests')
    },
}))
vi.mock('../../files/inlays', () => ({
    writeInlayImage: async () => {
        throw new Error('the generated-image writer must never run in putImage tests')
    },
    writeInlayImageBytes: async () => {
        throw new Error('the default exact-byte writer must never run in putImage tests')
    },
    removeInlayAsset: async () => {
        throw new Error('the default inlay path must never run in putImage tests')
    },
    getInlayAsset: async () => {
        throw new Error('the default inlay path must never run in putImage tests')
    },
    getInlayAssetBlob: async () => {
        throw new Error('the default inlay path must never run in putImage tests')
    },
    getInlayAssetBlobFromStorage: async () => {
        throw new Error('the default inlay path must never run in putImage tests')
    },
    getInlayInfosBatch: async () => {
        throw new Error('the default inlay path must never run in putImage tests')
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
        throw new Error('the measurement path must never run in putImage tests')
    },
}))
vi.mock('../../illustrationJobs/settingsFingerprint', () => ({
    canonicalizeNaiSettings: () => ({}),
    computeCanonicalNaiSettingsFingerprint: async () => 'nai-fingerprint',
}))

const { createPluginImagesApi } = await import('../pluginImages')
const { PluginAtomicClient, createPluginInternalAtomicSandboxApi } = await import('../pluginAtomic')
type PluginImagesDependencies = import('../pluginImages').PluginImagesDependencies
type PluginAtomicTransport = import('../pluginAtomic').PluginAtomicTransport

const INSTALL_ID = '11111111-1111-4111-8111-111111111111'
const PNG_BYTES = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

function largeJpegBytes(): Uint8Array {
    const bytes = new Uint8Array(1024 * 1024 + 257)
    bytes.fill(0x5a)
    bytes.set([0xff, 0xd8, 0xff, 0xe0], 0)
    bytes.set([0xff, 0xd9], bytes.length - 2)
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
    type: 'image'
}

type StoredInfo = {
    ext: string
    name: string
    type: 'image'
}

function makeHarness(options: {
    installId?: string
    atomicOverride?: any
    atomicReadFailure?: { code: string, message: string }
    throwAfterCompleteWrite?: boolean
} = {}) {
    const assets = new Map<string, StoredAsset>()
    const infos = new Map<string, StoredInfo>()
    const writes: string[] = []
    const atomicCalls = { reads: 0, writes: 0 }
    let atomicRecord: { key: string, revision: number, value: any } | null = null
    const receipts = new Map<string, { binding: string, revision: number }>()

    const atomic = {
        async read(key: string) {
            atomicCalls.reads += 1
            if (options.atomicReadFailure) {
                return { ok: false, ...options.atomicReadFailure }
            }
            if (!atomicRecord || atomicRecord.key !== key) {
                return { ok: true, key, revision: 0, value: null, deleted: false }
            }
            return { ok: true, ...atomicRecord, deleted: false }
        },
        async cas(input: { key: string, value: any, operationKey: string, expectedRevision?: number }) {
            atomicCalls.writes += 1
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
        installId: options.installId ?? INSTALL_ID,
        atomic: options.atomicOverride ?? atomic as any,
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
        }) {
            writes.push(input.assetId)
            assets.set(input.assetId, {
                bytes: bytes.slice(),
                ext: input.ext,
                mimeType: input.mimeType,
                name: input.name,
                type: 'image',
            })
            infos.set(input.assetId, {
                ext: input.ext,
                name: input.name,
                type: 'image',
            })
            if (options.throwAfterCompleteWrite) throw new Error('response lost after durable write')
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

    return { api: createPluginImagesApi(deps), assets, infos, writes, atomicCalls }
}

async function expectRoundtrip(operationKey: string, mimeType: string, bytes: Uint8Array) {
    const harness = makeHarness()
    const put = await harness.api.putImage({ operationKey, dataUrl: dataUrl(mimeType, bytes) })
    expect(put.status).toBe('succeeded')
    if (put.status !== 'succeeded') throw new Error('unreachable')

    const read = await harness.api.read({ assetId: put.result.assetId })
    expect(read.status).toBe('succeeded')
    if (read.status !== 'succeeded') throw new Error('unreachable')
    const expected = Buffer.from(bytes)
    expect(Buffer.from(read.result.dataUrl.split(',')[1], 'base64').equals(expected)).toBe(true)
    expect(Buffer.from(harness.assets.get(put.result.assetId)!.bytes).equals(expected)).toBe(true)
}

describe('pluginInlays.putImage', () => {
    it('roundtrips PNG bytes exactly through pluginInlays.read', async () => {
        await expectRoundtrip('png-roundtrip', 'image/png', PNG_BYTES)
    })

    it('roundtrips a JPEG payload larger than 1 MiB without a size gate', async () => {
        await expectRoundtrip('jpeg-large-roundtrip', 'image/jpeg', largeJpegBytes())
    })

    it('replays the same operationKey to the same asset without another storage write', async () => {
        const harness = makeHarness()
        const input = { operationKey: 'stable-replay', dataUrl: dataUrl('image/png', PNG_BYTES) }

        const first = await harness.api.putImage(input)
        const replay = await harness.api.putImage(input)

        expect(first).toEqual(replay)
        expect(first).toMatchObject({ status: 'succeeded', result: { assetId: expect.any(String) } })
        expect(harness.assets.size).toBe(1)
        expect(harness.writes).toHaveLength(1)
    })

    it('writes its reserved claim through the host-internal atomic surface', async () => {
        const requests: any[] = []
        const transport: PluginAtomicTransport = async (body: any) => {
            requests.push(body)
            if (body.op === 'read') {
                return {
                    status: 200,
                    json: async () => ({ key: body.key, revision: 0, value: null, deleted: false }),
                }
            }
            return {
                status: 200,
                json: async () => ({ applied: true, revision: 1 }),
            }
        }
        const atomic = createPluginInternalAtomicSandboxApi({
            installId: INSTALL_ID,
            client: new PluginAtomicClient({ transport }),
        })
        const harness = makeHarness({ atomicOverride: atomic })

        await expect(harness.api.putImage({
            operationKey: 'host-reserved-claim',
            dataUrl: dataUrl('image/png', PNG_BYTES),
        })).resolves.toMatchObject({ status: 'succeeded' })
        expect(requests).toHaveLength(2)
        expect(requests[1]).toMatchObject({
            op: 'cas',
            expectedRevision: 0,
            key: expect.stringContaining(':__risu_internal__/pluginInlays/putImage/'),
        })
    })

    it('restores a removed asset at the same deterministic id', async () => {
        const harness = makeHarness()
        const input = { operationKey: 'removed-replay', dataUrl: dataUrl('image/png', PNG_BYTES) }
        const first = await harness.api.putImage(input)
        if (first.status !== 'succeeded') throw new Error('unreachable')

        await harness.api.remove({ operationKey: 'remove-once', assetId: first.result.assetId })
        expect(harness.assets.has(first.result.assetId)).toBe(false)

        const replay = await harness.api.putImage(input)
        expect(replay).toEqual(first)
        expect(harness.assets.has(first.result.assetId)).toBe(true)
        expect(harness.writes).toHaveLength(2)
    })

    it.each([
        ['payload without sidecar', (h: ReturnType<typeof makeHarness>, id: string) => h.infos.delete(id)],
        ['sidecar without payload', (h: ReturnType<typeof makeHarness>, id: string) => h.assets.delete(id)],
        ['truncated payload', (h: ReturnType<typeof makeHarness>, id: string) => {
            const asset = h.assets.get(id)!
            h.assets.set(id, { ...asset, bytes: asset.bytes.slice(0, 8) })
        }],
    ])('repairs %s at the claimed asset id', async (_label, tear) => {
        const harness = makeHarness()
        const input = { operationKey: 'torn-state', dataUrl: dataUrl('image/png', PNG_BYTES) }
        const first = await harness.api.putImage(input)
        if (first.status !== 'succeeded') throw new Error('unreachable')
        tear(harness, first.result.assetId)

        const replay = await harness.api.putImage(input)
        expect(replay).toEqual(first)
        expect(harness.assets.get(first.result.assetId)?.bytes).toEqual(PNG_BYTES)
        expect(harness.infos.get(first.result.assetId)).toMatchObject({ ext: 'png', type: 'image' })
        expect(harness.writes).toHaveLength(2)
    })

    it('resolves a lost write response only after the complete pair is readable', async () => {
        const harness = makeHarness({ throwAfterCompleteWrite: true })
        const result = await harness.api.putImage({
            operationKey: 'lost-write-response',
            dataUrl: dataUrl('image/png', PNG_BYTES),
        })

        expect(result).toMatchObject({ status: 'succeeded', result: { assetId: expect.any(String) } })
    })

    it('converges concurrent identical calls and rejects concurrent payload reuse', async () => {
        const identical = makeHarness()
        const sameInput = { operationKey: 'concurrent-same', dataUrl: dataUrl('image/png', PNG_BYTES) }
        const sameResults = await Promise.all([
            identical.api.putImage(sameInput),
            identical.api.putImage(sameInput),
        ])
        expect(sameResults[0]).toEqual(sameResults[1])
        expect(identical.assets.size).toBe(1)

        const conflicting = makeHarness()
        const differentResults = await Promise.all([
            conflicting.api.putImage({ operationKey: 'concurrent-different', dataUrl: dataUrl('image/png', PNG_BYTES) }),
            conflicting.api.putImage({ operationKey: 'concurrent-different', dataUrl: dataUrl('image/jpeg', largeJpegBytes()) }),
        ])
        expect(differentResults.filter(result => result.status === 'succeeded')).toHaveLength(1)
        expect(differentResults.filter(result => result.status === 'precondition_failed')).toEqual([
            expect.objectContaining({ code: 'inlay_operation_key_reused' }),
        ])
    })

    it('decodes percent-encoded image octets without UTF-8 reinterpretation', async () => {
        const harness = makeHarness()
        const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x80, 0xff])
        const result = await harness.api.putImage({
            operationKey: 'percent-octets',
            dataUrl: 'data:image/png,%89PNG%00%80%FF',
        })
        expect(result.status).toBe('succeeded')
        if (result.status !== 'succeeded') throw new Error('unreachable')
        expect(harness.assets.get(result.result.assetId)?.bytes).toEqual(bytes)
    })

    it.each([
        ['not a data URL', 'https://example.invalid/image.png'],
        ['not an image', 'data:text/plain;base64,SGVsbG8='],
        ['unsupported image format', 'data:image/avif;base64,AAAA'],
        ['invalid base64', 'data:image/png;base64,%%%'],
        ['empty image', 'data:image/png;base64,'],
        ['broken percent encoding', 'data:image/png,%8'],
    ])('returns definite_failure for %s without a receipt or partial asset', async (_label, malformed) => {
        const harness = makeHarness()
        const result = await harness.api.putImage({ operationKey: 'malformed', dataUrl: malformed })

        expect(result).toMatchObject({ status: 'definite_failure', code: expect.any(String) })
        expect(harness.atomicCalls).toEqual({ reads: 0, writes: 0 })
        expect(harness.assets.size).toBe(0)
        expect(harness.infos.size).toBe(0)
    })

    it('fails closed before storage when plugin identity is unavailable', async () => {
        const harness = makeHarness({ installId: 'not-an-install-id' })
        const result = await harness.api.putImage({
            operationKey: 'no-identity',
            dataUrl: dataUrl('image/png', PNG_BYTES),
        })

        expect(result).toMatchObject({ status: 'precondition_failed', code: 'inlay_install_id_unavailable' })
        expect(harness.atomicCalls).toEqual({ reads: 0, writes: 0 })
        expect(harness.writes).toHaveLength(0)
    })

    it('reports atomic transport uncertainty without touching inlay storage', async () => {
        const harness = makeHarness({
            atomicReadFailure: { code: 'PLUGIN_ATOMIC_UNKNOWN', message: 'storage transport unavailable' },
        })
        const result = await harness.api.putImage({
            operationKey: 'atomic-uncertain',
            dataUrl: dataUrl('image/png', PNG_BYTES),
        })

        expect(result).toMatchObject({ status: 'ambiguous', code: 'inlay_receipt_state_uncertain' })
        expect(harness.writes).toHaveLength(0)
    })

    it('reports deterministic atomic validation failures as definite', async () => {
        const harness = makeHarness({
            atomicReadFailure: { code: 'PLUGIN_ATOMIC_BAD_KEY', message: 'claim key is invalid' },
        })
        const result = await harness.api.putImage({
            operationKey: 'atomic-bad-key',
            dataUrl: dataUrl('image/png', PNG_BYTES),
        })

        expect(result).toEqual({
            status: 'definite_failure',
            code: 'PLUGIN_ATOMIC_BAD_KEY',
            error: 'claim key is invalid',
        })
        expect(harness.writes).toHaveLength(0)
    })
})
