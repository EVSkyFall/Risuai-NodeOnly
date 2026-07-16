import type { IllustrationJobState } from '../../types'

export const PRODUCTION_REQUEST_NONCE = '0123456789abcdef0123456789abcdef'
export const PRODUCTION_JOB_ID = 'job_0123456789abcdef0123456789abcdef'
export const PRODUCTION_SLOT_TOKEN = 'fedcba9876543210fedcba9876543210'

export const PRODUCTION_REQUEST_MARKER =
    '<!--risu-illustration-request:v1:0123456789abcdef0123456789abcdef-->'
export const PRODUCTION_SLOT_NODE =
    '<risu-illustration-slot data-v="1" data-job="job_0123456789abcdef0123456789abcdef" data-token="fedcba9876543210fedcba9876543210"></risu-illustration-slot>'

export const PRODUCTION_REQUEST_NONCE_RE = /^[0-9a-f]{32}$/
export const PRODUCTION_JOB_ID_RE = /^job_[0-9a-f]{32}$/
export const PRODUCTION_SLOT_TOKEN_RE = /^[0-9a-f]{32}$/

export const PRODUCTION_PLUGIN = Object.freeze({
    name: 'lb_xnai_agent',
    // 0.1.1 release bundle (99,782 bytes).
    scriptSha256: '12f76fef5047b9d161e5d8b4efe87c1f7dcff2d7a2f16a99f693c98c7d450ea7',
    // 0.1.3 release bundle (100,883 bytes) — digest independently recomputed
    // from the bundle on 2026-07-16 during the repin request.
    scriptSha256Next: '126a7acf58368c102023d3f1e4489599a14e603ba922cad609d0cfb39744679b',
})

// The unapproved intermediate 0.1.2 candidate — must NEVER authorize.
export const REJECTED_INTERMEDIATE_PLUGIN_SHA256 =
    'c1a16920a71e39e090cf36905c93ee8315992125598c7b87aa8be39633f69c79'

export type JobStateAcceptanceClassification = Readonly<{
    terminal: boolean
    dashboardOutstanding: boolean
    prunable: boolean
}>

export const JOB_STATE_ACCEPTANCE = Object.freeze({
    prepared: { terminal: false, dashboardOutstanding: true, prunable: false },
    awaiting_prompt: { terminal: false, dashboardOutstanding: true, prunable: false },
    agent_blocked_retryable: { terminal: false, dashboardOutstanding: true, prunable: false },
    agent_blocked: { terminal: false, dashboardOutstanding: true, prunable: false },
    queued: { terminal: false, dashboardOutstanding: true, prunable: false },
    generating: { terminal: false, dashboardOutstanding: true, prunable: false },
    cancel_requested: { terminal: false, dashboardOutstanding: true, prunable: false },
    blocked_config: { terminal: false, dashboardOutstanding: true, prunable: false },
    asset_writing: { terminal: false, dashboardOutstanding: true, prunable: false },
    asset_ready: { terminal: false, dashboardOutstanding: true, prunable: false },
    committing: { terminal: false, dashboardOutstanding: true, prunable: false },
    committed: { terminal: true, dashboardOutstanding: false, prunable: true },
    failed: { terminal: true, dashboardOutstanding: false, prunable: true },
    stale: { terminal: true, dashboardOutstanding: false, prunable: true },
    uncertain: { terminal: true, dashboardOutstanding: true, prunable: false },
    cancelled: { terminal: true, dashboardOutstanding: false, prunable: true },
    corrupt: { terminal: true, dashboardOutstanding: false, prunable: true },
} as const satisfies Readonly<Record<IllustrationJobState, JobStateAcceptanceClassification>>)
