import type { Tiktoken } from "@dqbd/tiktoken";
import type { Tokenizer } from "@mlc-ai/web-tokenizers";
import { type character, type Chat, getCurrentCharacter, getDatabase } from "./storage/database.svelte";
import type { MultiModal, OpenAIChat } from "./process/index.svelte";
import { supportsInlayImage } from "./process/files/inlays";
import { risuChatParser } from "./parser/parser.svelte";
import { tokenizeGGUFModel } from "./process/models/local";
import { globalFetch, fetchViaProxy2 } from "./globalApi.svelte";
import { getModelInfo, LLMTokenizer, type LLMModel } from "./model/modellist";
import { pluginV2 } from "./plugins/plugins.svelte";
import type { GemmaTokenizer } from "@huggingface/transformers";
import { LRUMap } from 'mnemonist';
import { makeHashedStorageKey, readPersistentJson, writePersistentJson } from "./storage/persistentKv";

const MAX_CACHE_SIZE = 1500;

const encodeCache = new LRUMap<string, number[] | Uint32Array | Int32Array>(MAX_CACHE_SIZE);

// ─── Claude tokenizer: API-backed with per-language adaptive fallback ───────
//
// Strategy:
//  1. text < MIN_API_LEN → use bundled claude.json directly (overhead not worth API call)
//  2. persistent cache hit → return stored API count
//  3. API call → cache, learn per-language factor, return
//  4. on rate-limit / network failure → use claude.json × per-language factor
//
// Languages detected: 'ko' (hangul ≥15%), 'jp' (kana ≥5%), 'en' (default).
// CJK-only ambiguous text falls into 'en' since Han alone can't disambiguate JP/ZH.

type ClaudeLang = 'ko' | 'en' | 'jp'

const MIN_API_LEN = 50
const PERSISTENT_KEY = 'claude_token_cache.json'
const PERSISTENT_FLUSH_DELAY_MS = 5000
// Tier-2 Anthropic limit is 2000 RPM (~33 RPS). With ~0.5–1.5s per call this
// supports 30 concurrent without saturating. If you upgrade tiers, raise this.
const MAX_API_CONCURRENT = 30
// How long an over-the-limit call should wait for a free slot before giving
// up and falling back to the local tokenizer estimate.
const SLOT_WAIT_TIMEOUT_MS = 30_000
const MESSAGE_OVERHEAD = 12 // tokens contributed by `[{role:user, content:""}]` wrapping

function detectLang(text: string): ClaudeLang {
    let hangul = 0, kana = 0, total = 0
    const sample = text.length > 2000 ? text.slice(0, 2000) : text
    for (let i = 0; i < sample.length; i++) {
        const code = sample.charCodeAt(i)
        if (code >= 0x3041 && code <= 0x30FF) kana++
        else if (code >= 0xAC00 && code <= 0xD7A3) hangul++
        if (code > 32) total++
    }
    if (total === 0) return 'en'
    if (hangul / total > 0.15) return 'ko'
    if (kana / total > 0.05) return 'jp'
    return 'en'
}

function getLangFactor(db: any, lang: ClaudeLang): number {
    const f = lang === 'ko' ? db.claudeTokenizerFactorKO
        : lang === 'jp' ? db.claudeTokenizerFactorJP
        : db.claudeTokenizerFactorEN
    if (!f || !isFinite(f) || f <= 0) return 1.0
    return f
}

function setLangFactor(db: any, lang: ClaudeLang, value: number, samplesIncrement: number): void {
    const v = Number(value.toFixed(4))
    if (lang === 'ko') {
        db.claudeTokenizerFactorKO = v
        db.claudeTokenizerFactorSamplesKO = (db.claudeTokenizerFactorSamplesKO ?? 0) + samplesIncrement
    } else if (lang === 'jp') {
        db.claudeTokenizerFactorJP = v
        db.claudeTokenizerFactorSamplesJP = (db.claudeTokenizerFactorSamplesJP ?? 0) + samplesIncrement
    } else {
        db.claudeTokenizerFactorEN = v
        db.claudeTokenizerFactorSamplesEN = (db.claudeTokenizerFactorSamplesEN ?? 0) + samplesIncrement
    }
}

function updateLangFactorEMA(db: any, lang: ClaudeLang, observedRatio: number): void {
    const samples = (lang === 'ko' ? db.claudeTokenizerFactorSamplesKO
        : lang === 'jp' ? db.claudeTokenizerFactorSamplesJP
        : db.claudeTokenizerFactorSamplesEN) ?? 0
    const oldFactor = getLangFactor(db, lang)
    const clamped = Math.max(0.3, Math.min(3.0, observedRatio))
    // First 5 samples: replace (fast convergence). After: EMA weight 0.2.
    const newFactor = samples < 5 ? clamped : (oldFactor * 0.8 + clamped * 0.2)
    setLangFactor(db, lang, newFactor, 1)
}

// ─── Persistent cache (text hash → API count) ──────────────────────────────
const persistentCache = new Map<string, number>()
let persistentCacheLoaded = false
let persistentCacheLoadPromise: Promise<void> | null = null
let persistentCacheDirty = false
let persistentSaveTimer: ReturnType<typeof setTimeout> | null = null

async function loadPersistentCache(): Promise<void> {
    if (persistentCacheLoaded) return
    if (!persistentCacheLoadPromise) {
        persistentCacheLoadPromise = (async () => {
            try {
                const data = await readPersistentJson<Record<string, number>>(PERSISTENT_KEY)
                if (data) {
                    for (const [k, v] of Object.entries(data)) persistentCache.set(k, v)
                }
            } catch (_e) { /* silent */ }
            persistentCacheLoaded = true
        })()
    }
    return persistentCacheLoadPromise
}

function schedulePersistentSave(): void {
    persistentCacheDirty = true
    if (persistentSaveTimer) return
    persistentSaveTimer = setTimeout(async () => {
        persistentSaveTimer = null
        if (!persistentCacheDirty) return
        persistentCacheDirty = false
        try {
            const obj: Record<string, number> = {}
            for (const [k, v] of persistentCache) obj[k] = v
            await writePersistentJson(PERSISTENT_KEY, obj)
        } catch (_e) { /* silent */ }
    }, PERSISTENT_FLUSH_DELAY_MS)
}

function persistentKey(text: string): string {
    // djb2 + length suffix; cheap collision-resistant for small store
    let h = 5381
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) | 0
    return `${text.length}:${(h >>> 0).toString(36)}`
}

export async function clearClaudeTokenizerPersistentCache(): Promise<void> {
    persistentCache.clear()
    persistentCacheDirty = true
    schedulePersistentSave()
}

export function getClaudeTokenizerPersistentCacheSize(): number {
    return persistentCache.size
}

// ─── API call layer with concurrency + rate-limit handling ─────────────────
let rateLimitedUntil = 0
let inflightCount = 0

// FIFO slot queue: when we exceed MAX_API_CONCURRENT, callers wait for a
// running call to release. This lets large cold-start bursts (re-tokenizing
// 1000+ messages after a cache invalidation) saturate the API instead of
// falling through to the local estimate after the first 30 calls.
type SlotWaiter = (granted: boolean) => void
const slotWaiters: SlotWaiter[] = []

async function acquireSlot(timeoutMs: number): Promise<boolean> {
    if (inflightCount < MAX_API_CONCURRENT) {
        inflightCount++
        return true
    }
    return new Promise<boolean>((resolve) => {
        let done = false
        const w: SlotWaiter = (granted) => {
            if (done) return
            done = true
            clearTimeout(timer)
            if (granted) inflightCount++
            resolve(granted)
        }
        const timer = setTimeout(() => {
            if (done) return
            done = true
            const idx = slotWaiters.indexOf(w)
            if (idx >= 0) slotWaiters.splice(idx, 1)
            resolve(false)
        }, timeoutMs)
        slotWaiters.push(w)
    })
}

function releaseSlot(): void {
    if (slotWaiters.length > 0) {
        const w = slotWaiters.shift()!
        // Transfer the slot directly to the next waiter — w() will increment
        // inflightCount itself, so we skip the decrement on this release.
        w(true)
    } else {
        inflightCount--
    }
}

async function callCountTokensAPI(text: string, db: any): Promise<number | null> {
    if (Date.now() < rateLimitedUntil) return null
    const key = (db.claudeTokenizerAPIKey || '').trim()
    if (!key) return null
    // Normalize model id for Anthropic API: Copilot accepts "claude-opus-4.7" but
    // Anthropic only accepts "claude-opus-4-7" (hyphen). Convert version dots to dashes.
    const model = (db.claudeTokenizerAPIModel || 'claude-opus-4-7').replace(/(opus|sonnet|haiku)-(\d+)\.(\d+)/g, '$1-$2-$3')

    if (!(await acquireSlot(SLOT_WAIT_TIMEOUT_MS))) return null
    try {
        // Route through proxy2 — browser-direct fetch to api.anthropic.com fails CORS preflight.
        const bodyBytes = new TextEncoder().encode(JSON.stringify({
            model,
            messages: [{ role: 'user', content: text }],
        }))
        const resp = await fetchViaProxy2(
            'https://api.anthropic.com/v1/messages/count_tokens',
            {
                'x-api-key': key,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            bodyBytes,
            { method: 'POST' }
        )
        if (resp.status === 429) {
            const retryAfter = parseInt(resp.headers.get('retry-after') || '60', 10) || 60
            rateLimitedUntil = Date.now() + retryAfter * 1000
            console.warn(`[ClaudeTokAPI] 429 rate limit; backing off ${retryAfter}s`)
            return null
        }
        if (!resp.ok) return null
        const data = await resp.json()
        const real = (data?.input_tokens ?? 0) - MESSAGE_OVERHEAD
        return real > 0 ? real : null
    } catch (_e) {
        return null
    } finally {
        releaseSlot()
    }
}

/**
 * Main entry: tokenize text using Claude tokenizer, with API/cache/fallback layers.
 * Returns a Uint32Array whose `length` equals the estimated token count.
 */
async function tokenizeClaudeWithAPI(text: string): Promise<Uint32Array> {
    const db = getDatabase()
    if (!text) return new Uint32Array(0)

    if (text.length < MIN_API_LEN) {
        return new Uint32Array((await tokenizeWebTokenizers(text, 'claude')).length)
    }

    if (!db.claudeTokenizerAPIEnabled || !(db.claudeTokenizerAPIKey || '').trim()) {
        // API mode off → local + per-language factor
        const local = await tokenizeWebTokenizers(text, 'claude')
        const lang = detectLang(text)
        const factor = getLangFactor(db, lang)
        return new Uint32Array(Math.max(0, Math.round(local.length * factor)))
    }

    await loadPersistentCache()
    const pKey = persistentKey(text)
    const cached = persistentCache.get(pKey)
    if (cached !== undefined) return new Uint32Array(cached)

    const apiCount = await callCountTokensAPI(text, db)
    if (apiCount !== null) {
        persistentCache.set(pKey, apiCount)
        schedulePersistentSave()
        // Update per-language factor for offline/rate-limited fallback
        try {
            const local = await tokenizeWebTokenizers(text, 'claude')
            const lang = detectLang(text)
            if (local.length >= 30) {
                updateLangFactorEMA(db, lang, apiCount / local.length)
            }
        } catch (_e) { /* ignore */ }
        return new Uint32Array(apiCount)
    }

    // API rate-limited or failed → local + factor
    const local = await tokenizeWebTokenizers(text, 'claude')
    const lang = detectLang(text)
    const factor = getLangFactor(db, lang)
    return new Uint32Array(Math.max(0, Math.round(local.length * factor)))
}

function getHash(
    data: string,
    aiModel: string,
    customTokenizer: string,
    currentPluginProvider: string,
    googleClaudeTokenizing: boolean,
    modelInfo: LLMModel,
    pluginTokenizer: string,
    claudeAPIMode: string
): string {
    const combined = `${data}::${aiModel}::${customTokenizer}::${currentPluginProvider}::${googleClaudeTokenizing ? '1' : '0'}::${modelInfo.tokenizer}::${pluginTokenizer}::${claudeAPIMode}`;
    return combined;
}


export const tokenizerList = [
    ['tik', 'Tiktoken (OpenAI)'],
    ['mistral', 'Mistral'],
    ['novelai', 'NovelAI'],
    ['claude', 'Claude'],
    ['llama', 'Llama'],
    ['llama3', 'Llama3'],
    ['novellist', 'Novellist'],
    ['gemma', 'Gemma'],
    ['cohere', 'Cohere'],
    ['deepseek', 'DeepSeek'],
] as const

export async function encodeWithTokenizer(data: string, tokenizerType: string): Promise<(number[] | Uint32Array | Int32Array)> {
    switch (tokenizerType) {
        case 'tik':
            return await tikJS(data, 'cl100k_base');
        case 'mistral':
            return await tokenizeWebTokenizers(data, 'mistral');
        case 'novelai':
            return await tokenizeWebTokenizers(data, 'novelai');
        case 'claude':
            return await tokenizeClaudeWithAPI(data);
        case 'llama':
            return await tokenizeWebTokenizers(data, 'llama');
        case 'llama3':
            return await tokenizeWebTokenizers(data, 'llama3');
        case 'novellist':
            return await tokenizeWebTokenizers(data, 'novellist');
        case 'gemma':
            return await gemmaTokenize(data);
        case 'cohere':
            return await tokenizeWebTokenizers(data, 'cohere');
        case 'deepseek':
            return await tokenizeWebTokenizers(data, 'DeepSeek');
        default:
            return await tikJS(data, 'cl100k_base');
    }
}

export async function encode(data:string):Promise<(number[]|Uint32Array|Int32Array)>{
    const db = getDatabase();
    const modelInfo = getModelInfo(db.aiModel);
    const pluginTokenizer = pluginV2.providerOptions.get(db.currentPluginProvider)?.tokenizer ?? "none";

    let cacheKey = ''
    if(db.useTokenizerCaching){
        cacheKey = getHash(
            data,
            db.aiModel,
            db.customTokenizer,
            db.currentPluginProvider,
            db.googleClaudeTokenizing,
            modelInfo,
            pluginTokenizer,
            db.claudeTokenizerAPIEnabled ? 'api' : 'local'
        );
        const cachedResult = encodeCache.get(cacheKey);
        if (cachedResult !== undefined) {
            return cachedResult;
        }
    }

    let result: number[] | Uint32Array | Int32Array;

    if(db.aiModel === 'openrouter' || db.aiModel === 'reverse_proxy' || db.aiModel === 'vercel'){
        switch(db.customTokenizer){
            case 'mistral':
                result = await tokenizeWebTokenizers(data, 'mistral'); break;
            case 'llama':
                result = await tokenizeWebTokenizers(data, 'llama'); break;
            case 'novelai':
                result = await tokenizeWebTokenizers(data, 'novelai'); break;
            case 'claude':
                result = await tokenizeClaudeWithAPI(data); break;
            case 'novellist':
                result = await tokenizeWebTokenizers(data, 'novellist'); break;
            case 'llama3':
                result = await tokenizeWebTokenizers(data, 'llama'); break;
            case 'gemma':
                result = await gemmaTokenize(data); break;
            case 'cohere':
                result = await tokenizeWebTokenizers(data, 'cohere'); break;
            case 'deepseek':
                result = await tokenizeWebTokenizers(data, 'DeepSeek'); break;
            default:
                result = await tikJS(data, 'o200k_base'); break;
        }
    } else if (db.aiModel === 'custom' && pluginTokenizer) {
        switch(pluginTokenizer){
            case 'mistral':
                result = await tokenizeWebTokenizers(data, 'mistral'); break;
            case 'llama':
                result = await tokenizeWebTokenizers(data, 'llama'); break;
            case 'novelai':
                result = await tokenizeWebTokenizers(data, 'novelai'); break;
            case 'claude':
                result = await tokenizeClaudeWithAPI(data); break;
            case 'novellist':
                result = await tokenizeWebTokenizers(data, 'novellist'); break;
            case 'llama3':
                result = await tokenizeWebTokenizers(data, 'llama'); break;
            case 'gemma':
                result = await gemmaTokenize(data); break;
            case 'cohere':
                result = await tokenizeWebTokenizers(data, 'cohere'); break;
            case 'o200k_base':
                result = await tikJS(data, 'o200k_base'); break;
            case 'cl100k_base':
                result = await tikJS(data, 'cl100k_base'); break;
            case 'custom':
                result = await pluginV2.providerOptions.get(db.currentPluginProvider)?.tokenizerFunc?.(data) ?? [0]; break;
            default:
                result = await tikJS(data, 'o200k_base'); break; 
        }
    } 
    
    // Fallback
    if (result === undefined) {
        if(modelInfo.tokenizer === LLMTokenizer.NovelList){
            result = await tokenizeWebTokenizers(data, 'novellist');
        } else if(modelInfo.tokenizer === LLMTokenizer.Claude){
            result = await tokenizeClaudeWithAPI(data);
        } else if(modelInfo.tokenizer === LLMTokenizer.NovelAI){
            result = await tokenizeWebTokenizers(data, 'novelai');
        } else if(modelInfo.tokenizer === LLMTokenizer.Mistral){
            result = await tokenizeWebTokenizers(data, 'mistral');
        } else if(modelInfo.tokenizer === LLMTokenizer.Llama){
            result = await tokenizeWebTokenizers(data, 'llama');
        } else if(modelInfo.tokenizer === LLMTokenizer.Local){
            result = await tokenizeGGUFModel(data);
        } else if(modelInfo.tokenizer === LLMTokenizer.tiktokenO200Base){
            result = await tikJS(data, 'o200k_base');
        } else if(modelInfo.tokenizer === LLMTokenizer.GoogleCloud && db.googleClaudeTokenizing){
            result = await tokenizeGoogleCloud(data);
        } else if(modelInfo.tokenizer === LLMTokenizer.Gemma || modelInfo.tokenizer === LLMTokenizer.GoogleCloud){
            result = await gemmaTokenize(data);
        } else if(modelInfo.tokenizer === LLMTokenizer.DeepSeek){
            result = await tokenizeWebTokenizers(data, 'DeepSeek');
        } else if(modelInfo.tokenizer === LLMTokenizer.Cohere){
            result = await tokenizeWebTokenizers(data, 'cohere');
        } else {
            result = await tikJS(data);
        }
    }
    if(db.useTokenizerCaching){
        encodeCache.set(cacheKey, result);
    }

    return result;
}

type tokenizerType = 'novellist'|'claude'|'novelai'|'llama'|'mistral'|'llama3'|'gemma'|'cohere'|'googleCloud'|'DeepSeek'

let tikParser:Tiktoken = null
let tokenizersTokenizer:Tokenizer = null
let tokenizersType:tokenizerType = null
let lastTikModel = 'cl100k_base'

let googleCloudTokenizedCache = new Map<string, number>()

async function tokenizeGoogleCloud(text:string) {
    const db = getDatabase()
    const model = getModelInfo(db.aiModel)

    if(googleCloudTokenizedCache.has(text + model.internalID)){
        const count = googleCloudTokenizedCache.get(text + model.internalID)
        return new Uint32Array(count)
    }

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.internalID}:countTokens?key=${db.google?.accessToken}`, {
        method: 'POST',
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            contents: [{
                parts:[{
                    text: text
                }]
            }]
        }),
    })

    if(res.status !== 200){
        return await tokenizeWebTokenizers(text, 'gemma')
    }

    const json = await res.json()
    googleCloudTokenizedCache.set(text + model.internalID, json.totalTokens as number)
    const count = json.totalTokens as number

    return new Uint32Array(count)
}

let gemmaTokenizer:GemmaTokenizer = null
async function gemmaTokenize(text:string) {
    if(!gemmaTokenizer){
        const {GemmaTokenizer} = await import('@huggingface/transformers')
        gemmaTokenizer = new GemmaTokenizer(
            await (await fetch("/token/llama/llama3.json")
        ).json(), {})
    }
    return gemmaTokenizer.encode(text)
}

async function tikJS(text:string, model='cl100k_base') {
    if(!tikParser || lastTikModel !== model){
        tikParser?.free()
        if(model === 'cl100k_base'){
            const {Tiktoken} = await import('@dqbd/tiktoken')
            const cl100k_base = await import("@dqbd/tiktoken/encoders/cl100k_base.json");
            lastTikModel = model   
        
            tikParser = new Tiktoken(
                cl100k_base.bpe_ranks,
                cl100k_base.special_tokens,
                cl100k_base.pat_str
            );
        }
        if(model === 'o200k_base'){
            const {Tiktoken} = await import('@dqbd/tiktoken')
            const o200k_base = await import("src/etc/o200k_base.json");
            lastTikModel = model
            tikParser = new Tiktoken(
                o200k_base.bpe_ranks,
                o200k_base.special_tokens,
                o200k_base.pat_str
            );
        }
    }
    return tikParser.encode(text)
}

async function geminiTokenizer(text:string) {
    const db = getDatabase()
    const fetchResult = await globalFetch(`https://generativelanguage.googleapis.com/v1beta/${db.aiModel}:countTextTokens`, {
        "headers": {
            "content-type": "application/json",
            "authorization": `Bearer ${db.google.accessToken}`
        },
        "body": JSON.stringify({
            "prompt":{
                text: text
            }
        }),
        "method": "POST"
    })

    if(!fetchResult.ok){
        //fallback to tiktoken
        return await tikJS(text)
    }

    const result = fetchResult.data

    return result.tokenCount ?? 0
}

async function tokenizeWebTokenizers(text:string, type:tokenizerType) {
    if(type !== tokenizersType || !tokenizersTokenizer){
        const webTokenizer = await import('@mlc-ai/web-tokenizers')
        switch(type){
            case "novellist":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/trin/spiece.model")
                ).arrayBuffer())
                break
            case "claude":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/claude/claude.json")
                ).arrayBuffer())
                break
            case 'llama3':
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/llama/llama3.json")
                ).arrayBuffer())
                break
            case 'cohere':
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/cohere/tokenizer.json")
                ).arrayBuffer())
                break
            case 'novelai':
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/nai/nerdstash_v2.model")
                ).arrayBuffer())
                
                break
            case 'llama':
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/llama/llama.model")
                ).arrayBuffer())
                break
            case 'mistral':
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/mistral/tokenizer.model")
                ).arrayBuffer())
                break
            case 'gemma':
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/gemma/tokenizer.model")
                ).arrayBuffer())
                break
            case 'DeepSeek':
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/deepseek/tokenizer.json")
                ).arrayBuffer())
                break

        }
        tokenizersType = type
    }
    return (tokenizersTokenizer.encode(text))
}

export async function tokenizerChar(char:character) {
    const encoded = await encode(char.name + '\n' + char.firstMessage + '\n' + char.desc)
    return encoded.length
}

export async function tokenize(data:string) {
    const encoded = await encode(data)
    return encoded.length
}

export async function tokenizeAccurate(data:string | null | undefined, consistantChar?:boolean) {
    data = risuChatParser((data ?? '').replace('{{slot}}',''), {
        tokenizeAccurate: true,
        consistantChar: consistantChar,
    })
    const encoded = await encode(data)
    return encoded.length
}


export class ChatTokenizer {

    private chatAdditionalTokens:number
    private useName:'name'|'noName'

    constructor(chatAdditionalTokens:number, useName:'name'|'noName'){
        this.chatAdditionalTokens = chatAdditionalTokens
        this.useName = useName
    }
    async tokenizeChat(data:OpenAIChat, args:{
        countThoughts?:boolean,
    } = {}) {
        let encoded = (await encode(data.content)).length + this.chatAdditionalTokens
        if(data.name && this.useName ==='name'){
            encoded += (await encode(data.name)).length + 1
        }
        if(data.multimodals && data.multimodals.length > 0){
            for(const multimodal of data.multimodals){
                encoded += await this.tokenizeMultiModal(multimodal)
            }
        }
        if(data.thoughts && data.thoughts.length > 0 && args.countThoughts){
            for(const thought of data.thoughts){
                encoded += (await encode(thought)).length + 1
            }
        }
        return encoded
    }
    async tokenizeChats(data:OpenAIChat[]){
        let encoded = 0
        for(const chat of data){
            encoded += await this.tokenizeChat(chat)
        }
        return encoded
    }

    tokenizeMultiModal(data:MultiModal){
        const db = getDatabase()
        if(!supportsInlayImage()){
            return this.chatAdditionalTokens
        }
        if(db.gptVisionQuality === 'low'){
            return 87
        }

        let encoded = this.chatAdditionalTokens
        let height = data.height ?? 0
        let width = data.width ?? 0

        if(height === width){
            if(height > 768){
                height = 768
                width = 768
            }
        }
        else if(height > width){
            if(width > 768){
                width = 768
                height = height * (768 / width)
            }
        }
        else{
            if(height > 768){
                height = 768
                width = width * (768 / height)
            }
        }

        const chunkSize = Math.ceil(width / 512) * Math.ceil(height / 512)
        encoded += chunkSize * 2
        encoded += 85

        return encoded
    }
    
}

export async function tokenizeNum(data:string) {
    const encoded = await encode(data)
    return encoded
}

const strongBanCache = new Map<string, {[key:number]:number}>();
const strongBanCachePrefix = 'cache/strong-ban/';

async function getPersistedStrongBan(cacheKey: string) {
    if (strongBanCache.has(cacheKey)) {
        return strongBanCache.get(cacheKey)
    }
    const storageKey = await makeHashedStorageKey(strongBanCachePrefix, cacheKey)
    const payload = await readPersistentJson<{ key: string, value: {[key:number]:number} }>(storageKey)
    if (!payload || payload.key !== cacheKey) {
        return null
    }
    strongBanCache.set(cacheKey, payload.value)
    return payload.value
}

export async function strongBan(data:string, bias:{[key:number]:number}) {

    const cacheKey = 'strongBan_' + data
    const cached = await getPersistedStrongBan(cacheKey)
    if(cached){
        return cached
    }
    const performace = performance.now()
    const length = Object.keys(bias).length
    let charAlt = [
        data,
        data.trim(),
        data.toLocaleUpperCase(),
        data.toLocaleLowerCase(),
        data[0].toLocaleUpperCase() + data.slice(1),
        data[0].toLocaleLowerCase() + data.slice(1),
    ]

    let banChars = " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~“”‘’«»「」…–―※"
    let unbanChars:number[] = []

    for(const char of banChars){
        unbanChars.push((await tokenizeNum(char))[0])
    }



    for(const char of banChars){
        const encoded = await tokenizeNum(char)
        if(encoded.length > 0){
            if(!unbanChars.includes(encoded[0])){
                bias[encoded[0]] = -100
            }
        }
        for(const alt of charAlt){
            let fchar = char

            const encoded = await tokenizeNum(alt + fchar)
            if(encoded.length > 0){
                if(!unbanChars.includes(encoded[0])){
                    bias[encoded[0]] = -100
                }
            }
            const encoded2 = await tokenizeNum(fchar + alt)
            if(encoded2.length > 0){
                if(!unbanChars.includes(encoded2[0])){
                    bias[encoded2[0]] = -100
                }
            }
        }
    }
    strongBanCache.set(cacheKey, bias)
    const storageKey = await makeHashedStorageKey(strongBanCachePrefix, cacheKey)
    await writePersistentJson(storageKey, {
        key: cacheKey,
        value: bias
    })
    return bias
}

export async function getCharToken(char?:character|null){
    let persistant = 0
    let dynamic = 0

    if(!char){
        const c = getCurrentCharacter()
        char = c
    }
    if((char as any).type === 'group'){
        return {persistant:0, dynamic:0}
    }

    const basicTokenize = async (data:string) => {
        data = data.replace(/{{char}}/g, char.name).replace(/<char>/g, char.name)
        return await tokenize(data)
    }

    persistant += await basicTokenize(char.desc)
    persistant += await basicTokenize(char.personality ?? '')
    persistant += await basicTokenize(char.scenario ?? '')
    for(const lore of char.globalLore){
        let cont = lore.content.split('\n').filter((line) => {
            if(line.startsWith('@@')){
                return false
            }
            if(line === ''){
                return false
            }
            return true
        }).join('\n')
        dynamic += await basicTokenize(cont)
    }

    return {persistant, dynamic}
}

export async function getChatToken(chat:Chat) {
    let persistant = 0

    const chatTokenizer = new ChatTokenizer(0, 'name')
    const chatf = chat.message.map((d) => {
        return {
            role: d.role === 'user' ? 'user' : 'assistant',
            content: d.data,
        } as OpenAIChat
    })
    for(const chat of chatf){
        persistant += await chatTokenizer.tokenizeChat(chat)
    }

    return persistant
}
