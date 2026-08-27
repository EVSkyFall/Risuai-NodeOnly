// @vitest-environment node

import { describe, expect, it } from 'vitest'
import pkg from './timeline.cjs'

const {
  assembleTimelineDocument,
  collectTimelineAssets,
  isTimelineAssetKey,
  resolveTimelineSpec,
  timelineAssetKey,
  validateTimelineSpec,
} = pkg as any

function spec(items: any[]) {
  return { items }
}

describe('timeline spec validation', () => {
  it('accepts the full item vocabulary the Director understands', () => {
    expect(() => validateTimelineSpec(spec([
      { slot: 0, type: 'image', assetId: 'plugin-inlay-anchor' },
      { slot: 8, type: 'image', assetId: 'plugin-inlay-ref', start: 2, duration: 3 },
      {
        slot: 2,
        type: 'video',
        assetId: 'comfy-reel',
        trim_start: 1,
        trim_end: 4,
        source_duration: 9,
        media_mode: 'video_audio',
      },
      { slot: 1, type: 'audio', assetId: 'plugin-inlay-voice', trim_end: 2 },
    ]))).not.toThrow()
  })

  it.each([
    ['a missing items array', {}],
    ['an empty timeline', spec([])],
    ['an unknown top-level field', { items: [{ slot: 0, type: 'image', assetId: 'a' }], version: 1 }],
    ['an unknown item field', spec([{ slot: 0, type: 'image', assetId: 'a', waveform_peaks: [] }])],
    ['an unsupported media type', spec([{ slot: 0, type: 'text', assetId: 'a' }])],
    ['a traversing asset id', spec([{ slot: 0, type: 'image', assetId: '../escape' }])],
    ['a non-integer slot', spec([{ slot: 0.5, type: 'image', assetId: 'a' }])],
    ['a duplicated (type, slot) pair', spec([
      { slot: 1, type: 'image', assetId: 'a' },
      { slot: 1, type: 'image', assetId: 'b' },
    ])],
    ['a negative start', spec([{ slot: 0, type: 'image', assetId: 'a', start: -1 }])],
    ['a zero duration', spec([{ slot: 0, type: 'image', assetId: 'a', duration: 0 }])],
    ['a trim_end at trim_start', spec([{ slot: 0, type: 'video', assetId: 'a', trim_start: 2, trim_end: 2 }])],
    ['media_mode on a non-video item', spec([{ slot: 0, type: 'image', assetId: 'a', media_mode: 'video_audio' }])],
    ['an unsupported media_mode', spec([{ slot: 0, type: 'video', assetId: 'a', media_mode: 'audio_only' }])],
    ['one asset id claimed as two media kinds', spec([
      { slot: 0, type: 'image', assetId: 'same' },
      { slot: 0, type: 'video', assetId: 'same' },
    ])],
  ])('rejects %s as COMFY_SLOT_INVALID', (_label, value) => {
    expect(() => validateTimelineSpec(value)).toThrowError(expect.objectContaining({
      code: 'COMFY_SLOT_INVALID',
    }))
  })

  it.each([
    ['an image slot above 8', spec([{ slot: 9, type: 'image', assetId: 'a' }])],
    ['a video slot above 2', spec([{ slot: 3, type: 'video', assetId: 'a' }])],
    ['an audio slot above 2', spec([{ slot: 3, type: 'audio', assetId: 'a' }])],
    ['more than 12 items overall', spec(Array.from({ length: 13 }, (_value, index) => ({
      slot: index % 9,
      type: 'image',
      assetId: `a${index}`,
    })))],
  ])('rejects %s as a workflow contract breach', (_label, value) => {
    expect(() => validateTimelineSpec(value)).toThrowError(expect.objectContaining({
      code: 'COMFY_SLOT_TIMELINE_LIMIT',
    }))
  })

  it('fills every image slot the contract offers without complaint', () => {
    expect(() => validateTimelineSpec(spec(Array.from({ length: 9 }, (_value, slot) => ({
      slot,
      type: 'image',
      assetId: `image-${slot}`,
    }))))).not.toThrow()
  })
})

describe('timeline asset resolution', () => {
  it('uploads each asset id once even when several slots reference it', () => {
    expect(collectTimelineAssets(spec([
      { slot: 0, type: 'image', assetId: 'shared' },
      { slot: 1, type: 'image', assetId: 'shared' },
      { slot: 2, type: 'image', assetId: 'other' },
    ]))).toEqual([
      { assetId: 'shared', type: 'image' },
      { assetId: 'other', type: 'image' },
    ])
  })

  it('keys timeline assets where no slot name can reach', () => {
    expect(timelineAssetKey('plugin-inlay-a')).toBe('timeline#plugin-inlay-a')
    expect(isTimelineAssetKey('timeline#plugin-inlay-a')).toBe(true)
    expect(isTimelineAssetKey('input_image')).toBe(false)
    expect(isTimelineAssetKey('timeline')).toBe(false)
  })

  it('attaches uploaded names and image dimensions from the pinned snapshot', () => {
    const resolved = resolveTimelineSpec(
      spec([
        { slot: 0, type: 'image', assetId: 'still' },
        { slot: 0, type: 'audio', assetId: 'voice' },
      ]),
      {
        'timeline#still': { assetId: 'still', hash: 'A', type: 'image', width: 768, height: 1120 },
        'timeline#voice': { assetId: 'voice', hash: 'B', type: 'audio' },
      },
      {
        'timeline#still': 'risu-comfy/uploaded-still.png',
        'timeline#voice': 'risu-comfy/uploaded-voice.mp3',
      },
    )
    expect(resolved.items).toEqual([
      {
        slot: 0,
        type: 'image',
        assetId: 'still',
        value: 'risu-comfy/uploaded-still.png',
        source_width: 768,
        source_height: 1120,
      },
      { slot: 0, type: 'audio', assetId: 'voice', value: 'risu-comfy/uploaded-voice.mp3' },
    ])
  })

  it('refuses to assemble an item that was never uploaded', () => {
    expect(() => resolveTimelineSpec(
      spec([{ slot: 0, type: 'image', assetId: 'still' }]),
      {},
      {},
    )).toThrowError(expect.objectContaining({ code: 'COMFY_SLOT_INVALID' }))
  })
})

describe('timeline document assembly', () => {
  // Byte-exact wire fixture. The live probe may still say the Director wants a
  // field we omit; this pin is what makes that a one-line change.
  it('emits the pinned wire document', () => {
    const document = assembleTimelineDocument(spec([
      {
        slot: 0,
        type: 'image',
        assetId: 'plugin-inlay-anchor',
        value: 'risu-comfy/risu-job-AAAA.png',
        source_width: 768,
        source_height: 1120,
      },
      {
        slot: 1,
        type: 'image',
        assetId: 'plugin-inlay-ref',
        value: 'risu-comfy/risu-job-BBBB.png',
        start: 4,
        duration: 2,
      },
      {
        slot: 0,
        type: 'video',
        assetId: 'comfy-reel',
        value: 'risu-comfy/risu-job-CCCC.mp4',
        trim_start: 1.5,
        trim_end: 4,
        source_duration: 9,
        media_mode: 'video_audio',
      },
      {
        slot: 0,
        type: 'audio',
        assetId: 'plugin-inlay-voice',
        value: 'risu-comfy/risu-job-DDDD.mp3',
        source_duration: 6.25,
      },
    ]))

    expect(document).toBe(
      '{"version":1,"items":['
      + '{"id":"risu-image-0","enabled":true,"order":0,"slot":0,"start":0,"duration":1,'
      + '"type":"image","value":"risu-comfy/risu-job-AAAA.png","thumbnail":null,'
      + '"source_width":768,"source_height":1120},'
      + '{"id":"risu-image-1","enabled":true,"order":1,"slot":1,"start":4,"duration":2,'
      + '"type":"image","value":"risu-comfy/risu-job-BBBB.png","thumbnail":null},'
      + '{"id":"risu-video-0","enabled":true,"order":2,"slot":0,"start":0,"duration":2.5,'
      + '"type":"video","value":"risu-comfy/risu-job-CCCC.mp4","thumbnail":null,'
      + '"trim_start":1.5,"trim_end":4,"source_duration":9,"media_mode":"video_audio"},'
      + '{"id":"risu-audio-0","enabled":true,"order":3,"slot":0,"start":0,"duration":6.25,'
      + '"type":"audio","value":"risu-comfy/risu-job-DDDD.mp3","thumbnail":null,'
      + '"source_duration":6.25}'
      + ']}',
    )
  })

  it('defaults start to the slot index and duration per media kind', () => {
    const parsed = JSON.parse(assembleTimelineDocument(spec([
      { slot: 2, type: 'image', assetId: 'a', value: 'a.png' },
      { slot: 1, type: 'video', assetId: 'b', value: 'b.mp4' },
    ])))
    expect(parsed.items.map((item: any) => [item.start, item.duration])).toEqual([[2, 1], [1, 1]])
  })
})
