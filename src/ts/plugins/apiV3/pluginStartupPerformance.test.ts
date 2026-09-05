import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (path: string) => readFileSync(join(HERE, path), 'utf8')

describe('plugin startup bridge contracts', () => {
    test('V2 and V3 current-character names share the scoped snapshot helper', () => {
        const v2 = read('../plugins.svelte.ts')
        const v3 = read('v3.svelte.ts')

        expect(v2).toContain('hydratePluginCharacterSnapshotSync(getCurrentCharacter({ snapshot: true }))')
        expect(v3).toMatch(/getChar:\s*getCharacterForPlugin/)
        expect(v3).toMatch(/getCharacter:\s*getCharacterForPlugin/)
    })

    test('lite current context is a typed top-level root method, not an alias', () => {
        const v3 = read('v3.svelte.ts')
        const dts = read('risuai.d.ts')
        const contextType = dts.match(/interface CurrentContextLite\s*\{([\s\S]*?)\}/)?.[1] ?? ''

        expect(v3).toMatch(/getCurrentContextLite:\s*getCurrentContextLite/)
        expect(v3).not.toContain("'getCurrentContextLite'")
        expect(v3).not.toContain('_getCurrentContextLite')
        expect(contextType).toContain('chaId: string | null;')
        expect(contextType).toContain('name: string | null;')
        expect(contextType).toContain('chatPage: number | null;')
        expect(contextType).toContain('chatId: string | null;')
        expect(contextType).toContain('chatName: string | null;')
        expect(dts).toMatch(/getCurrentContextLite\(\):\s*Promise<CurrentContextLite>/)
    })

    test('normal pluginStorage exposes ordered getMany through one host method', () => {
        const v3 = read('v3.svelte.ts')
        const dts = read('risuai.d.ts')

        expect(v3).toMatch(/_getManyPluginStorage:\s*\(keys:\s*string\[\]\)\s*=>\s*Promise\.all\(keys\.map\(/)
        expect(v3).toMatch(/'getMany':\s*'_getManyPluginStorage'/)
        expect(dts).toMatch(/getMany\(keys:\s*string\[\]\):\s*Promise<\(any \| null\)\[\]>/)
    })

    test('plugin permission ask is layered above the fullscreen iframe only for that call path', () => {
        const v3 = read('v3.svelte.ts')
        const alert = read('../../alert.ts')
        const component = read('../../../lib/Others/AlertComp.svelte')
        const dialog = read('../../../lib/UI/GUI/ShAlertDialog.svelte')

        const iframeZ = Number(v3.match(/iframe\.style\.zIndex\s*=\s*"(\d+)"/)?.[1])
        const permissionZ = Number(component.match(/abovePlugin\s*\?\s*'z-\[(\d+)\]'/)?.[1])

        expect(v3).toMatch(/alertConfirm\(alertTitle,\s*\{\s*abovePlugin:\s*true\s*\}\)/)
        expect(alert).toMatch(/alertConfirm\(msg:\s*string,\s*options\??:/)
        expect(dialog).toContain('overlayClass?: string;')
        expect(dialog).toMatch(/tierClasses\[tier\],\s*overlayClass/)
        expect(component).toMatch(/overlayClass=\{\$alertStore\.abovePlugin\s*\?\s*'z-\[1100\]'\s*:\s*''\}/)
        expect(component).toMatch(/contentClass=\{\$alertStore\.abovePlugin\s*\?\s*'z-\[1100\]'\s*:\s*''\}/)
        expect(permissionZ).toBeGreaterThan(iframeZ)
    })
})
