#!/usr/bin/env node
// Self-service illustration plugin digest rotation (2026-07-19 user decision:
// rotations are executed by the Plugin session, not the Core session).
//
// What it does, mechanically and loudly:
//   1. Independently recomputes the root AND dist bundle identity from disk
//      (bytes, SHA-256, BOM, CR count, final LF) and asserts they are
//      byte-identical. Optional --expect-sha/--expect-bytes cross-check the
//      request document's claims.
//   2. Rotates PINNED_ILLUSTRATION_PLUGIN_DIGESTS: [old rollback, old current]
//      -> [old current, new digest]. The displaced rollback digest is appended
//      to REJECTED_PLUGIN_SHA256S.
//   3. Updates PRODUCTION_PLUGIN, the rotation test title, and the
//      toHaveLength(N) assertion.
//   4. Runs the focused rotation regressions.
//
// It does NOT commit, push, or deploy — the operator follows the full gate in
// _Inbox/OPS_ILLUSTRATION_PIN_ROTATION_SELF_SERVICE_2026-07-19.md.
//
// Every patch site is anchored; if an anchor is not found EXACTLY ONCE the
// script aborts without writing anything. On abort, escalate to the Core
// session instead of hand-editing blindly.

import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const NODEONLY = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_ROOT = resolve(NODEONLY, '../plugin/LightboardIllustrationAgent/lb-xnai-agent.js')
const BUNDLE_DIST = resolve(NODEONLY, '../plugin/LightboardIllustrationAgent/dist/lb-xnai-agent.js')
const V3BRIDGE = resolve(NODEONLY, 'src/ts/process/illustrationJobs/v3Bridge.ts')
const FIXTURES = resolve(NODEONLY, 'src/ts/process/illustrationJobs/tests/acceptance/sharedFixtures.ts')
const FIXTURES_TEST = resolve(NODEONLY, 'src/ts/process/illustrationJobs/tests/acceptance/sharedFixtures.test.ts')

function fail(message) {
    console.error(`\n[rotate-illustration-pin] ABORT: ${message}`)
    console.error('[rotate-illustration-pin] No files were modified beyond any step already reported as written.')
    console.error('[rotate-illustration-pin] Escalate to the Core session rather than hand-editing.')
    process.exit(1)
}

function arg(name) {
    const index = process.argv.indexOf(`--${name}`)
    return index >= 0 ? process.argv[index + 1] : undefined
}

const versionLabel = arg('version')
const summary = arg('summary')
const expectSha = arg('expect-sha')?.toLowerCase()
const expectBytes = arg('expect-bytes')
const dryRun = process.argv.includes('--dry-run')

if (!versionLabel || !summary) {
    console.error('Usage: node scripts/rotate-illustration-pin.mjs --version <label e.g. "0.2.6 terminal-close UX hotfix"> --summary <short slug e.g. "terminal-close UX hotfix"> [--expect-sha <hex64>] [--expect-bytes <n>] [--dry-run]')
    process.exit(1)
}

// ---- 0. Git preconditions: the three pin files must be untouched -----------
const dirty = execSync(
    'git status --porcelain -- src/ts/process/illustrationJobs/v3Bridge.ts src/ts/process/illustrationJobs/tests/acceptance/sharedFixtures.ts src/ts/process/illustrationJobs/tests/acceptance/sharedFixtures.test.ts',
    { cwd: NODEONLY, encoding: 'utf8' },
).trim()
if (dirty) {
    fail(`the pin files are already modified in the working tree (another track in flight?):\n${dirty}\nWait for the Core session to land its work, then re-run.`)
}

// ---- 1. Independent bundle identity -----------------------------------------
function identity(path) {
    const bytes = readFileSync(path)
    return {
        path,
        bytes,
        length: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bom: bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
        crCount: bytes.filter((b) => b === 13).length,
        finalLf: bytes.length > 0 && bytes[bytes.length - 1] === 10,
    }
}

const root = identity(BUNDLE_ROOT)
const dist = identity(BUNDLE_DIST)
console.log(`[rotate] root: ${root.length} bytes sha256=${root.sha256} BOM=${root.bom} CR=${root.crCount} finalLF=${root.finalLf}`)
console.log(`[rotate] dist: ${dist.length} bytes sha256=${dist.sha256} BOM=${dist.bom} CR=${dist.crCount} finalLF=${dist.finalLf}`)

if (!root.bytes.equals(dist.bytes)) fail('root and dist bundles are NOT byte-identical')
if (root.bom) fail('bundle has a BOM')
if (root.crCount !== 0) fail(`bundle contains ${root.crCount} CR bytes`)
if (!root.finalLf) fail('bundle does not end with a final LF')
if (expectSha && expectSha !== root.sha256) fail(`request doc sha (${expectSha}) != recomputed (${root.sha256})`)
if (expectBytes && Number(expectBytes) !== root.length) fail(`request doc bytes (${expectBytes}) != recomputed (${root.length})`)

const newDigest = root.sha256
const newBytes = root.length

// ---- 2. Parse the current pin window ----------------------------------------
const bridgeSrc = readFileSync(V3BRIDGE, 'utf8')
const pinRe = /export const PINNED_ILLUSTRATION_PLUGIN_DIGESTS = Object\.freeze\(\[\r?\n\s*'([0-9a-f]{64})',\r?\n\s*'([0-9a-f]{64})',\r?\n\] as const satisfies PinnedDigestRotation\)/
const pinMatch = bridgeSrc.match(pinRe)
if (!pinMatch) fail('could not locate the two-entry pin array in v3Bridge.ts (format drift?)')
const [, oldRollback, oldCurrent] = pinMatch

if (newDigest === oldCurrent || newDigest === oldRollback) fail('the new digest is already pinned')
const fixturesSrc = readFileSync(FIXTURES, 'utf8')
if (fixturesSrc.includes(newDigest)) fail('the new digest appears in REJECTED_PLUGIN_SHA256S — refusing to resurrect a rejected bundle')

console.log(`[rotate] window: [${oldRollback.slice(0, 8)}…, ${oldCurrent.slice(0, 8)}…] -> [${oldCurrent.slice(0, 8)}…, ${newDigest.slice(0, 8)}…]`)
console.log(`[rotate] displaced -> REJECTED: ${oldRollback.slice(0, 8)}…`)

const today = new Date().toISOString().slice(0, 10)

// ---- 3. Patch v3Bridge.ts ----------------------------------------------------
const bridgeCommentRe = /\/\/ Rotation may temporarily contain[\s\S]*?export const PINNED_ILLUSTRATION_PLUGIN_DIGESTS/
if ((bridgeSrc.match(new RegExp(bridgeCommentRe.source, 'g')) || []).length !== 1) fail('v3Bridge.ts rotation comment anchor not found exactly once')
const newBridge = bridgeSrc
    .replace(bridgeCommentRe,
        `// Rotation may temporarily contain the old and new production digests, never more than two.\n`
        + `// [0] = previous release (rollback window), [1] = ${versionLabel} (${newBytes.toLocaleString('en-US')} bytes;\n`
        + `// digest independently recomputed from the root and dist bundles on ${today} by\n`
        + `// scripts/rotate-illustration-pin.mjs — ${summary}). Retired releases, the discarded\n`
        + `// pre-contract 0.2.0 snapshot, and the discarded interim drafts must never re-enter\n`
        + `// (regressions in tests/acceptance/sharedFixtures.ts). Converge to a single pin once\n`
        + `// rollout confirms.\n`
        + `export const PINNED_ILLUSTRATION_PLUGIN_DIGESTS`)
    .replace(pinRe,
        `export const PINNED_ILLUSTRATION_PLUGIN_DIGESTS = Object.freeze([\n`
        + `    '${oldCurrent}',\n`
        + `    '${newDigest}',\n`
        + `] as const satisfies PinnedDigestRotation)`)

// ---- 4. Patch sharedFixtures.ts ----------------------------------------------
const prodRe = /export const PRODUCTION_PLUGIN = Object\.freeze\(\{\r?\n\s*name: 'lb_xnai_agent',[\s\S]*?\}\)/
if ((fixturesSrc.match(new RegExp(prodRe.source, 'g')) || []).length !== 1) fail('PRODUCTION_PLUGIN anchor not found exactly once')
const rejectedTailRe = /(\r?\n)\]\)\r?\n/
if (!fixturesSrc.match(/export const REJECTED_PLUGIN_SHA256S = Object\.freeze\(\[/)) fail('REJECTED_PLUGIN_SHA256S anchor not found')

const newFixtures = fixturesSrc
    .replace(prodRe,
        `export const PRODUCTION_PLUGIN = Object.freeze({\n`
        + `    name: 'lb_xnai_agent',\n`
        + `    // Previous release — kept as the rollback window.\n`
        + `    scriptSha256: '${oldCurrent}',\n`
        + `    // ${versionLabel} release bundle (${newBytes.toLocaleString('en-US')} bytes) — digest independently\n`
        + `    // recomputed from the root and dist bundles on ${today} by scripts/rotate-illustration-pin.mjs.\n`
        + `    scriptSha256Next: '${newDigest}',\n`
        + `})`)
    // Append the displaced digest at the end of the REJECTED array (before the closing `])`).
    .replace(/,\r?\n\]\)/,
        `,\n`
        + `    // Displaced from the rotation window by the ${versionLabel} rotation (${today},\n`
        + `    // scripts/rotate-illustration-pin.mjs).\n`
        + `    '${oldRollback}',\n`
        + `])`)
if (!newFixtures.includes(oldRollback)) fail('failed to append the displaced digest to REJECTED_PLUGIN_SHA256S')

// ---- 5. Patch sharedFixtures.test.ts ------------------------------------------
const testSrc = readFileSync(FIXTURES_TEST, 'utf8')
const titleRe = /test\('pins the .*? rotation window and rejects every superseded digest', async \(\) => \{/
const lengthRe = /expect\(REJECTED_PLUGIN_SHA256S\)\.toHaveLength\((\d+)\)/
const titleMatches = testSrc.match(new RegExp(titleRe.source, 'g')) || []
const lengthMatch = testSrc.match(lengthRe)
if (titleMatches.length !== 1) fail('rotation test title anchor not found exactly once')
if (!lengthMatch) fail('toHaveLength anchor not found')
const newLength = Number(lengthMatch[1]) + 1
const newTest = testSrc
    .replace(titleRe, `test('pins the ${versionLabel} rotation window and rejects every superseded digest', async () => {`)
    .replace(lengthRe, `expect(REJECTED_PLUGIN_SHA256S).toHaveLength(${newLength})`)

if (dryRun) {
    console.log(`[rotate] DRY RUN — no files written. Planned: pin -> [${oldCurrent.slice(0, 12)}…, ${newDigest.slice(0, 12)}…], REJECTED ${lengthMatch[1]} -> ${newLength}.`)
    process.exit(0)
}

writeFileSync(V3BRIDGE, newBridge)
writeFileSync(FIXTURES, newFixtures)
writeFileSync(FIXTURES_TEST, newTest)
console.log('[rotate] patched v3Bridge.ts, sharedFixtures.ts, sharedFixtures.test.ts')

// ---- 6. Focused regressions ----------------------------------------------------
console.log('[rotate] running focused rotation regressions…')
try {
    execSync(
        'pnpm exec vitest run src/ts/process/illustrationJobs/tests/acceptance/sharedFixtures.test.ts src/ts/process/illustrationJobs/tests/v3Bridge.test.ts',
        { cwd: NODEONLY, stdio: 'inherit' },
    )
} catch {
    fail('focused rotation regressions FAILED — inspect the output above; do not commit')
}

console.log(`\n[rotate] SUCCESS. pin=[${oldCurrent.slice(0, 12)}…(rollback), ${newDigest.slice(0, 12)}…(${versionLabel})], REJECTED now ${newLength}.`)
console.log('[rotate] Next: follow the full gate + commit + deploy procedure in')
console.log('[rotate]   G:/Antigravity/RisuAI/_Inbox/OPS_ILLUSTRATION_PIN_ROTATION_SELF_SERVICE_2026-07-19.md')
