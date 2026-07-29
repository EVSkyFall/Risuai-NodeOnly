import { describe, expect, it } from 'vitest'
import { createPluginInlayMediaApi } from '../pluginInlayMedia'

describe('plugin inlay media read', () => {
  it('returns a video Blob without changing the image-only V1 read contract', async () => {
    const video = new Blob([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])], {
      type: 'video/mp4',
    })
    const api = createPluginInlayMediaApi({
      readInlay: async assetId => ({
        data: video,
        ext: 'mp4',
        name: `${assetId}.mp4`,
        type: 'video',
      }),
    })

    const result = await api.readMedia({ assetId: 'comfy-job-1' })
    expect(result).toMatchObject({
      status: 'succeeded',
      result: {
        assetId: 'comfy-job-1',
        data: video,
        mediaType: 'video',
        mimeType: 'video/mp4',
        ext: 'mp4',
        name: 'comfy-job-1.mp4',
      },
    })
    if (result.status === 'succeeded') {
      expect(await result.result.data.arrayBuffer()).toEqual(await video.arrayBuffer())
    }
  })

  it('rejects non-visual inlays with a typed local failure', async () => {
    const api = createPluginInlayMediaApi({
      readInlay: async () => ({
        data: new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }),
        ext: 'mp3',
        name: 'voice.mp3',
        type: 'audio',
      }),
    })
    await expect(api.readMedia({ assetId: 'voice' })).resolves.toEqual({
      status: 'definite_failure',
      error: 'the inlay is audio, not image or video media',
      code: 'inlay_media_unsupported',
    })
  })
})
