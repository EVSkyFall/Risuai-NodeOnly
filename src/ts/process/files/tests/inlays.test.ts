import fc from 'fast-check'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { InlayAsset } from '../inlays'
import {
    getInlayAsset,
    getInlayAssetBlob,
    getCharacterChatIndex,
    getInlayInfosBatch,
    getInlayMeta,
    inspectInlayAssetIntegrity,
    listInlayAssets,
    listInlayExplorerItems,
    postInlayAsset,
    repairInlayAssetRecords,
    removeInlayAsset,
    setInlayAsset,
    writeInlayImage,
    __resetInlayStorageForTest,
} from '../inlays'

//#region module mocks

// happy-dom canvas getContext returns null
const fakeCtx = {
    drawImage: vi.fn(),
}
const canvasMockState: {
    blob: Blob | null
    context: typeof fakeCtx | null
} = {
    blob: new Blob(['fake-image'], { type: 'image/png' }),
    context: fakeCtx,
}
const origCreateElement = document.createElement.bind(document)
vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: any) => {
    const el = origCreateElement(tag, options)
    if (tag === 'canvas') {
        ;(el as HTMLCanvasElement).getContext = (() => canvasMockState.context) as any
        ;(el as HTMLCanvasElement).toBlob = ((cb: BlobCallback, type?: string) => {
            cb(canvasMockState.blob && new Blob([canvasMockState.blob], { type: type || 'image/png' }))
        }) as any
    }
    return el
})

const { nodeStorageMap } = vi.hoisted(() => ({
    nodeStorageMap: new Map<string, Uint8Array>(),
}))

vi.mock('src/ts/storage/nodeStorage', () => {
    class MockNodeStorage {
        authChecked = true
        async setItem(key: string, value: Uint8Array) {
            nodeStorageMap.set(key, value)
        }
        async getItem(key: string) {
            return nodeStorageMap.get(key) ?? null
        }
        async removeItem(key: string) {
            nodeStorageMap.delete(key)
        }
        async keys(prefix = '') {
            const ks = [...nodeStorageMap.keys()]
            return prefix ? ks.filter(k => k.startsWith(prefix)) : ks
        }
        async getItems(keys: string[]) {
            return keys
                .filter((key) => nodeStorageMap.has(key))
                .map((key) => ({ key, value: Buffer.from(nodeStorageMap.get(key)!) }))
        }
        async setItems(entries: {key: string, value: Uint8Array}[]) {
            for (const entry of entries) {
                nodeStorageMap.set(entry.key, entry.value)
            }
        }
        listItem = this.keys
    }
    return { NodeStorage: MockNodeStorage }
})

vi.mock('uuid', () => ({
    v4: vi.fn(() => 'test-uuid-1234'),
}))

const { getCurrentCharacterMock, getDatabaseMock } = vi.hoisted(() => ({
    getCurrentCharacterMock: vi.fn<() => any>(() => null),
    getDatabaseMock: vi.fn<() => any>(() => ({ characters: [] })),
}))

vi.mock(import('src/ts/storage/database.svelte'), () => ({
    getDatabase: getDatabaseMock,
    getCurrentCharacter: getCurrentCharacterMock,
    getCurrentChat: vi.fn(() => null),
}))

vi.mock(
    import('src/ts/util'),
    () =>
        ({
            asBuffer: (arr: Uint8Array) => arr,
            // modules.ts (pulled in via the stores $effect) imports this from util
            checkPersonaBinded: () => null,
        }) as typeof import('src/ts/util'),
)

//#endregion

const supportedAudioExts = ['wav', 'mp3', 'ogg', 'flac'] as const
const supportedVideoExts = ['webm', 'mp4', 'mkv'] as const
const supportedImageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'] as const
const allSupportedExts = [...supportedAudioExts, ...supportedVideoExts, ...supportedImageExts]

function makeImage(w: number, h: number): HTMLImageElement {
    const img = new Image()
    Object.defineProperty(img, 'width', { get: () => w })
    Object.defineProperty(img, 'height', { get: () => h })
    Object.defineProperty(img, 'naturalWidth', { get: () => w })
    Object.defineProperty(img, 'naturalHeight', { get: () => h })
    Object.defineProperty(img, 'complete', { get: () => true })
    return img
}

function makePendingImage(w = 1, h = 1): HTMLImageElement {
    const img = new Image()
    Object.defineProperty(img, 'width', { get: () => w })
    Object.defineProperty(img, 'height', { get: () => h })
    Object.defineProperty(img, 'naturalWidth', { get: () => 0 })
    Object.defineProperty(img, 'naturalHeight', { get: () => 0 })
    Object.defineProperty(img, 'complete', { get: () => false })
    return img
}

beforeEach(() => {
    vi.clearAllMocks()
    nodeStorageMap.clear()
    canvasMockState.blob = new Blob(['fake-image'], { type: 'image/png' })
    canvasMockState.context = fakeCtx
    getCurrentCharacterMock.mockReturnValue(null)
    getDatabaseMock.mockReturnValue({ characters: [] })
    __resetInlayStorageForTest()
})

describe('setInlayAsset', () => {
    test('stores an asset in the storage', async () => {
        const asset: InlayAsset = {
            data: new Blob(['hello'], { type: 'text/plain' }),
            ext: 'png',
            height: 100,
            width: 100,
            name: 'test.png',
            type: 'image',
        }

        await setInlayAsset('asset-1', asset)

        const stored = await getInlayAsset('asset-1')
        expect(stored).toMatchObject({ ext: 'png', name: 'test.png', type: 'image', height: 100, width: 100 })
        expect(typeof stored!.data).toBe('string')
    })

    test('overwrites an existing asset with the same id', async () => {
        const first: InlayAsset = {
            data: new Blob(['a']),
            ext: 'png',
            height: 10,
            name: 'first.png',
            type: 'image',
            width: 10,
        }
        const second: InlayAsset = {
            data: new Blob(['b']),
            ext: 'png',
            height: 20,
            name: 'second.png',
            type: 'image',
            width: 20,
        }

        await setInlayAsset('id-1', first)
        await setInlayAsset('id-1', second)

        const stored = await getInlayAsset('id-1')
        expect(stored).toMatchObject({
            height: 20,
            name: 'second.png',
            type: 'image',
            width: 20,
        })
    })
})

describe('getInlayAsset', () => {
    test('returns null for a non-existent id', async () => {
        const result = await getInlayAsset('does-not-exist')
        expect(result).toBeNull()
    })

    test('returns asset with base64 data URI when stored as Blob', async () => {
        const blob = new Blob(['test-data'], { type: 'text/plain' })
        const asset: InlayAsset = {
            data: blob,
            ext: 'png',
            height: 50,
            width: 50,
            name: 'blob-asset.png',
            type: 'image',
        }
        await setInlayAsset('blob-id', asset)

        const result = await getInlayAsset('blob-id')

        expect(result!.data).toMatch(/^data:/)
        expect(result!.name).toBe('blob-asset.png')
    })

    test('returns asset with string data as-is when stored as string', async () => {
        const b64 = 'data:image/png;base64,aGVsbG8='
        const asset: InlayAsset = {
            data: b64,
            ext: 'png',
            height: 50,
            width: 50,
            name: 'string-asset.png',
            type: 'image',
        }
        await setInlayAsset('str-id', asset)

        const result = await getInlayAsset('str-id')
        expect(result!.data).toBe(b64)
    })
})

describe('getInlayAssetBlob', () => {
    test('returns null for a non-existent id', async () => {
        const result = await getInlayAssetBlob('does-not-exist')
        expect(result).toBeNull()
    })

    test('returns Blob data when stored as Blob', async () => {
        const blob = new Blob(['binary-data'], { type: 'image/png' })
        const asset: InlayAsset = {
            data: blob,
            ext: 'png',
            height: 64,
            width: 64,
            name: 'blob.png',
            type: 'image',
        }
        await setInlayAsset('blob-id', asset)

        const result = await getInlayAssetBlob('blob-id')
        expect(result!.data).toBeInstanceOf(Blob)
    })

    test('migrates string data to Blob', async () => {
        const b64 = 'data:image/png;base64,aGVsbG8='
        const asset: InlayAsset = {
            data: b64,
            ext: 'png',
            height: 32,
            width: 32,
            name: 'legacy.png',
            type: 'image',
        }
        await setInlayAsset('legacy-id', asset)

        const result = await getInlayAssetBlob('legacy-id')
        expect(result!.data).toBeInstanceOf(Blob)

        // After migration, subsequent blob fetch also returns Blob
        const result2 = await getInlayAssetBlob('legacy-id')
        expect(result2!.data).toBeInstanceOf(Blob)
    })
})

describe('listInlayAssets', () => {
    test('returns empty array when no assets exist', async () => {
        const result = await listInlayAssets()
        expect(result).toEqual([])
    })

    test('returns all stored assets as [id, asset] tuples', async () => {
        const asset1: InlayAsset = {
            data: new Blob(['a']),
            ext: 'png',
            height: 10,
            width: 10,
            name: 'a.png',
            type: 'image',
        }
        const asset2: InlayAsset = {
            data: new Blob(['b']),
            ext: 'mp3',
            height: 0,
            width: 0,
            name: 'b.mp3',
            type: 'audio',
        }
        await setInlayAsset('id-a', asset1)
        await setInlayAsset('id-b', asset2)

        const result = await listInlayAssets()
        expect(result).toMatchObject([
            ['id-a', { name: 'a.png' }],
            ['id-b', { name: 'b.mp3' }],
        ])
    })
})

describe('getCharacterChatIndex', () => {
    test('returns lightweight character/chat index with valid ids only', () => {
        getDatabaseMock.mockReturnValue({
            characters: [
                {
                    chaId: 'char-1',
                    chats: [
                        { id: 'chat-1', name: 'First Chat' },
                        { id: 'chat-2', name: '' },
                        { name: 'Missing Id Chat' },
                    ],
                    name: 'Alice',
                },
                {
                    chaId: 'char-2',
                    chats: [{ id: 'chat-3', name: 'Third Chat' }],
                    name: '',
                },
                {
                    chats: [{ id: 'chat-4', name: 'Should Skip' }],
                    name: 'No Id',
                },
            ],
        })

        expect(getCharacterChatIndex()).toEqual([
            {
                chaId: 'char-1',
                chats: [
                    { id: 'chat-1', name: 'First Chat' },
                    { id: 'chat-2', name: 'chat-2' },
                ],
                name: 'Alice',
            },
            {
                chaId: 'char-2',
                chats: [{ id: 'chat-3', name: 'Third Chat' }],
                name: 'char-2',
            },
        ])
    })
})

describe('listInlayExplorerItems', () => {
    test('returns lightweight explorer items without loading full asset body', async () => {
        nodeStorageMap.set('inlay_meta/img-1', new TextEncoder().encode(JSON.stringify({
            charId: 'char-1',
            chatId: 'chat-1',
            createdAt: 10,
            updatedAt: 20,
        })))

        await setInlayAsset('img-1', {
            data: new Blob(['img-data'], { type: 'image/png' }),
            ext: 'png',
            height: 128,
            name: 'thumb-image.png',
            type: 'image',
            width: 256,
        })

        const infoOnlyValue = new TextEncoder().encode(JSON.stringify({
            ext: 'mp3',
            name: 'audio-file.mp3',
            type: 'audio',
        }))
        nodeStorageMap.set('inlay/audio-1', new TextEncoder().encode(JSON.stringify({
            data: 'data:audio/mp3;base64,YQ==',
            ext: 'mp3',
            name: 'audio-file.mp3',
            type: 'audio',
        })))
        nodeStorageMap.set('inlay_info/audio-1', infoOnlyValue)

        const result = await listInlayExplorerItems()
        const byId = Object.fromEntries(result.map((item) => [item.id, item]))

        expect(byId['img-1']).toMatchObject({
            ext: 'png',
            hasMeta: true,
            name: 'thumb-image.png',
            type: 'image',
        })

        expect(byId['audio-1']).toMatchObject({
            ext: 'mp3',
            hasMeta: false,
            name: 'audio-file.mp3',
            type: 'audio',
        })
    })
})

describe('removeInlayAsset', () => {
    test('does not throw when removing a non-existent id', async () => {
        await expect(removeInlayAsset('nope')).resolves.not.toThrow()
    })
})

describe('postInlayAsset', () => {
    test('returns null when an uploaded image cannot be decoded', async () => {
        canvasMockState.context = null

        await expect(postInlayAsset({
            name: 'broken.png',
            data: new Uint8Array([0x00]),
        })).resolves.toBeNull()
    })

    test('stores audio asset and returns id', async () => {
        const data = new Uint8Array([0xff, 0xfb, 0x90, 0x00])
        const result = await postInlayAsset({
            name: 'clip.mp3',
            data,
        })
        expect(result).toBe('test-uuid-1234')

        const stored = await getInlayAssetBlob('test-uuid-1234')
        expect(stored).toMatchObject({
            data: expect.any(Blob),
            ext: 'mp3',
            name: 'clip.mp3',
            type: 'audio',
        })
    })

    test('stores video asset and returns id', async () => {
        const data = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])
        const result = await postInlayAsset({
            name: 'video.webm',
            data,
        })
        expect(result).toBe('test-uuid-1234')

        const stored = await getInlayAssetBlob('test-uuid-1234')
        expect(stored).toMatchObject({
            data: expect.any(Blob),
            ext: 'webm',
            name: 'video.webm',
            type: 'video',
        })
    })

    test('returns null for any unsupported extension', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 10 }).filter((ext) => !allSupportedExts.includes(ext as any)),
                async (ext) => {
                    nodeStorageMap.clear()
                    __resetInlayStorageForTest()
                    const result = await postInlayAsset({
                        name: `file.${ext}`,
                        data: new Uint8Array([0x00]),
                    })
                    expect(result).toBeNull()
                },
            ),
        )
    })

    test('routes audio extensions to audio type', async () => {
        await fc.assert(
            fc.asyncProperty(fc.constantFrom(...supportedAudioExts), async (ext) => {
                nodeStorageMap.clear()
                __resetInlayStorageForTest()
                const result = await postInlayAsset({
                    name: `sound.${ext}`,
                    data: new Uint8Array([0x00]),
                })
                expect(result).not.toBeNull()
                const stored = await getInlayAssetBlob(result!)
                expect(stored!.type).toBe('audio')
                expect(stored!.ext).toBe(ext)
            }),
        )
    })

    test('routes video extensions to video type', async () => {
        await fc.assert(
            fc.asyncProperty(fc.constantFrom(...supportedVideoExts), async (ext) => {
                nodeStorageMap.clear()
                __resetInlayStorageForTest()
                const result = await postInlayAsset({
                    name: `clip.${ext}`,
                    data: new Uint8Array([0x00]),
                })
                expect(result).not.toBeNull()
                const stored = await getInlayAssetBlob(result!)
                expect(stored!.type).toBe('video')
                expect(stored!.ext).toBe(ext)
            }),
        )
    })
})

describe('writeInlayImage', () => {
    test('rejects with a typed error when image loading fails and clears its timer', async () => {
        vi.useFakeTimers()
        try {
            const imgObj = makePendingImage()
            const result = writeInlayImage(imgObj, { decodeTimeoutMs: 60_000 })
            const rejection = expect(result).rejects.toMatchObject({
                code: 'INLAY_IMAGE_LOAD_ERROR',
                name: 'InlayImageWriteError',
            })

            imgObj.dispatchEvent(new Event('error'))

            await rejection
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })

    test('rejects with a typed error after the decode timeout without leaving a timer', async () => {
        vi.useFakeTimers()
        try {
            const result = writeInlayImage(makePendingImage(), { decodeTimeoutMs: 250 })
            const rejection = expect(result).rejects.toMatchObject({
                code: 'INLAY_IMAGE_DECODE_TIMEOUT',
                name: 'InlayImageWriteError',
            })

            await vi.advanceTimersByTimeAsync(250)

            await rejection
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })

    test('rejects with a typed error when a completed image failed to load', async () => {
        await expect(writeInlayImage(makeImage(0, 0))).rejects.toMatchObject({
            code: 'INLAY_IMAGE_LOAD_ERROR',
            name: 'InlayImageWriteError',
        })
    })

    test('rejects with a typed error when no canvas context is available', async () => {
        canvasMockState.context = null

        await expect(writeInlayImage(makeImage(10, 10))).rejects.toMatchObject({
            code: 'INLAY_CANVAS_CONTEXT_UNAVAILABLE',
            name: 'InlayImageWriteError',
        })
    })

    test('rejects with a typed error when canvas encoding returns null', async () => {
        canvasMockState.blob = null

        await expect(writeInlayImage(makeImage(10, 10))).rejects.toMatchObject({
            code: 'INLAY_CANVAS_ENCODE_FAILED',
            name: 'InlayImageWriteError',
        })
    })

    test('handles an image that completed before handlers were attached', async () => {
        const result = await writeInlayImage(makeImage(80, 40), { id: 'already-loaded' })

        expect(result).toBe('already-loaded')
        expect(await getInlayAssetBlob('already-loaded')).toMatchObject({
            height: 40,
            width: 80,
        })
    })

    test('uses an explicit target and preserves active-chat inference when target is absent', async () => {
        getCurrentCharacterMock.mockReturnValue({
            chaId: 'active-char',
            chatPage: 0,
            chats: [{ id: 'active-chat' }],
        })

        await writeInlayImage(makeImage(20, 10), {
            id: 'explicit-target',
            target: { charId: 'original-char', chatId: 'original-chat' },
        })
        await writeInlayImage(makeImage(20, 10), {
            id: 'explicit-target',
            target: { charId: 'final-char', chatId: 'final-chat' },
        })
        await writeInlayImage(makeImage(20, 10), { id: 'implicit-target' })

        expect(await getInlayMeta('explicit-target')).toMatchObject({
            charId: 'final-char',
            chatId: 'final-chat',
        })
        expect(await getInlayMeta('implicit-target')).toMatchObject({
            charId: 'active-char',
            chatId: 'active-chat',
        })
    })

    test('stores image asset with correct metadata and returns id', async () => {
        const imgObj = makeImage(200, 100)

        const result = await writeInlayImage(imgObj, {
            name: 'photo.jpg',
            ext: 'jpg',
            id: 'custom-id',
        })

        expect(result).toBe('custom-id')

        const stored = await getInlayAssetBlob('custom-id')
        expect(stored).toMatchObject({
            data: expect.any(Blob),
            ext: 'webp',
            height: 100,
            name: 'photo.jpg',
            type: 'image',
            width: 200,
        })
    })

    test('stores image as lossless PNG when inlayImageLossless is true', async () => {
        getDatabaseMock.mockReturnValue({ characters: [], inlayImageLossless: true })
        const imgObj = makeImage(200, 100)

        const result = await writeInlayImage(imgObj, {
            name: 'photo.jpg',
            ext: 'jpg',
            id: 'lossless-id',
        })

        expect(result).toBe('lossless-id')

        const stored = await getInlayAssetBlob('lossless-id')
        expect(stored).toMatchObject({
            data: expect.any(Blob),
            ext: 'png',
            height: 100,
            name: 'photo.jpg',
            type: 'image',
            width: 200,
        })
    })

    test('generates uuid when no id is provided', async () => {
        const imgObj = makeImage(50, 50)

        const result = await writeInlayImage(imgObj)
        expect(result).toBe('test-uuid-1234')

        const stored = await getInlayAssetBlob('test-uuid-1234')
        expect(stored).toMatchObject({
            ext: 'webp',
            height: 50,
            name: 'test-uuid-1234',
            type: 'image',
            width: 50,
        })
        expect(nodeStorageMap.has('inlay/test-uuid-1234')).toBe(true)
        expect(nodeStorageMap.has('inlay_info/test-uuid-1234')).toBe(true)
        expect(nodeStorageMap.has('inlay_meta/test-uuid-1234')).toBe(true)
    })

    test('output pixels never exceed 1024 * 1024', async () => {
        await fc.assert(
            fc.asyncProperty(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 1, max: 10000 }), async (w, h) => {
                nodeStorageMap.clear()
                __resetInlayStorageForTest()
                const img = makeImage(w, h)
                await writeInlayImage(img, { id: 'prop-img' })
                const stored = await getInlayAssetBlob('prop-img')

                expect(stored!.width! * stored!.height!).toBeLessThanOrEqual(1024 * 1024)
                expect(stored!.width!).toBeGreaterThan(0)
                expect(stored!.height!).toBeGreaterThan(0)
            }),
        )
    })

    test('preserves aspect ratio when downscaling', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1025, max: 10000 }),
                fc.integer({ min: 1025, max: 10000 }),
                async (w, h) => {
                    nodeStorageMap.clear()
                    __resetInlayStorageForTest()
                    const img = makeImage(w, h)
                    await writeInlayImage(img, { id: 'ratio-img' })
                    const stored = await getInlayAssetBlob('ratio-img')

                    const originalRatio = w / h
                    const storedRatio = stored!.width! / stored!.height!
                    expect(Math.abs(originalRatio - storedRatio) / originalRatio).toBeLessThan(0.01)
                },
            ),
        )
    })

    test('does not resize images within pixel budget', async () => {
        await fc.assert(
            fc.asyncProperty(fc.integer({ min: 1, max: 1024 }), fc.integer({ min: 1, max: 1024 }), async (w, h) => {
                nodeStorageMap.clear()
                __resetInlayStorageForTest()
                const img = makeImage(w, h)
                await writeInlayImage(img, { id: 'small-img' })

                const stored = await getInlayAssetBlob('small-img')
                expect(stored).toMatchObject({
                    height: h,
                    width: w,
                })
            }),
        )
    })
})

describe('inlay asset integrity', () => {
    const integrityAsset: InlayAsset = {
        data: new Blob(['integrity-data'], { type: 'image/png' }),
        ext: 'png',
        height: 64,
        name: 'integrity.png',
        type: 'image',
        width: 128,
    }

    test('classifies all usable records as complete', async () => {
        await setInlayAsset('complete-id', integrityAsset, {
            charId: 'char-complete',
            chatId: 'chat-complete',
        })

        await expect(inspectInlayAssetIntegrity('complete-id')).resolves.toEqual({
            hasAsset: true,
            hasInfo: true,
            hasMeta: true,
            status: 'complete',
        })
    })

    test('repairs missing info and meta from actual storage with the expected target', async () => {
        await setInlayAsset('repair-id', integrityAsset, {
            charId: 'old-char',
            chatId: 'old-chat',
        })
        nodeStorageMap.delete('inlay_info/repair-id')
        nodeStorageMap.delete('inlay_meta/repair-id')

        await expect(inspectInlayAssetIntegrity('repair-id')).resolves.toEqual({
            hasAsset: true,
            hasInfo: false,
            hasMeta: false,
            status: 'repairable',
        })

        await repairInlayAssetRecords(
            'repair-id',
            { charId: 'expected-char', chatId: 'expected-chat' },
            { name: 'repaired-name.png', ext: 'repaired-ext' },
        )

        await expect(inspectInlayAssetIntegrity('repair-id')).resolves.toEqual({
            hasAsset: true,
            hasInfo: true,
            hasMeta: true,
            status: 'complete',
        })
        expect((await getInlayInfosBatch(['repair-id']))['repair-id']).toMatchObject({
            ext: 'repaired-ext',
            height: 64,
            name: 'repaired-name.png',
            type: 'image',
            width: 128,
        })
        expect(await getInlayMeta('repair-id')).toMatchObject({
            charId: 'expected-char',
            chatId: 'expected-chat',
        })
    })

    test('classifies parseable but incomplete records as repairable', async () => {
        await setInlayAsset('partial-id', integrityAsset, {
            charId: 'old-char',
            chatId: 'old-chat',
        })
        nodeStorageMap.set('inlay_info/partial-id', new TextEncoder().encode('{}'))
        nodeStorageMap.set('inlay_meta/partial-id', new TextEncoder().encode('{}'))

        await expect(inspectInlayAssetIntegrity('partial-id')).resolves.toEqual({
            hasAsset: true,
            hasInfo: false,
            hasMeta: false,
            status: 'repairable',
        })

        await repairInlayAssetRecords('partial-id', {
            charId: 'expected-char',
            chatId: 'expected-chat',
        })

        await expect(inspectInlayAssetIntegrity('partial-id')).resolves.toMatchObject({
            hasAsset: true,
            hasInfo: true,
            hasMeta: true,
            status: 'complete',
        })
    })

    test('classifies a stored record with no asset payload as missing', async () => {
        await setInlayAsset('empty-data-id', integrityAsset, {
            charId: 'existing-char',
            chatId: 'existing-chat',
        })
        nodeStorageMap.set('inlay/empty-data-id', new TextEncoder().encode(JSON.stringify({
            data: '',
            ext: 'png',
            height: 64,
            name: 'empty.png',
            type: 'image',
            width: 128,
        })))

        await expect(inspectInlayAssetIntegrity('empty-data-id')).resolves.toEqual({
            hasAsset: false,
            hasInfo: true,
            hasMeta: true,
            status: 'missing',
        })
    })

    test('classifies a malformed media string as missing and refuses repair without mutation', async () => {
        await setInlayAsset('malformed-data-id', integrityAsset, {
            charId: 'existing-char',
            chatId: 'existing-chat',
        })
        nodeStorageMap.set('inlay/malformed-data-id', new TextEncoder().encode(JSON.stringify({
            data: 'garbage',
            ext: 'png',
            height: 64,
            name: 'malformed.png',
            type: 'image',
            width: 128,
        })))
        const recordsBeforeRepair = [...nodeStorageMap.entries()]

        await expect(inspectInlayAssetIntegrity('malformed-data-id')).resolves.toEqual({
            hasAsset: false,
            hasInfo: true,
            hasMeta: true,
            status: 'missing',
        })
        await expect(repairInlayAssetRecords('malformed-data-id', {
            charId: 'expected-char',
            chatId: 'expected-chat',
        })).rejects.toMatchObject({
            code: 'INLAY_ASSET_MISSING',
            name: 'InlayAssetIntegrityError',
        })

        expect([...nodeStorageMap.entries()]).toEqual(recordsBeforeRepair)
        await expect(getInlayAssetBlob('malformed-data-id')).rejects.toThrow()
    })

    test('treats an absent actual record as missing despite a stale LRU and refuses repair without mutation', async () => {
        await setInlayAsset('missing-id', integrityAsset, {
            charId: 'existing-char',
            chatId: 'existing-chat',
        })
        nodeStorageMap.delete('inlay/missing-id')
        const recordsBeforeRepair = [...nodeStorageMap.entries()]

        await expect(inspectInlayAssetIntegrity('missing-id')).resolves.toEqual({
            hasAsset: false,
            hasInfo: true,
            hasMeta: true,
            status: 'missing',
        })
        await expect(repairInlayAssetRecords('missing-id', {
            charId: 'expected-char',
            chatId: 'expected-chat',
        })).rejects.toMatchObject({
            code: 'INLAY_ASSET_MISSING',
            name: 'InlayAssetIntegrityError',
        })

        expect([...nodeStorageMap.entries()]).toEqual(recordsBeforeRepair)
        expect(await getInlayAssetBlob('missing-id')).toBeNull()
        expect(nodeStorageMap.has('inlay_info/missing-id')).toBe(true)
        expect(nodeStorageMap.has('inlay_meta/missing-id')).toBe(true)
    })
})

describe('set -> get round-trip', () => {
    test('preserves metadata through setInlayAsset -> getInlayAsset', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 20 }),
                fc.string({ minLength: 1, maxLength: 30 }),
                fc.string({ minLength: 1, maxLength: 5 }),
                fc.nat({ max: 5000 }),
                fc.nat({ max: 5000 }),
                async (id, name, ext, width, height) => {
                    nodeStorageMap.clear()
                    __resetInlayStorageForTest()
                    const blob = new Blob(['data'], { type: 'application/octet-stream' })
                    const asset: InlayAsset = {
                        data: blob,
                        ext,
                        height,
                        width,
                        name,
                        type: 'image',
                    }

                    await setInlayAsset(id, asset)

                    const result = await getInlayAsset(id)
                    expect(result).toMatchObject({
                        data: expect.any(String),
                        ext,
                        height,
                        width,
                        name,
                        type: 'image',
                    })
                },
            ),
        )
    })
})

describe('set -> remove -> get', () => {
    test('asset is always null after removal', async () => {
        await fc.assert(
            fc.asyncProperty(fc.string({ minLength: 1, maxLength: 20 }), async (id) => {
                nodeStorageMap.clear()
                __resetInlayStorageForTest()
                const asset: InlayAsset = {
                    data: new Blob(['x']),
                    ext: 'png',
                    height: 1,
                    width: 1,
                    name: 'tmp.png',
                    type: 'image',
                }

                await setInlayAsset(id, asset)
                expect(await getInlayAsset(id)).not.toBeNull()

                await removeInlayAsset(id)
                expect(await getInlayAsset(id)).toBeNull()
            }),
        )
    })
})
