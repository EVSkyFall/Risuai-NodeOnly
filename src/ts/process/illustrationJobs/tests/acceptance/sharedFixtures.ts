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
    // 0.1.3 release bundle (100,883 bytes) — kept as the rollback window.
    scriptSha256: '126a7acf58368c102023d3f1e4489599a14e603ba922cad609d0cfb39744679b',
    // 0.2.0 post-contract release bundle (222,921 bytes) — digest independently
    // recomputed from the bundle on 2026-07-17 during the post-contract repin request.
    scriptSha256Next: '367cfd2ce589de20568b9633383e9a10ab60fdaa8a0a33048ad91ef8acfa26ad',
})

// The unapproved intermediate 0.1.2 candidate — must NEVER authorize.
export const REJECTED_INTERMEDIATE_PLUGIN_SHA256 =
    'c1a16920a71e39e090cf36905c93ee8315992125598c7b87aa8be39633f69c79'

// The 0.1.1 release digest (99,782 bytes), retired from the rotation window on
// 2026-07-17 — must no longer authorize.
export const REJECTED_RETIRED_0_1_1_PLUGIN_SHA256 =
    '12f76fef5047b9d161e5d8b4efe87c1f7dcff2d7a2f16a99f693c98c7d450ea7'

// The discarded pre-contract 0.2.0 snapshot digest (HOLD per
// REQUEST_RISU_ILLUSTRATION_AGENT_CORE_REPIN_0.2.0_2026-07-16) — must NEVER authorize.
export const REJECTED_PRE_CONTRACT_0_2_0_PLUGIN_SHA256 =
    'ec56b4ad2e5397d0e6d4557420a69905983a80f6c16df5d34aceeea6f23f91a8'

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
