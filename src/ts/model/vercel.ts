import { getDatabase } from "../storage/database.svelte"
import type { ModelGridItem } from "./modelGrid"

export type PriceEntry = number | undefined

export type VercelModelInfo = {
    id: string
    name: string
    cleanName: string
    provider: string
    price: number
    priceDisplay: string
    context_length: number
    max_tokens: number
    description: string
    tags: string[]
    promptPrice1M: PriceEntry
    completionPrice1M: PriceEntry
    cacheReadPrice1M: PriceEntry
    cacheWritePrice1M: PriceEntry
    internalReasoningPrice1M: PriceEntry
}

export async function getVercelModels(): Promise<VercelModelInfo[]> {
    try {
        const res = await fetch("https://ai-gateway.vercel.sh/v1/models")
        const aim = await res.json()

        return aim.data
            .filter((model: any) => model.type === 'language')
            .map((model: any) => {
                const promptRaw = Number(model.pricing?.input ?? 0)
                const completionRaw = Number(model.pricing?.output ?? 0)
                const price = ((promptRaw * 3) + completionRaw) / 4
                const priceDisplay = price > 0 ? `$${(price * 1_000_000).toFixed(2)}/1M` : 'Free'

                const slashIdx = model.id.indexOf('/')
                const provider = slashIdx !== -1 ? model.id.slice(0, slashIdx) : 'unknown'
                const cleanName = model.name || (slashIdx !== -1 ? model.id.slice(slashIdx + 1) : model.id)

                const toPrice1M = (raw: any): PriceEntry => {
                    const n = Number(raw)
                    return (raw !== undefined && raw !== null && raw !== '' && !isNaN(n) && n > 0) ? n * 1_000_000 : undefined
                }

                return {
                    id: model.id,
                    name: model.name || model.id,
                    cleanName,
                    provider,
                    price,
                    priceDisplay,
                    context_length: model.context_window ?? 0,
                    max_tokens: model.max_tokens ?? 0,
                    description: model.description ?? '',
                    tags: model.tags ?? [],
                    promptPrice1M: toPrice1M(model.pricing?.input),
                    completionPrice1M: toPrice1M(model.pricing?.output),
                    cacheReadPrice1M: toPrice1M(model.pricing?.input_cache_read),
                    cacheWritePrice1M: toPrice1M(model.pricing?.input_cache_write),
                    internalReasoningPrice1M: toPrice1M(model.pricing?.internal_reasoning),
                }
            })
            .sort((a: VercelModelInfo, b: VercelModelInfo) => a.price - b.price)
    } catch (error) {
        return []
    }
}

export function toModelGridItem(m: VercelModelInfo): ModelGridItem {
    const fmt = (p: PriceEntry): string | null => {
        if (p === undefined) return null
        if (p === 0) return 'Free'
        return `$${p.toFixed(2)}`
    }

    const prices: { label: string; value: string }[] = []
    const pairs: [string, PriceEntry][] = [
        ['In',        m.promptPrice1M],
        ['Out',       m.completionPrice1M],
        ['Cache In',  m.cacheReadPrice1M],
        ['Cache Out', m.cacheWritePrice1M],
        ['Reasoning', m.internalReasoningPrice1M],
    ]
    for (const [label, p] of pairs) {
        const v = fmt(p)
        if (v !== null) prices.push({ label, value: v })
    }

    return {
        id: m.id,
        displayName: m.cleanName,
        providerName: m.provider,
        description: m.description,
        context_length: m.context_length,
        sortPrice: m.price,
        prices,
    }
}
