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
    // 0.2.2 role-compat recovery release bundle (239,175 bytes) — kept as the rollback window.
    scriptSha256: '2c1af1a7032999b9f0bad10d50fb6b80006bf1eb4e859d8deb987629eb4896f9',
    // 0.2.3 plugin-model/bulk-discard release bundle (244,854 bytes) — digest independently
    // recomputed from the root and dist bundles on 2026-07-18 during the repin request.
    scriptSha256Next: 'd9dfc5ab4d0dc0e7691347de56958310232e42cf05bb8dd6296a129f94cfd121',
})

// Digests that must NEVER authorize: releases removed from the rotation window,
// unapproved intermediates, and discarded draft candidates.
export const REJECTED_PLUGIN_SHA256S = Object.freeze([
    // 0.1.1 release (99,782 bytes), retired from the window on 2026-07-17.
    '12f76fef5047b9d161e5d8b4efe87c1f7dcff2d7a2f16a99f693c98c7d450ea7',
    // The unapproved intermediate 0.1.2 candidate.
    'c1a16920a71e39e090cf36905c93ee8315992125598c7b87aa8be39633f69c79',
    // 0.1.3 release (100,883 bytes), removed from the window in the 0.2.1 hotfix rotation.
    '126a7acf58368c102023d3f1e4489599a14e603ba922cad609d0cfb39744679b',
    // The discarded pre-contract 0.2.0 snapshot (HOLD per
    // REQUEST_RISU_ILLUSTRATION_AGENT_CORE_REPIN_0.2.0_2026-07-16).
    'ec56b4ad2e5397d0e6d4557420a69905983a80f6c16df5d34aceeea6f23f91a8',
    // The two discarded 0.2.1 interim drafts (superseded by the final 0.2.1 bundle
    // after the Event.currentTarget lifetime post-review).
    'db61c5961d950d2f9daea8417da0e6ed6e1ca81998d15f4e9786fdda50282e8b',
    '82f1b65d7f2c2ec99608b8ba0f62c00e79e668452dfc75d838afa71f18939deb',
    // 0.2.0 post-contract release (222,921 bytes), removed from the window in the
    // 0.2.2 role-compat recovery rotation.
    '367cfd2ce589de20568b9633383e9a10ab60fdaa8a0a33048ad91ef8acfa26ad',
    // 0.2.1 UI hotfix release (225,493 bytes), removed from the window in the
    // 0.2.3 plugin-model/bulk-discard rotation.
    'e5c096feb70b063543464cb0976c7cc1fe06d537850aa61a642d5a86e08f1479',
])

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
