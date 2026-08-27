// @vitest-environment node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// putMedia is only reachable by a plugin when all three wiring points agree:
// the host handler, the sandbox alias, and the advertised capability. A missing
// one fails silently at runtime, so pin them together.
describe('pluginInlays.putMedia sandbox wiring', () => {
    it('exposes the handler, alias, capability, and declaration', async () => {
        const v3 = await readFile(path.resolve('src/ts/plugins/apiV3/v3.svelte.ts'), 'utf8')
        expect(v3).toContain('_putPluginInlayMedia: (input: any) => pluginImagesApi.putMedia(input)')
        expect(v3).toContain("'putMedia': '_putPluginInlayMedia'")
        expect(v3).toContain('pluginInlaysPutMediaV1: 1')
        // The image path keeps its own wiring untouched.
        expect(v3).toContain('_putPluginInlayImage: (input: any) => pluginImagesApi.putImage(input)')
        expect(v3).toContain("'putImage': '_putPluginInlayImage'")
        expect(v3).toContain('pluginInlaysPutImageV1: 1')

        const declaration = await readFile(path.resolve('src/ts/plugins/apiV3/risuai.d.ts'), 'utf8')
        expect(declaration).toContain(
            'putMedia?(input: PluginInlayPutMediaInput): Promise<PluginInlayPutMediaResult>;',
        )
        expect(declaration).toContain('type PluginInlayPutMediaResult = PluginInlayPutImageResult;')
    })
})
