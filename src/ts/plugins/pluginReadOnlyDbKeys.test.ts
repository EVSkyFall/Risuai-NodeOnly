import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const between = (text: string, start: string, end: string) => {
    const from = text.indexOf(start)
    return text.slice(from, text.indexOf(end, from))
}
const count = (text: string, word: string) => text.split(word).length - 1

describe('plugin read-only database keys', () => {
    const plugins = source('src/ts/plugins/plugins.svelte.ts')
    const v3 = source('src/ts/plugins/apiV3/v3.svelte.ts')

    test('V3 getDatabase reads toggles, global variables and preset default variables', () => {
        const readOnly = between(plugins, 'export const pluginReadOnlyDbKeys', ']')
        expect(readOnly).toContain("'globalChatVariables'")
        expect(readOnly).toContain("'templateDefaultVariables'")
        const read = between(v3, 'getDatabase: async', 'installPlugin: handlePluginInstallViaPlugin')
        expect(read).toContain('for(const key of [...allowedDbKeys, ...pluginReadOnlyDbKeys])')
        expect(read).toContain('includeOnly.includes(key)')
    })

    test('no write path can reach the read-only keys', () => {
        const writable = between(plugins, 'export const allowedDbKeys', ']')
        expect(writable).not.toContain('globalChatVariables')
        expect(writable).not.toContain('templateDefaultVariables')
        // declaration only in plugins.svelte.ts; import + getDatabase loop in v3
        expect(count(plugins, 'pluginReadOnlyDbKeys')).toBe(1)
        expect(count(v3, 'pluginReadOnlyDbKeys')).toBe(2)
    })
})
