import { describe, expect, test } from 'vitest'
import {
    buildRequestMarker,
    buildSlotNode,
    findRequestMarkers,
    findSlotNodes,
} from '../../controlNodes'
import {
    JOB_TRANSITIONS,
    isPrunableJobState,
    isTerminalJobState,
} from '../../stateMachine'
import {
    ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME,
    PINNED_ILLUSTRATION_PLUGIN_DIGESTS,
    authorizeIllustrationV3Plugin,
    evaluateIllustrationV3Authorization,
} from '../../v3Bridge'
import {
    JOB_STATE_ACCEPTANCE,
    PRODUCTION_JOB_ID,
    PRODUCTION_JOB_ID_RE,
    PRODUCTION_REQUEST_MARKER,
    PRODUCTION_REQUEST_NONCE,
    PRODUCTION_REQUEST_NONCE_RE,
    PRODUCTION_PLUGIN,
    PRODUCTION_SLOT_NODE,
    PRODUCTION_SLOT_TOKEN,
    PRODUCTION_SLOT_TOKEN_RE,
    REJECTED_PLUGIN_SHA256S,
} from './sharedFixtures'

describe('Gate 4d shared Core fixtures', () => {
    // §5 shared fixture: exact production marker/slot bytes and 32-hex identifiers.
    test('pins production control nodes while distinguishing the parser superset', () => {
        expect(PRODUCTION_REQUEST_NONCE).toMatch(PRODUCTION_REQUEST_NONCE_RE)
        expect(PRODUCTION_JOB_ID).toMatch(PRODUCTION_JOB_ID_RE)
        expect(PRODUCTION_SLOT_TOKEN).toMatch(PRODUCTION_SLOT_TOKEN_RE)
        expect(buildRequestMarker(PRODUCTION_REQUEST_NONCE)).toBe(PRODUCTION_REQUEST_MARKER)
        expect(buildSlotNode(PRODUCTION_JOB_ID, PRODUCTION_SLOT_TOKEN)).toBe(PRODUCTION_SLOT_NODE)
        expect(findRequestMarkers(PRODUCTION_REQUEST_MARKER)).toEqual([{
            start: 0,
            end: PRODUCTION_REQUEST_MARKER.length,
            nonce: PRODUCTION_REQUEST_NONCE,
        }])
        expect(findSlotNodes(PRODUCTION_SLOT_NODE)).toEqual([{
            start: 0,
            end: PRODUCTION_SLOT_NODE.length,
            jobId: PRODUCTION_JOB_ID,
            slotToken: PRODUCTION_SLOT_TOKEN,
        }])

        const parserSupersetMarker = buildRequestMarker('nonce_ABC-123')
        const parserSupersetSlot = buildSlotNode('job_test-A', 'token_test-B')
        expect(findRequestMarkers(parserSupersetMarker)).toHaveLength(1)
        expect(findSlotNodes(parserSupersetSlot)).toHaveLength(1)
        expect('nonce_ABC-123').not.toMatch(PRODUCTION_REQUEST_NONCE_RE)
        expect('job_test-A').not.toMatch(PRODUCTION_JOB_ID_RE)

        expect(findSlotNodes(
            '<risu-illustration-slot data-job="job" data-v="1" data-token="token"></risu-illustration-slot>',
        )).toEqual([])
        expect(findSlotNodes(
            '<risu-illustration-slot data-v="1" data-job="job" data-token="token">',
        )).toEqual([])
    })

    // §5 shared fixture: every Core state is pinned to terminal/dashboard/prune semantics.
    test('pins the complete job-state terminal and dashboard-outstanding table', () => {
        const states = Object.keys(JOB_TRANSITIONS) as Array<keyof typeof JOB_STATE_ACCEPTANCE>
        expect(Object.keys(JOB_STATE_ACCEPTANCE)).toEqual(states)
        for (const state of states) {
            const classification = JOB_STATE_ACCEPTANCE[state]
            expect(isTerminalJobState(state), `${state} terminal`).toBe(classification.terminal)
            expect(isPrunableJobState(state), `${state} prunable`).toBe(classification.prunable)
            expect(
                !classification.terminal || state === 'uncertain',
                `${state} dashboard outstanding`,
            ).toBe(classification.dashboardOutstanding)
        }
        expect(JOB_STATE_ACCEPTANCE.agent_blocked.dashboardOutstanding).toBe(true)
        expect(JOB_STATE_ACCEPTANCE.agent_blocked_retryable.dashboardOutstanding).toBe(true)
        expect(JOB_STATE_ACCEPTANCE.uncertain).toEqual({
            terminal: true,
            dashboardOutstanding: true,
            prunable: false,
        })
    })

    // §5 shared fixture: the requesting project's current production identity is the Core pin.
    test('pins the production plugin name and current script digest through authorization', async () => {
        expect(PRODUCTION_PLUGIN.name).toBe(ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME)
        expect(PINNED_ILLUSTRATION_PLUGIN_DIGESTS).toContain(PRODUCTION_PLUGIN.scriptSha256Next)
        await expect(evaluateIllustrationV3Authorization({
            pluginName: PRODUCTION_PLUGIN.name,
            pluginScript: 'captured production script bytes',
            apiVersion: '3.0',
            persistedPluginNames: [PRODUCTION_PLUGIN.name],
        }, PINNED_ILLUSTRATION_PLUGIN_DIGESTS, async () => PRODUCTION_PLUGIN.scriptSha256Next))
            .resolves.toEqual({
                pluginName: PRODUCTION_PLUGIN.name,
                scriptDigest: PRODUCTION_PLUGIN.scriptSha256Next,
                apiVersion: '3.0',
            })
    })

    // 0.2.6 prompt-dialect flat profiles repin: the [terminal-close UX 0.2.6,
    // prompt-dialect 0.2.6] rotation window authorizes both releases while every
    // rejected digest — retired, unapproved, discarded, removed, or displaced —
    // never authorizes.
    test('pins the 0.2.6 manual capture UX rotation window and rejects every superseded digest', async () => {
        expect(PINNED_ILLUSTRATION_PLUGIN_DIGESTS).toEqual([
            PRODUCTION_PLUGIN.scriptSha256,
            PRODUCTION_PLUGIN.scriptSha256Next,
        ])
        expect(REJECTED_PLUGIN_SHA256S).toHaveLength(14)
        expect(new Set(REJECTED_PLUGIN_SHA256S).size).toBe(REJECTED_PLUGIN_SHA256S.length)

        const authorize = (digest: string) => evaluateIllustrationV3Authorization({
            pluginName: PRODUCTION_PLUGIN.name,
            pluginScript: 'captured production script bytes',
            apiVersion: '3.0',
            persistedPluginNames: [PRODUCTION_PLUGIN.name],
        }, PINNED_ILLUSTRATION_PLUGIN_DIGESTS, async () => digest)

        await expect(authorize(PRODUCTION_PLUGIN.scriptSha256Next)).resolves.toMatchObject({
            scriptDigest: PRODUCTION_PLUGIN.scriptSha256Next,
        })
        await expect(authorize(PRODUCTION_PLUGIN.scriptSha256)).resolves.toMatchObject({
            scriptDigest: PRODUCTION_PLUGIN.scriptSha256,
        })
        for (const rejected of REJECTED_PLUGIN_SHA256S) {
            expect(rejected).toMatch(/^[0-9a-f]{64}$/)
            expect(PINNED_ILLUSTRATION_PLUGIN_DIGESTS).not.toContain(rejected)
            await expect(authorize(rejected)).resolves.toBeNull()
        }
    })

    // Repin acceptance 6: through the production WebCrypto hash path against the real
    // pin array, candidates whose bytes differ from a pinned release (including by a
    // single character) hash to unpinned digests and never authorize.
    test('rejects byte-different candidates through the real hashing path', async () => {
        const authorize = (script: string) => authorizeIllustrationV3Plugin({
            pluginName: PRODUCTION_PLUGIN.name,
            pluginScript: script,
            apiVersion: '3.0',
            persistedPluginNames: [PRODUCTION_PLUGIN.name],
        })
        await expect(authorize('not the pinned production bundle')).resolves.toBeNull()
        await expect(authorize('not the pinned production bundle.')).resolves.toBeNull()
    })
})
