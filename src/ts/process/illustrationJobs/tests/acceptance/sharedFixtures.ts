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
    scriptSha256: '12f76fef5047b9d161e5d8b4efe87c1f7dcff2d7a2f16a99f693c98c7d450ea7',
})

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
