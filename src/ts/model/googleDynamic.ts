import { getDatabase } from "../storage/database.svelte"
import type { ModelGridItem } from "./modelGrid"

export type GoogleDynamicModelInfo = {
    id: string
    name: string
    displayName: string
    inputTokenLimit: number
    outputTokenLimit: number
}

export async function getGoogleDynamicModels(): Promise<GoogleDynamicModelInfo[]> {
    try {
        const db = getDatabase()
        const key = db.google?.accessToken
        if (!key) return []

        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=1000`)
        if (!res.ok) return []
        const data = await res.json()

        return (data.models ?? [])
            .filter((m: any) =>
                m.supportedGenerationMethods?.includes('generateContent')
            )
            .map((m: any) => {
                const id = m.name?.startsWith('models/') ? m.name.replace('models/', '') : m.name
                return {
                    id,
                    name: m.name ?? id,
                    displayName: m.displayName ?? id,
                    inputTokenLimit: m.inputTokenLimit ?? 0,
                    outputTokenLimit: m.outputTokenLimit ?? 0,
                }
            })
            .sort((a: GoogleDynamicModelInfo, b: GoogleDynamicModelInfo) => a.displayName.localeCompare(b.displayName))
    } catch {
        return []
    }
}

export function toModelGridItem(m: GoogleDynamicModelInfo): ModelGridItem {
    const prices: { label: string; value: string }[] = []
    if (m.inputTokenLimit) prices.push({ label: 'Context', value: `${(m.inputTokenLimit / 1000).toFixed(0)}K` })
    if (m.outputTokenLimit) prices.push({ label: 'Output', value: `${(m.outputTokenLimit / 1000).toFixed(0)}K` })

    return {
        id: m.id,
        displayName: m.displayName,
        providerName: 'Google',
        description: '',
        context_length: m.inputTokenLimit,
        sortPrice: 0,
        prices,
    }
}
