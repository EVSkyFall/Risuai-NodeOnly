import { getDatabase } from "../storage/database.svelte"
import type { ModelGridItem } from "./modelGrid"

export type OpenAIDynamicModelInfo = {
    id: string
    name: string
    owned_by: string
}

export async function getOpenAIDynamicModels(): Promise<OpenAIDynamicModelInfo[]> {
    try {
        const db = getDatabase()
        if (!db.openAIKey) return []

        const res = await fetch("https://api.openai.com/v1/models", {
            headers: { "Authorization": "Bearer " + db.openAIKey }
        })
        if (!res.ok) return []
        const data = await res.json()

        return (data.data ?? [])
            .filter((m: any) => {
                const id: string = m.id ?? ''
                return id.startsWith('gpt') || id.startsWith('o') || id.startsWith('chat')
            })
            .map((m: any) => ({
                id: m.id,
                name: m.id,
                owned_by: m.owned_by ?? 'openai',
            }))
            .sort((a: OpenAIDynamicModelInfo, b: OpenAIDynamicModelInfo) => a.id.localeCompare(b.id))
    } catch {
        return []
    }
}

export function toModelGridItem(m: OpenAIDynamicModelInfo): ModelGridItem {
    return {
        id: m.id,
        displayName: m.id,
        providerName: m.owned_by,
        description: '',
        context_length: 0,
        sortPrice: 0,
        prices: [],
    }
}
