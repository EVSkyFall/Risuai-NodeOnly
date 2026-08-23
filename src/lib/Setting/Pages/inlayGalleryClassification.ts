const PLUGIN_INLAY_ID_PATTERN = /^plugin-inlay-/

export function isOrphanMessageInlay(id: string, referenceCount: number): boolean {
  return !PLUGIN_INLAY_ID_PATTERN.test(id) && referenceCount === 0
}
