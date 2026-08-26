import { writable } from "svelte/store"

export const PATREON_URL = 'https://www.patreon.com/PocketRisu'
export const UPSTREAM_PATREON_URL = 'https://www.patreon.com/RisuAI'

export interface SupporterTier {
    id: string
    title: string
    amountCents: number
}

export interface Supporter {
    name: string
    status: 'active' | 'former'
    tierId: string | null
    /** Number of cumulative-support thresholds reached (index into `buckets`). */
    bucket: number
    since: string | null
}

export interface SupportersData {
    updatedAt: string | null
    tiers: SupporterTier[]
    buckets: number[]
    supporters: Supporter[]
    /** Worker URL that starts the Patreon-login name registration flow. */
    nameUrl?: string
    disabled?: boolean
}

/** Shared open state — sidebar banner and settings menu both toggle this. */
export const supportDialogOpen = writable(false)

export async function fetchSupporters(): Promise<SupportersData> {
    const res = await fetch('/api/supporters')
    if (!res.ok) throw new Error(`supporters ${res.status}`)
    return await res.json()
}
