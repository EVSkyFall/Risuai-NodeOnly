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
    // Previous release — kept as the rollback window.
    scriptSha256: '1578cb779e8cbee2f9ecf43fa9dddb3672432918408eb7b8ade7191c0e5e8079',
    // 0.2.6 five-second coordinator wait release bundle (280,739 bytes) — digest independently
    // recomputed from the root and dist bundles on 2026-07-20 by scripts/rotate-illustration-pin.mjs.
    scriptSha256Next: '99128d84fce3039271bcb9b78ad1e3e13927ddc11859299aa3c24f01c477af53',
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
    // 0.2.2 role-compat recovery release (239,175 bytes), removed from the window in the
    // 0.2.4 validation/submission stability rotation.
    '2c1af1a7032999b9f0bad10d50fb6b80006bf1eb4e859d8deb987629eb4896f9',
    // 0.2.3 plugin-model/bulk-discard release (244,854 bytes), removed from the window
    // in the 0.2.5 JSON/poll stability rotation.
    'd9dfc5ab4d0dc0e7691347de56958310232e42cf05bb8dd6296a129f94cfd121',
    // 0.2.4 validation/submission stability release (251,906 bytes), removed from the
    // window in the 0.2.6 sticky-incident/JSON-envelope rotation.
    '97b5f09b6512317a172937fabdb8765c5d07d1087bf1deb7a6ba5ca1dce7742b',
    // Displaced from the rotation window by the 0.2.6 terminal-close UX hotfix rotation (2026-07-19,
    // scripts/rotate-illustration-pin.mjs).
    '31e284ab4d55a65c9043ece4de59ff0f9489b2b683d4c528a99510d75e5b0ed7',
    // Displaced from the rotation window by the 0.2.6 prompt-dialect flat profiles rotation (2026-07-19,
    // scripts/rotate-illustration-pin.mjs).
    '86eaa7e163e87d2f6c5547d510e419ffa7acaf632bd29e678400748e3f0c8438',
    // Displaced from the rotation window by the 0.2.6 manual capture UX rotation (2026-07-20,
    // scripts/rotate-illustration-pin.mjs).
    '3249d4ef850d765369e55dd014cee0a10426a64150688ba1ffead8904bbbdaae',
    // Displaced from the rotation window by the 0.2.6 coordinator-safe manual capture rotation (2026-07-20,
    // scripts/rotate-illustration-pin.mjs).
    '987586f7297b56f767acee718e7f2f6525d86c677b91d64ab14691f9ebe48ba5',
    // Displaced from the rotation window by the 0.2.6 terminal-close copy rotation (2026-07-20,
    // scripts/rotate-illustration-pin.mjs).
    'fb3902e646bd787c6f35f455a9725f044d89d9d0a0dbcafda21c9d2096c6ec6c',
    // Displaced from the rotation window by the 0.2.6 five-second coordinator wait rotation (2026-07-20,
    // scripts/rotate-illustration-pin.mjs).
    'ee55f45bca5cfa63a43739b9bf6c9b3b08bcb8169c49dbfb3c3aa2bed2b53992',
])

export type JobStateAcceptanceClassification = Readonly<{
    terminal: boolean
    dashboardOutstanding: boolean
    prunable: boolean
}>

export const JOB_STATE_ACCEPTANCE = Object.freeze({
    prepared: { terminal: false, dashboardOutstanding: true, prunable: false },
    awaiting_prompt: { terminal: false, dashboardOutstanding: true, prunable: false },
    // Image Revision V1: a retag child awaiting the forced image-charge confirmation.
    prompt_ready: { terminal: false, dashboardOutstanding: true, prunable: false },
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
