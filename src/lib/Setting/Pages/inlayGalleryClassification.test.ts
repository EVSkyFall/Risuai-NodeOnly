import { describe, expect, it } from 'vitest'
import { isOrphanMessageInlay } from './inlayGalleryClassification'

describe('orphan-message inlay classification', () => {
  it('excludes plugin-owned ids while retaining normal unreferenced inlays', () => {
    expect(isOrphanMessageInlay('plugin-inlay-source', 0)).toBe(false)
    expect(isOrphanMessageInlay('normal-inlay', 0)).toBe(true)
  })
})
