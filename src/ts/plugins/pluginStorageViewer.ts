export type PluginStorageViewerBackend = 'save' | 'local' | 'idb'

// This is a UTF-16 code-unit cap, matching JavaScript string.length. One MiB
// code units is at most about 2 MiB of additional UTF-16 preview storage, and
// avoids allocating another full value merely to count its encoded bytes.
export const PLUGIN_STORAGE_PREVIEW_CHARS = 1024 * 1024

export interface PluginStorageValueSummary {
    type: string
    size: number | null
}

export interface PluginStorageValuePreview {
    text: string
    type: string
    totalChars: number
    totalCharsExact: boolean
    truncated: boolean
    editable: boolean
}

export interface PluginStorageOperationContext {
    backend: PluginStorageViewerBackend
    key: string
    generation: number
}

export interface PluginStorageDetailGuard extends PluginStorageOperationContext {
    editable: boolean
}

function copyStringRange(value: string, start: number, end: number): string {
    const chunks: string[] = []
    const batchSize = 8192
    for (let offset = start; offset < end; offset += batchSize) {
        const batchEnd = Math.min(end, offset + batchSize)
        const codeUnits = new Array<number>(batchEnd - offset)
        for (let i = offset; i < batchEnd; i++) codeUnits[i - offset] = value.charCodeAt(i)
        chunks.push(String.fromCharCode(...codeUnits))
    }
    return chunks.join('')
}

function valueType(value: unknown): string {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    return typeof value
}

export function summarizeStoredValue(value: unknown): PluginStorageValueSummary {
    const type = valueType(value)
    if (typeof value === 'string') return { type, size: value.length * 2 }
    if (value === null || value === undefined) return { type, size: 0 }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return { type, size: String(value).length * 2 }
    }
    return { type, size: null }
}

class BoundedWriter {
    private readonly chunks: string[] = []
    private length = 0
    truncated = false
    lossy = false

    constructor(private readonly limit: number) {}

    get remaining(): number {
        return Math.max(0, this.limit - this.length)
    }

    append(text: string): boolean {
        return this.appendSlice(text, 0, text.length)
    }

    appendSlice(text: string, start: number, end: number): boolean {
        const sourceLength = Math.max(0, end - start)
        if (sourceLength === 0) return true
        const take = Math.min(this.remaining, sourceLength)
        if (take > 0) {
            // A large String#slice can keep the complete parent backing store
            // alive in V8. Copy only the bounded range into independent chunks.
            this.chunks.push(
                text.length > 64 * 1024 || text.length > take
                    ? copyStringRange(text, start, start + take)
                    : text.slice(start, start + take),
            )
            this.length += take
        }
        if (take < sourceLength) {
            this.truncated = true
            return false
        }
        return true
    }

    markTruncated(): void {
        this.truncated = true
    }

    markLossy(): void {
        this.lossy = true
    }

    finish(): string {
        return this.chunks.join('')
    }
}

function escapedJsonChar(charCode: number, char: string): string | null {
    if (char === '"') return '\\"'
    if (char === '\\') return '\\\\'
    if (charCode === 8) return '\\b'
    if (charCode === 9) return '\\t'
    if (charCode === 10) return '\\n'
    if (charCode === 12) return '\\f'
    if (charCode === 13) return '\\r'
    if (charCode < 32) return `\\u${charCode.toString(16).padStart(4, '0')}`
    return null
}

function writeJsonString(value: string, writer: BoundedWriter): boolean {
    if (!writer.append('"')) return false
    let runStart = 0
    for (let i = 0; i < value.length; i++) {
        const escaped = escapedJsonChar(value.charCodeAt(i), value[i])
        if (escaped !== null) {
            if (!writer.appendSlice(value, runStart, i)) return false
            if (!writer.append(escaped)) return false
            runStart = i + 1
            continue
        }

        // Flush as soon as the current safe run can fill the remaining output.
        // This makes a multi-hundred-megabyte base64 string cost at most the
        // preview cap instead of scanning or slicing the complete string.
        if (i - runStart + 1 >= writer.remaining) {
            if (!writer.appendSlice(value, runStart, i + 1)) return false
            if (i + 1 < value.length) writer.markTruncated()
            return false
        }
    }
    if (!writer.appendSlice(value, runStart, value.length)) return false
    return writer.append('"')
}

function writeIndent(writer: BoundedWriter, depth: number): boolean {
    if (!writer.append('\n')) return false
    return writer.append('  '.repeat(depth))
}

function writeJsonValue(
    value: unknown,
    writer: BoundedWriter,
    depth: number,
    seen: WeakSet<object>,
    arraySlot = false,
): boolean {
    if (value === null) return writer.append('null')

    const type = typeof value
    if (type === 'string') return writeJsonString(value as string, writer)
    if (type === 'boolean') return writer.append(value ? 'true' : 'false')
    if (type === 'number') {
        return writer.append(Number.isFinite(value) ? String(value) : 'null')
    }
    if (type === 'bigint') {
        writer.markLossy()
        return writeJsonString(String(value), writer)
    }
    if (type === 'undefined' || type === 'function' || type === 'symbol') {
        writer.markLossy()
        return writer.append(arraySlot ? 'null' : '')
    }
    if (type !== 'object') {
        writer.markLossy()
        return writer.append('')
    }

    const object = value as object
    if (seen.has(object)) {
        writer.markLossy()
        return writeJsonString('[Circular]', writer)
    }
    if (depth >= 100) {
        writer.markLossy()
        return writeJsonString('[Max depth reached]', writer)
    }
    seen.add(object)

    if (Array.isArray(value)) {
        if (!writer.append('[')) return false
        for (let i = 0; i < value.length; i++) {
            if (i === 0) {
                if (!writeIndent(writer, depth + 1)) return false
            } else {
                if (!writer.append(',')) return false
                if (!writeIndent(writer, depth + 1)) return false
            }
            if (!writeJsonValue(value[i], writer, depth + 1, seen, true)) return false
        }
        if (value.length > 0 && !writeIndent(writer, depth)) return false
        seen.delete(object)
        return writer.append(']')
    }

    if (!writer.append('{')) return false
    const record = value as Record<string, unknown>
    let written = 0
    for (const key in record) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue
        if (writer.remaining === 0) {
            writer.markTruncated()
            return false
        }

        const descriptor = Object.getOwnPropertyDescriptor(record, key)
        if (!descriptor) continue
        let property: unknown
        if (!('value' in descriptor)) {
            // Never execute plugin-provided getters while rendering a viewer
            // preview. They can allocate unbounded data or have side effects.
            writer.markLossy()
            property = '[Accessor property]'
        } else {
            property = descriptor.value
        }
        const propertyType = typeof property
        if (propertyType === 'undefined' || propertyType === 'function' || propertyType === 'symbol') continue

        if (written === 0) {
            if (!writeIndent(writer, depth + 1)) return false
        } else {
            if (!writer.append(',')) return false
            if (!writeIndent(writer, depth + 1)) return false
        }
        if (!writeJsonString(key, writer)) return false
        if (!writer.append(': ')) return false
        if (!writeJsonValue(property, writer, depth + 1, seen)) return false
        written++
    }
    if (written > 0 && !writeIndent(writer, depth)) return false
    seen.delete(object)
    return writer.append('}')
}

export function createBoundedValuePreview(
    value: unknown,
    limit = PLUGIN_STORAGE_PREVIEW_CHARS,
): PluginStorageValuePreview {
    const safeLimit = Math.max(0, Math.floor(limit))
    const type = valueType(value)

    // Plugin blobs and legacy base64 values are strings. Their full character
    // count is available in O(1), so they can report an exact size without a
    // second full-sized allocation.
    if (typeof value === 'string') {
        const truncated = value.length > safeLimit
        return {
            text: truncated ? copyStringRange(value, 0, safeLimit) : value,
            type,
            totalChars: value.length,
            totalCharsExact: true,
            truncated,
            editable: !truncated,
        }
    }

    const writer = new BoundedWriter(safeLimit)
    const completed = writeJsonValue(value, writer, 0, new WeakSet())
    const text = writer.finish()
    const truncated = !completed || writer.truncated || writer.lossy
    return {
        text,
        type,
        totalChars: text.length,
        totalCharsExact: !truncated,
        truncated,
        editable: !truncated,
    }
}

export function matchesBoundedValue(
    value: unknown,
    normalizedQuery: string,
    limit = PLUGIN_STORAGE_PREVIEW_CHARS,
): boolean {
    if (!normalizedQuery) return true
    const preview = createBoundedValuePreview(value, limit)
    return preview.text.toLocaleLowerCase().includes(normalizedQuery.toLocaleLowerCase())
}

export function canMutateDetail(
    detail: PluginStorageDetailGuard | null,
    current: PluginStorageOperationContext,
): boolean {
    return Boolean(
        detail?.editable
        && detail.backend === current.backend
        && detail.key === current.key
        && detail.generation === current.generation,
    )
}

export function canCommitDetailMutation(
    operationToken: number,
    currentOperationToken: number,
    detail: PluginStorageDetailGuard | null,
    current: PluginStorageOperationContext,
): boolean {
    return operationToken === currentOperationToken && canMutateDetail(detail, current)
}

export function isCurrentStorageOperation(
    operationToken: number,
    currentToken: number,
    operationBackend: PluginStorageViewerBackend,
    currentBackend: PluginStorageViewerBackend,
): boolean {
    return operationToken === currentToken && operationBackend === currentBackend
}

interface CustomStoragePort {
    keys(): string[]
    getItem(key: string): unknown
    setItem(key: string, value: unknown): void
    removeItem(key: string): void
    flushImmediate(): Promise<void>
}

interface LocalStoragePort {
    keys(): string[]
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
}

interface IdbStoragePort {
    keys(): Promise<string[]>
    getItemUncached<T>(key: string): Promise<T | null>
    setItem<T>(key: string, value: T): Promise<void>
    removeItem(key: string): Promise<void>
}

interface PluginStorageBackendDependencies {
    custom: CustomStoragePort
    local: LocalStoragePort
    idb: IdbStoragePort
    removeOwner(backend: PluginStorageViewerBackend, key: string): void | Promise<void>
}

export function createPluginStorageBackendAdapter(deps: PluginStorageBackendDependencies) {
    return {
        async keys(backend: PluginStorageViewerBackend): Promise<string[]> {
            if (backend === 'save') return deps.custom.keys()
            if (backend === 'local') return deps.local.keys()
            return await deps.idb.keys()
        },

        summary(backend: PluginStorageViewerBackend, key: string): PluginStorageValueSummary {
            if (backend === 'save') return summarizeStoredValue(deps.custom.getItem(key))
            if (backend === 'local') return { type: 'string', size: null }
            return { type: 'unknown', size: null }
        },

        async read(backend: PluginStorageViewerBackend, key: string): Promise<unknown> {
            if (backend === 'save') return deps.custom.getItem(key)
            if (backend === 'local') return deps.local.getItem(key)
            return await deps.idb.getItemUncached(key)
        },

        async write(backend: PluginStorageViewerBackend, key: string, value: unknown): Promise<void> {
            if (backend === 'save') {
                deps.custom.setItem(key, value)
                await deps.custom.flushImmediate()
                return
            }
            if (backend === 'local') {
                deps.local.setItem(key, value as string)
                return
            }
            await deps.idb.setItem(key, value)
        },

        async remove(backend: PluginStorageViewerBackend, key: string): Promise<void> {
            if (backend === 'save') {
                deps.custom.removeItem(key)
                await deps.custom.flushImmediate()
            } else if (backend === 'local') {
                deps.local.removeItem(key)
            } else {
                await deps.idb.removeItem(key)
            }
            await deps.removeOwner(backend, key)
        },

        async removeMany(backend: PluginStorageViewerBackend, keys: string[]): Promise<void> {
            if (backend === 'save') {
                for (const key of keys) deps.custom.removeItem(key)
                await deps.custom.flushImmediate()
            } else if (backend === 'local') {
                for (const key of keys) deps.local.removeItem(key)
            } else {
                for (const key of keys) await deps.idb.removeItem(key)
            }
            for (const key of keys) await deps.removeOwner(backend, key)
        },
    }
}
