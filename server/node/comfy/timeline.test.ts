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
        slot: 9,
        type: 'video',
        assetId: 'comfy-reel',
        trim_start: 1,
        trim_end: 4,
        source_duration: 9,
        media_mode: 'video_audio',
        source_width: 1152,
        source_height: 784,
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
    ['a trim_end at trim_start', spec([{ slot: 9, type: 'video', assetId: 'a', trim_start: 2, trim_end: 2 }])],
    ['media_mode on a non-video item', spec([{ slot: 0, type: 'image', assetId: 'a', media_mode: 'video_audio' }])],
    ['an unsupported media_mode', spec([{ slot: 9, type: 'video', assetId: 'a', media_mode: 'audio_only' }])],
    ['one asset id claimed as two media kinds', spec([
      { slot: 0, type: 'image', assetId: 'same' },
      { slot: 9, type: 'video', assetId: 'same' },
    ])],
    ['a resolved value smuggled into a submitted spec', spec([
      { slot: 0, type: 'image', assetId: 'a', value: 'risu-comfy/somebody-elses.png' },
    ])],
    ['source dimensions on an audio item', spec([
      { slot: 0, type: 'audio', assetId: 'a', source_width: 1, source_height: 1 },
    ])],
    ['a submit-time createdAt', { items: [{ slot: 0, type: 'image', assetId: 'a' }], createdAt: 5 }],
  ])('rejects %s as COMFY_SLOT_INVALID', (_label, value) => {
    expect(() => validateTimelineSpec(value)).toThrowError(expect.objectContaining({
      code: 'COMFY_SLOT_INVALID',
    }))
  })

  it.each([
    ['an image slot above 8', spec([{ slot: 9, type: 'image', assetId: 'a' }])],
    ['a video slot below 9', spec([{ slot: 0, type: 'video', assetId: 'a' }])],
    ['a video slot above 11', spec([{ slot: 12, type: 'video', assetId: 'a' }])],
    ['an audio slot above 2', spec([{ slot: 3, type: 'audio', assetId: 'a' }])],
  ])('rejects %s as a workflow contract breach', (_label, value) => {
    expect(() => validateTimelineSpec(value)).toThrowError(expect.objectContaining({
      code: 'COMFY_SLOT_TIMELINE_LIMIT',
    }))
  })

  // The address space is the whole point of the slot: a video at slot 0 is the
  // mistake a builder makes exactly once, so the refusal has to name the range.
  it('names the valid range when an item lands on the wrong track', () => {
    expect(() => validateTimelineSpec(spec([{ slot: 0, type: 'video', assetId: 'a' }])))
      .toThrowError(/video range 9\.\.11/)
    expect(() => validateTimelineSpec(spec([{ slot: 9, type: 'image', assetId: 'a' }])))
      .toThrowError(/image range 0\.\.8/)
    expect(() => validateTimelineSpec(spec([{ slot: 3, type: 'audio', assetId: 'a' }])))
      .toThrowError(/audio range 0\.\.2/)
  })

  it('fills the shared visual track and the audio track to capacity', () => {
    const full = [
      ...Array.from({ length: 9 }, (_value, slot) => ({ slot, type: 'image', assetId: `image-${slot}` })),
      ...Array.from({ length: 3 }, (_value, index) => ({
        slot: 9 + index, type: 'video', assetId: `video-${index}`,
      })),
      ...Array.from({ length: 3 }, (_value, slot) => ({ slot, type: 'audio', assetId: `audio-${slot}` })),
    ]
    expect(full).toHaveLength(15)
    expect(() => validateTimelineSpec(spec(full))).not.toThrow()
  })

  // Visual and audio are separate address spaces: audio 0 does not collide
  // with image 0, and the visual track is one domain across image and video.
  it('keeps the audio track independent of the visual one', () => {
    expect(() => validateTimelineSpec(spec([
      { slot: 0, type: 'image', assetId: 'a' },
      { slot: 9, type: 'video', assetId: 'b' },
      { slot: 0, type: 'audio', assetId: 'c' },
    ]))).not.toThrow()
  })
})

describe('timeline asset resolution', () => {
  it('uploads each asset id once even when several slots reference it', () => {
    expect(collectTimelineAssets(spec([
      { slot: 0, type: 'image', assetId: 'shared' },
      { slot: 1, type: 'image', assetId: 'shared' },
      { slot: 2, type: 'image', assetId: 'other' },
    ]))).toEqual([
      { assetId: 'shared', type: 'image', slot: 0 },
      { assetId: 'other', type: 'image', slot: 2 },
    ])
  })

  it('keys timeline assets where no slot name can reach', () => {
    expect(timelineAssetKey('plugin-inlay-a')).toBe('timeline#plugin-inlay-a')
    expect(isTimelineAssetKey('timeline#plugin-inlay-a')).toBe(true)
    expect(isTimelineAssetKey('input_image')).toBe(false)
    expect(isTimelineAssetKey('timeline')).toBe(false)
  })

  it('carries the slot that first named each asset so a failure can be attributed', () => {
    expect(collectTimelineAssets(spec([
      { slot: 3, type: 'image', assetId: 'shared' },
      { slot: 4, type: 'image', assetId: 'shared' },
      { slot: 10, type: 'video', assetId: 'reel' },
    ]))).toEqual([
      { assetId: 'shared', type: 'image', slot: 3 },
      { assetId: 'reel', type: 'video', slot: 10 },
    ])
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
      1_787_501_943_985,
    )
    expect(resolved).toEqual({
      createdAt: 1_787_501_943_985,
      items: [
        {
          slot: 0,
          type: 'image',
          assetId: 'still',
          value: 'risu-comfy/uploaded-still.png',
          source_width: 768,
          source_height: 1120,
        },
        { slot: 0, type: 'audio', assetId: 'voice', value: 'risu-comfy/uploaded-voice.mp3' },
      ],
    })
  })

  it('keeps plugin-supplied video dimensions and lets the sidecar win for images', () => {
    const resolved = resolveTimelineSpec(
      spec([
        { slot: 0, type: 'image', assetId: 'still', source_width: 1, source_height: 1 },
        { slot: 9, type: 'video', assetId: 'reel', source_width: 1152, source_height: 784 },
      ]),
      {
        'timeline#still': { assetId: 'still', hash: 'A', type: 'image', width: 768, height: 1120 },
        'timeline#reel': { assetId: 'reel', hash: 'B', type: 'video' },
      },
      { 'timeline#still': 'still.png', 'timeline#reel': 'reel.mp4' },
      7,
    )
    expect(resolved.items).toEqual([
      { slot: 0, type: 'image', assetId: 'still', value: 'still.png', source_width: 768, source_height: 1120 },
      { slot: 9, type: 'video', assetId: 'reel', value: 'reel.mp4', source_width: 1152, source_height: 784 },
    ])
  })

  it('revalidates only in resolved mode, where value and createdAt belong', () => {
    const resolved = resolveTimelineSpec(
      spec([{ slot: 0, type: 'image', assetId: 'still' }]),
      { 'timeline#still': { assetId: 'still', hash: 'A', type: 'image' } },
      { 'timeline#still': 'still.png' },
      12,
    )
    expect(() => validateTimelineSpec(resolved, { resolved: true })).not.toThrow()
    expect(() => validateTimelineSpec(resolved)).toThrowError(expect.objectContaining({
      code: 'COMFY_SLOT_INVALID',
    }))
    expect(() => validateTimelineSpec(
      { createdAt: 12, items: [{ slot: 0, type: 'image', assetId: 'still' }] },
      { resolved: true },
    )).toThrowError(expect.objectContaining({ code: 'COMFY_SLOT_INVALID' }))
  })

  it('refuses to assemble an item that was never uploaded', () => {
    expect(() => resolveTimelineSpec(
      spec([{ slot: 0, type: 'image', assetId: 'still' }]),
      {},
      {},
      1,
    )).toThrowError(expect.objectContaining({ code: 'COMFY_SLOT_INVALID' }))
  })
})

describe('timeline document assembly', () => {
  // Byte-exact wire fixture. The live probe may still say the Director wants a
  // field we omit; this pin is what makes that a one-line change.
  it('emits the pinned wire document', () => {
    const document = assembleTimelineDocument({
      createdAt: 1_787_501_943_985,
      items: [
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
          slot: 9,
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
      ],
    })

    expect(document).toBe(
      '{"version":1,"items":['
      + '{"id":"image-1787501943985-0","enabled":true,"order":0,"slot":0,"start":0,"duration":1,'
      + '"type":"image","value":"risu-comfy/risu-job-AAAA.png","thumbnail":null,'
      + '"source_width":768,"source_height":1120},'
      + '{"id":"image-1787501943985-1","enabled":true,"order":1,"slot":1,"start":4,"duration":2,'
      + '"type":"image","value":"risu-comfy/risu-job-BBBB.png","thumbnail":null},'
      + '{"id":"video-1787501943985-2","enabled":true,"order":2,"slot":9,"start":9,"duration":2.5,'
      + '"type":"video","value":"risu-comfy/risu-job-CCCC.mp4","thumbnail":null,'
      + '"trim_start":1.5,"trim_end":4,"source_duration":9,"media_mode":"video_audio"},'
      + '{"id":"audio-1787501943985-3","enabled":true,"order":3,"slot":0,"start":0,"duration":6.25,'
      + '"type":"audio","value":"risu-comfy/risu-job-DDDD.mp3","thumbnail":null,'
      + '"source_duration":6.25}'
      + '],"prompt_blocks":[]}',
    )
  })

  it('defaults start to the slot index and duration per media kind', () => {
    const parsed = JSON.parse(assembleTimelineDocument(spec([
      { slot: 2, type: 'image', assetId: 'a', value: 'a.png' },
      { slot: 10, type: 'video', assetId: 'b', value: 'b.mp4' },
    ])))
    expect(parsed.items.map((item: any) => [item.start, item.duration])).toEqual([[2, 1], [10, 1]])
  })

  // Item ids are the one place a wall clock could leak in: the builder reads the
  // type back off `id.split('-')[0]`, so the ms has to come from the job record
  // and survive every dispatch attempt of that job.
  it('takes the id timestamp from the job, not the clock', () => {
    const items = [{ slot: 0, type: 'image', assetId: 'a', value: 'a.png' }]
    expect(JSON.parse(assembleTimelineDocument({ createdAt: 42, items })).items[0].id).toBe('image-42-0')
    expect(assembleTimelineDocument({ createdAt: 42, items }))
      .toBe(assembleTimelineDocument({ createdAt: 42, items }))
    // The pre-dispatch dry run has no job yet, so it assembles from zero rather
    // than from whatever the clock says at that instant.
    expect(JSON.parse(assembleTimelineDocument(spec(items))).items[0].id).toBe('image-0-0')
  })
})
