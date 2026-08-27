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

  it('serves an audio inlay so ingested voice references can be read back', async () => {
    const voice = new Blob([new Uint8Array([0x49, 0x44, 0x33, 0x03])], { type: 'audio/mpeg' })
    const api = createPluginInlayMediaApi({
      readInlay: async () => ({
        data: voice,
        ext: 'mp3',
        name: 'voice.mp3',
        type: 'audio',
      }),
    })
    const result = await api.readMedia({ assetId: 'voice' })
    expect(result).toMatchObject({
      status: 'succeeded',
      result: { assetId: 'voice', mediaType: 'audio', mimeType: 'audio/mpeg', ext: 'mp3', name: 'voice.mp3' },
    })
    if (result.status === 'succeeded') {
      expect(await result.result.data.arrayBuffer()).toEqual(await voice.arrayBuffer())
    }
  })

  it('derives an audio MIME from the extension when storage lost the Blob type', async () => {
    const api = createPluginInlayMediaApi({
      readInlay: async () => ({
        data: new Blob([new Uint8Array([0x4f, 0x67, 0x67, 0x53])]),
        ext: 'ogg',
        name: 'ambience.ogg',
        type: 'audio',
      }),
    })
    await expect(api.readMedia({ assetId: 'ambience' })).resolves.toMatchObject({
      status: 'succeeded',
      result: { mediaType: 'audio', mimeType: 'audio/ogg' },
    })
  })

  it('rejects non-media inlays with a typed local failure', async () => {
    const api = createPluginInlayMediaApi({
      readInlay: async () => ({
        data: new Blob([new Uint8Array([1])], { type: 'application/json' }),
        ext: 'json',
        name: 'sig.json',
        type: 'signature',
      }),
    })
    await expect(api.readMedia({ assetId: 'sig' })).resolves.toEqual({
      status: 'definite_failure',
      error: 'the inlay is signature, not image, video, or audio media',
      code: 'inlay_media_unsupported',
    })
  })
})
