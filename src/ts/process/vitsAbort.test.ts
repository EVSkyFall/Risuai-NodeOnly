import { afterEach, expect, test, vi } from 'vitest'
const h = vi.hoisted(() => ({ synth: vi.fn() }))
vi.mock('@huggingface/transformers', () => ({ env: {}, pipeline: async () => h.synth }))
vi.mock('wavefile', () => ({ WaveFile: class { fromScratch() {} toBuffer() { return new Uint8Array() } } }))
vi.mock('src/ts/globalApi.svelte', () => ({ loadAsset: vi.fn(), saveAsset: vi.fn() }))
vi.mock('src/ts/util', () => ({ selectSingleFile: vi.fn(), asBuffer: (v: any) => v }))
import { runVITS } from './transformers'
afterEach(() => vi.unstubAllGlobals())
test.each(['synthesis', 'decode', 'none'])('VITS Stop during %s discards playback', async phase => {
    const controller = new AbortController()
    const play = vi.fn()
    let decode!: (v: any) => void
    let finish!: (v: any) => void
    let entered!: () => void
    const started = new Promise<void>(r => { entered = r })
    h.synth.mockImplementation(() => { entered(); return new Promise(r => { finish = r }) })
    vi.stubGlobal('caches', { open: async () => ({}) })
    vi.stubGlobal('AudioContext', class {
        destination = {}
        decodeAudioData(_data: any, cb: any) { decode = cb }
        createBufferSource() { return { connect: vi.fn(), start: play } }
    })
    const pending = runVITS('hello', 'test-model', controller.signal)
    await started
    if (phase === 'synthesis') controller.abort()
    finish({ sampling_rate: 16000, audio: new Float32Array() })
    await pending
    if (phase === 'decode') controller.abort()
    decode?.({})
    expect(play).toHaveBeenCalledTimes(phase === 'none' ? 1 : 0)
})
