import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (path: string) => readFileSync(join(HERE, path), 'utf8')

describe('plugin startup bridge contracts', () => {
    test('normal pluginStorage exposes ordered getMany through one host method', () => {
        const v3 = read('v3.svelte.ts')
        const dts = read('risuai.d.ts')

        expect(v3).toMatch(/_getManyPluginStorage:\s*\(keys:\s*string\[\]\)\s*=>\s*keys\.map\(/)
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
