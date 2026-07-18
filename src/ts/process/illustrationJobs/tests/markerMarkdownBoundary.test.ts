import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import markdownit from 'markdown-it'
import { describe, expect, test } from 'vitest'
import { appendRequestMarkerAtLineBoundary, buildRequestMarker } from '../controlNodes'

// Mirrors src/ts/parser/parser.svelte.ts:25-45 exactly: identical markdown-it
// options plus the same `.disable(['code'])` (which disables 4-space indented code
// blocks only — the ``` fence rule stays enabled). This is the real markdown-it
// library and config that NodeOnly renders assistant turns through, so the
// closing-fence swallow reproduced here is the exact FOLLOWUP repro (2026-07-18 §2)
// with no host-side DOM/DOMPurify variability.
const markdownItOptions = {
    html: true,
    breaks: true,
    linkify: false,
    typographer: true,
    quotes: '\u{E9b0}\u{E9b1}\u{E9b2}\u{E9b3}',
}
const md = markdownit(markdownItOptions)
const mdHighlight = markdownit({
    highlight: (str: string, lang: string) =>
        lang ? `<pre-hljs-placeholder lang="${lang}">${str}</pre-hljs-placeholder>` : '',
    ...markdownItOptions,
})
md.disable(['code'])
mdHighlight.disable(['code'])

function highlightFenceRegion(rendered: string): string | null {
    const match = rendered.match(
        /<pre-hljs-placeholder lang="[^"]*">([\s\S]*?)<\/pre-hljs-placeholder>/,
    )
    return match ? match[1] : null
}

describe('request marker markdown line-boundary (markdown-it fence repro)', () => {
    const NONCE = 'md_boundary_nonce'
    const marker = buildRequestMarker(NONCE)
    // Assistant body that ends with a closing ``` fence — the followup's repro shape.
    const body = '```html\n<b>x</b>\n```'

    test('adjacent marker (RED baseline) swallows the closing fence; line-boundary (GREEN) closes it', () => {
        // Pre-contract adjacent serialization fuses the marker to the closing fence.
        const adjacent = `${body}${marker}`
        // The line-boundary append the core now owns puts the marker on its own line.
        const framed = appendRequestMarkerAtLineBoundary(body, NONCE)
        expect(framed).toBe(`${body}\n${marker}`)

        // --- mdHighlight: the real render path (renderHighlightableMarkdown) ---
        // RED: the closing fence never closes, so the marker is swallowed INTO the
        // highlighted code region — the user "still only sees code" (여전히 코드만 보임).
        const adjacentRegion = highlightFenceRegion(mdHighlight.render(adjacent))
        expect(adjacentRegion).not.toBeNull()
        expect(adjacentRegion).toContain(marker)

        // GREEN: the fence closes cleanly; the code region is exactly the body and the
        // marker sits OUTSIDE the closed code block.
        const framedRendered = mdHighlight.render(framed)
        const framedRegion = highlightFenceRegion(framedRendered)
        expect(framedRegion).toBe('<b>x</b>\n')
        expect(framedRegion).not.toContain(marker)
        expect(framedRendered).toContain(marker)

        // --- plain md: fence -> <pre><code>, content HTML-escaped ---
        // RED: the escaped marker leaks inside the unterminated <code> block.
        const adjacentHtml = md.render(adjacent)
        expect(adjacentHtml).toContain(`&lt;!--risu-illustration-request:v1:${NONCE}`)
        // GREEN: no escaped marker inside code; the raw marker renders outside.
        const framedHtml = md.render(framed)
        expect(framedHtml).not.toContain('&lt;!--risu-illustration-request')
        expect(framedHtml).toContain(marker)
    })
})

// The fence repro above is only faithful while this file's private markdown-it
// config stays byte-identical to the real render path in
// src/ts/parser/parser.svelte.ts. That file's `markdownItOptions` / disabled-rule
// list cannot be imported here without dragging in katex/highlight.js/DOMPurify
// (which strip the HTML-comment marker and muddy the observable), so the config is
// mirrored by copy. This guard links the two by verification instead of by import:
// it reads both source files off disk and asserts the copied blocks still match, so
// any future edit to the parser's options or disabled rules turns this test RED
// rather than letting the fixture silently assert against a stale config.
// Resolved from the repo root (vitest runs with cwd = repo root, matching the
// imagePromptMeasurement.node.test.ts convention).
const PARSER_SOURCE_PATH = resolve(process.cwd(), 'src/ts/parser/parser.svelte.ts')
const FIXTURE_SOURCE_PATH = resolve(
    process.cwd(),
    'src/ts/process/illustrationJobs/tests/markerMarkdownBoundary.test.ts',
)

function stripLineComments(text: string): string {
    // The parser's `quotes` line carries a trailing `//` comment the fixture omits.
    // No string literal in the option block contains `//`, so a line-wise strip is safe.
    return text.replace(/\/\/[^\n]*/g, '')
}

function normalize(text: string): string {
    return stripLineComments(text).replace(/\s+/g, ' ').trim()
}

function extractMarkdownItOptionsBlock(rawSource: string): string {
    // Strip line comments first so a `.disable`/config mention in prose (this very
    // fixture's header comment names both) can never be mistaken for real code.
    const source = stripLineComments(rawSource)
    const marker = 'const markdownItOptions = {'
    const start = source.indexOf(marker)
    if (start === -1) throw new Error('markdownItOptions declaration not found')
    const braceStart = start + marker.length - 1
    // Balanced-brace scan. The `quotes` value's \u{...} escapes are each internally
    // balanced, so depth only returns to 0 at the real closing brace.
    let depth = 0
    for (let i = braceStart; i < source.length; i += 1) {
        const ch = source[i]
        if (ch === '{') depth += 1
        else if (ch === '}') {
            depth -= 1
            if (depth === 0) return source.slice(braceStart, i + 1)
        }
    }
    throw new Error('markdownItOptions object literal is not brace-balanced')
}

function extractDisabledRuleArgs(rawSource: string): string[] {
    const source = stripLineComments(rawSource)
    return Array.from(source.matchAll(/\.disable\((\[[^\]]*\])\)/g), (match) =>
        normalize(match[1]),
    ).sort()
}

describe('markdown-it fixture config fidelity (drift guard vs parser.svelte.ts)', () => {
    const parserSource = readFileSync(PARSER_SOURCE_PATH, 'utf8')
    const fixtureSource = readFileSync(FIXTURE_SOURCE_PATH, 'utf8')

    test('markdownItOptions block matches the real render path byte-for-byte (comments aside)', () => {
        const parserOptions = normalize(extractMarkdownItOptionsBlock(parserSource))
        const fixtureOptions = normalize(extractMarkdownItOptionsBlock(fixtureSource))
        expect(fixtureOptions).toBe(parserOptions)
    })

    test('disabled markdown-it rules match the real render path', () => {
        const parserDisabled = extractDisabledRuleArgs(parserSource)
        const fixtureDisabled = extractDisabledRuleArgs(fixtureSource)
        expect(parserDisabled.length).toBeGreaterThan(0)
        expect(fixtureDisabled).toEqual(parserDisabled)
    })
})
