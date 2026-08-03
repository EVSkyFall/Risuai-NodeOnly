import { language } from "src/lang"
import { notifyError } from "src/ts/alert";
import { getDatabase } from "src/ts/storage/database.svelte"
import { LLMFlags, LLMFormat, LLMProvider } from "src/ts/model/modellist"
import { strongBan, tokenizeNum } from "src/ts/tokenizer"
import { getFreeOpenRouterModels } from "src/ts/model/openrouter"
import { fetchNative, globalFetch, textifyReadableStream } from "src/ts/globalApi.svelte"
import { isLocalNetworkUrl } from "src/ts/network/localNetwork"
import { simplifySchema } from "src/ts/util"

interface LocalNetworkRequestOptions {
    networkRoute?: 'auto' | 'local_network'
    requestTimeoutMs?: number
}

function getLocalNetworkRequestOptions(url: string, force: boolean = false): LocalNetworkRequestOptions {
    const db = getDatabase()
    if (!force && !db.localNetworkMode) return {}
    if (!isLocalNetworkUrl(url)) return {}
    return {
        networkRoute: 'local_network' as const,
        requestTimeoutMs: (db.localNetworkTimeoutSec ?? 600) * 1000,
    }
}

import { extractJSON, getOpenAIJSONSchema } from "../../templates/jsonSchema"
import { applyChatTemplate } from "../../templates/chatTemplate"
import { supportsInlayImage } from "../../files/inlays"
import { callTool, decodeToolCall, encodeToolCall } from "../../mcp/mcp"
import type { RequestDataArgumentExtended, requestDataResponse, StreamResponseChunk } from '../request'
import { applyAdditionalParameters, applyParameters, getAdditionalParameters } from '../shared'

import type { Contents, OpenAIChatExtra, OpenAIChatFull, ResponseInputItem, ResponseItem, ResponseOutputItem, ToolCall } from './types'
import { v4 } from "uuid"

function isCopilotURL(url: string): boolean {
    return url.includes('githubcopilot.com') || url.includes('copilot')
}

let _copilotInteractionId: string | null = null
function getCopilotInteractionId(): string {
    if (!_copilotInteractionId) _copilotInteractionId = v4()
    return _copilotInteractionId
}

function applyCopilotTaskHeaders(headers: Record<string, string>, url: string, taskId?: string, isContinuation = false): string | undefined {
    if (!isCopilotURL(url)) return taskId
    const id = taskId ?? v4()
    headers['X-Request-Id'] = id
    headers['X-Agent-Task-Id'] = id
    headers['X-Interaction-Id'] = getCopilotInteractionId()
    headers['X-Initiator'] = isContinuation ? 'agent' : 'user'
    headers['OpenAI-Intent'] = 'conversation-panel'
    headers['X-GitHub-Api-Version'] = '2025-05-01'
    return id
}

export interface ResolvedOpenAIRequestUrl {
    url: string
    risuIdentify: boolean
}

/**
 * Single source of truth for the OpenAI-compatible chat/completions destination URL.
 * Byte-identical to the inline logic the request builder uses at its send site (the send
 * site now calls this too), so the provider-aware role normalizer resolves the SAME url and
 * the "does this really land on OpenAI?" predicate can never diverge from where the request
 * is actually sent. NOTE: the Mistral format has its OWN destination (api.mistral.ai) and
 * never reaches this url — callers must not treat a Mistral request as OpenAI-official.
 */
export function resolveOpenAIRequestUrl(input: {
    aiModel: string
    customURL?: string
    endpoint?: string
    nanogptUseSubscriptionEndpoint?: boolean
    autofillRequestUrl?: boolean
}): ResolvedOpenAIRequestUrl {
    const aiModel = input.aiModel
    let url = aiModel === 'nanogpt' ? (input.nanogptUseSubscriptionEndpoint ? 'https://nano-gpt.com/api/subscription/v1/chat/completions' : 'https://nano-gpt.com/api/v1/chat/completions') :
        aiModel === 'openrouter' ? "https://openrouter.ai/api/v1/chat/completions" :
        aiModel === 'vercel' ? "https://ai-gateway.vercel.sh/v1/chat/completions" :
        (input.customURL) ?? ('https://api.openai.com/v1/chat/completions')

    if(input.endpoint){
        url = input.endpoint
    }

    let risuIdentify = false
    if(url.startsWith("risu::")){
        risuIdentify = true
        url = url.replace("risu::", '')
    }

    if(aiModel === 'reverse_proxy' && input.autofillRequestUrl){
        if(url.endsWith('v1')){
            url += '/chat/completions'
        }
        else if(url.endsWith('v1/')){
            url += 'chat/completions'
        }
        else if(!(url.endsWith('completions') || url.endsWith('completions/'))){
            if(url.endsWith('/')){
                url += 'v1/chat/completions'
            }
            else{
                url += '/v1/chat/completions'
            }
        }
    }

    return { url, risuIdentify }
}

/**
 * True only when the resolved destination is OpenAI's own API host over https. Origin
 * comparison (protocol+host+port) rejects look-alikes (api.openai.com.evil.tld), plain-http,
 * and any proxy/custom host. Malformed urls fail closed.
 */
export function isOfficialOpenAIEndpoint(url: string): boolean {
    try {
        return new URL(url).origin === 'https://api.openai.com'
    } catch {
        return false
    }
}

/**
 * Provider-aware decision for the OpenAI `system`->`developer` role rewrite. The `developer`
 * variant is only accepted by OpenAI's own endpoint; sending it to a custom/dynamic
 * OpenAI-compatible endpoint (DeepSeek, reverse proxies, …) is a hard request-body
 * deserialization failure. Convert ONLY when the flag is present AND either (a) the request
 * truly lands on api.openai.com, or (b) the user explicitly declared DeveloperRole on this
 * specific xcustom::: endpoint. Everything else — proxies, openrouter/vercel/nanogpt, endpoint
 * overrides, and the global enableCustomFlags blanket on non-official routes — preserves
 * `system` (fail-safe). No guessing from output/error strings; no role-fallback retry.
 */
export function shouldUseDeveloperRole(input: {
    hasDeveloperRoleFlag: boolean
    format: LLMFormat
    aiModel: string
    resolvedUrl: string
    customModels?: { id: string, flags?: LLMFlags[] }[]
}): boolean {
    if(!input.hasDeveloperRoleFlag){
        return false
    }
    // (a) request truly lands on OpenAI's own endpoint. Mistral has a separate destination
    // (api.mistral.ai) that never reaches resolvedUrl, so it is never OpenAI-official.
    if(input.format !== LLMFormat.Mistral && isOfficialOpenAIEndpoint(input.resolvedUrl)){
        return true
    }
    // (b) explicit per-endpoint user declaration on an xcustom::: model — read the custom
    // model's OWN flags, NOT modelInfo.flags (which the global blanket can override).
    if(input.aiModel.startsWith('xcustom:::')){
        const ownFlags = input.customModels?.find((m) => m.id === input.aiModel)?.flags
        if(Array.isArray(ownFlags) && ownFlags.includes(LLMFlags.DeveloperRole)){
            return true
        }
    }
    return false
}

/**
 * Immutable `system`->`developer` normalization. Returns NEW message objects for converted
 * entries and preserves every other message (order, content, tool/assistant metadata) by
 * reference — the input array and its objects are never mutated, so replay/cache identity and
 * other adapters never observe a mutated role.
 */
export function normalizeDeveloperRole(messages: OpenAIChatExtra[], useDeveloperRole: boolean): OpenAIChatExtra[] {
    if(!useDeveloperRole){
        return messages
    }
    return messages.map((message) => (
        message.role === 'system'
            ? { ...message, role: 'developer' }
            : message
    ))
}

export async function requestOpenAI(arg:RequestDataArgumentExtended):Promise<requestDataResponse>{
    let formatedChat:OpenAIChatExtra[] = []
    const formated = arg.formated
    const db = getDatabase()
    const aiModel = arg.aiModel
    let copilotTaskId: string | undefined = undefined

    const processToolCalls = async (text:string, originalMessage:any) => {
        // Split text by tool_call tags and process each segment
        const segments = text.split(/(<tool_call>.*?<\/tool_call>)/gms)
        const processedMessages = []
        
        let currentContent = ''
        
        for(let i = 0; i < segments.length; i++) {
            const segment = segments[i]
            
            if(segment.match(/<tool_call>(.*?)<\/tool_call>/gms)) {
                // This is a tool call segment
                const toolCallMatch = segment.match(/<tool_call>(.*?)<\/tool_call>/s)
                if(toolCallMatch) {
                    const call = await decodeToolCall(toolCallMatch[1])
                    if(call) {
                        // Create assistant message with accumulated content and this tool call
                        processedMessages.push({
                            ...originalMessage,
                            role: 'assistant',
                            content: currentContent,
                            tool_calls: [{
                                id: call.call.id,
                                type: 'function',
                                function: {
                                    name: call.call.name,
                                    arguments: call.call.arg
                                }
                            }]
                        })

                        // Add tool response
                        const textContents: string[] = []
                        for (const m of call.response) {
                            if (m.type === 'text') {
                                textContents.push(m.text)
                            }
                        }

                        processedMessages.push({
                            role: 'tool',
                            content: textContents.join('\n'),
                            tool_call_id: call.call.id,
                            cachePoint: true
                        })

                        // Reset content for next segment
                        currentContent = ''
                    }
                }
            } else {
                // This is regular text content - accumulate it
                currentContent += segment
            }
        }
        
        // If there's remaining content without tool calls, add it as a regular message
        if(currentContent.trim()) {
            processedMessages.push({
                ...originalMessage,
                role: 'assistant',
                content: currentContent
            })
        }
        
        return processedMessages
    }
    for(let i=0;i<formated.length;i++){
        const m = formated[i]
        
        // Check if message contains tool calls
        if(m.content && m.content.includes('<tool_call>')) {
            const processedMessages = await processToolCalls(m.content, m)
            formatedChat.push(...processedMessages)
        }
        else if(m.multimodals && m.multimodals.length > 0 && m.role === 'user'){
            let v:OpenAIChatExtra = safeStructuredClone(m)
            let contents:Contents[] = []
            for(let j=0;j<m.multimodals.length;j++){
                contents.push({
                    "type": "image_url",
                    "image_url": {
                        "url": m.multimodals[j].base64,
                        "detail": db.gptVisionQuality
                    }
                })
            }
            contents.push({
                "type": "text",
                "text": m.content
            })
            v.content = contents
            formatedChat.push(v)
        }
        else{
            formatedChat.push(m)
        }
    }
    
    let oobaSystemPrompts:string[] = []
    for(let i=0;i<formatedChat.length;i++){
        if(formatedChat[i].role !== 'function'){
            if(!(formatedChat[i].name && formatedChat[i].name.startsWith('example_') && db.newOAIHandle)){
                formatedChat[i].name = undefined
            }
            if(db.newOAIHandle && formatedChat[i].memo && formatedChat[i].memo.startsWith('NewChat')){
                formatedChat[i].content = ''
            }
            if(arg.modelInfo.flags.includes(LLMFlags.deepSeekPrefix) && i === formatedChat.length-1 && formatedChat[i].role === 'assistant'){
                formatedChat[i].prefix = true
            }
            if(arg.modelInfo.flags.includes(LLMFlags.deepSeekThinkingInput) && i === formatedChat.length-1 && formatedChat[i].thoughts && formatedChat[i].thoughts.length > 0 && formatedChat[i].role === 'assistant'){
                formatedChat[i].reasoning_content = formatedChat[i].thoughts.join('\n')
            }
            delete formatedChat[i].memo
            delete formatedChat[i].removable
            delete formatedChat[i].attr
            delete formatedChat[i].multimodals
            delete formatedChat[i].thoughts
            delete formatedChat[i].cachePoint
        }
        if(aiModel === 'reverse_proxy' && db.reverseProxyOobaMode && formatedChat[i].role === 'system'){
            const cont = formatedChat[i].content
            if(typeof(cont) === 'string'){
                oobaSystemPrompts.push(cont)
                formatedChat[i].content = ''
            }
        }
    }

    if(oobaSystemPrompts.length > 0){
        formatedChat.push({
            role: 'system',
            content: oobaSystemPrompts.join('\n')
        })
    }


    if(db.newOAIHandle){
        formatedChat = formatedChat.filter(m => {
            return m.content !== '' || (m.multimodals && m.multimodals.length > 0) || m.tool_calls || m.role === 'tool'
        })
    }

    for(let i=0;i<arg.biasString.length;i++){
        const bia = arg.biasString[i]
        if(bia[0].startsWith('[[') && bia[0].endsWith(']]')){
            const num = parseInt(bia[0].replace('[[', '').replace(']]', ''))
            arg.bias[num] = bia[1]
            continue
        }

        if(bia[1] === -101){
            arg.bias = await strongBan(bia[0], arg.bias)
            continue
        }
        const tokens = await tokenizeNum(bia[0])

        for(const token of tokens){
            arg.bias[token] = bia[1]

        }
    }


    let requestModel = (aiModel === 'reverse_proxy' || aiModel === 'openrouter' || aiModel === 'vercel' || aiModel === 'openai-dynamic') ? db.proxyRequestModel : aiModel
    let openrouterRequestModel = db.openrouterRequestModel
    if(aiModel === 'reverse_proxy'){
        requestModel = db.customProxyRequestModel
    }
    if(aiModel === 'nanogpt'){
        requestModel = db.nanogptRequestModel
    }

    if(aiModel === 'openrouter' && db.openrouterRequestModel === 'risu/free'){
        openrouterRequestModel = await getFreeOpenRouterModels()
    }

    // Provider-aware system->developer normalization. Resolve the ACTUAL destination first
    // (same helper the send site below calls, so the predicate can never diverge from the real
    // URL) and only rewrite when the wire provider is known to accept `developer`; otherwise
    // preserve `system` (fail-safe). Immutable: converted entries become new objects.
    const developerRoleDestination = resolveOpenAIRequestUrl({
        aiModel,
        customURL: arg.customURL,
        endpoint: arg.modelInfo?.endpoint,
        nanogptUseSubscriptionEndpoint: db.nanogptUseSubscriptionEndpoint,
        autofillRequestUrl: db.autofillRequestUrl,
    }).url
    formatedChat = normalizeDeveloperRole(formatedChat, shouldUseDeveloperRole({
        hasDeveloperRoleFlag: arg.modelInfo.flags.includes(LLMFlags.DeveloperRole),
        format: arg.modelInfo.format,
        aiModel,
        resolvedUrl: developerRoleDestination,
        customModels: db.customModels,
    }))

    console.log(formatedChat)
    if(arg.modelInfo.format === LLMFormat.Mistral){
        requestModel = aiModel

        let reformatedChat:OpenAIChatExtra[] = []

        for(let i=0;i<formatedChat.length;i++){
            const chat = formatedChat[i]
            if(i === 0){
                if(chat.role === 'user' || chat.role === 'system'){
                    reformatedChat.push({
                        role: chat.role,
                        content: chat.content
                    })
                }
                else{
                    reformatedChat.push({
                        role: 'system',
                        content:  chat.role + ':' + chat.content
                    })
                }
            }
            else{
                const prevChat = reformatedChat[reformatedChat.length-1]
                if(prevChat?.role === chat.role){
                    reformatedChat[reformatedChat.length-1].content += '\n' + chat.content
                    continue
                }
                else if(chat.role === 'system'){
                    if(prevChat?.role === 'user'){
                        reformatedChat[reformatedChat.length-1].content += '\nSystem:' + chat.content
                    }
                    else{
                        reformatedChat.push({
                            role: 'user',
                            content: 'System:' + chat.content
                        })
                    }
                }
                else if(chat.role === 'function'){
                    reformatedChat.push({
                        role: 'user',
                        content: chat.content
                    })
                }
                else{
                    reformatedChat.push({
                        role: chat.role,
                        content: chat.content
                    })
                }
            }
        }

        const targs = {
            body: applyParameters({
                model: requestModel,
                messages: reformatedChat,
                safe_prompt: false,
                ...(arg.hostOmitCallerGenerationCap ? {} : { max_tokens: arg.maxTokens }),
            }, ['temperature', 'presence_penalty', 'frequency_penalty', 'top_p'], {}, arg.mode, {
                modelId: arg.modelInfo.id
            } ),
            headers: {
                "Authorization": "Bearer " + (arg.key ?? db.mistralKey),
            },
            abortSignal: arg.abortSignal,
            chatId: arg.chatId,
            interceptor: 'mistral',
        } as const

        if(arg.previewBody){
            return {
                type: 'success',
                result: JSON.stringify({
                    url: "https://api.mistral.ai/v1/chat/completions",
                    body: targs.body,
                    headers: targs.headers
                })
            }
        }
    
        const mistralUrl = arg.customURL ?? "https://api.mistral.ai/v1/chat/completions"
        const res = await globalFetch(mistralUrl, { ...targs, ...getLocalNetworkRequestOptions(mistralUrl), logCategory: 'llm', logSource: 'main', logModel: arg.modelInfo?.id })

        const dat = res.data as any
        if(res.ok){
            try {
                const msg:OpenAIChatFull = (dat.choices[0].message)
                return {
                    type: 'success',
                    result: msg.content ?? ''
                }
            } catch (error) {
                return {
                    type: 'fail',
                    result: (language.errors.httpError + `${JSON.stringify(dat)}`)
                }
            }
        }
        else{
            if(dat.error && dat.error.message){                    
                return {
                    type: 'fail',
                    result: (language.errors.httpError + `${dat.error.message}`)
                }
            }
            else{                    
                return {
                    type: 'fail',
                    result: (language.errors.httpError + `${JSON.stringify(res.data)}`)
                }
            }
        }
    }

    db.cipherChat = false
    let body:{
        [key:string]:any
    } = ({
        model: aiModel === 'nanogpt' ? db.nanogptRequestModel :
            aiModel === 'openrouter' ? openrouterRequestModel :
            aiModel === 'vercel' ? db.vercelRequestModel :
            aiModel === 'openai-dynamic' ? db.openAIRequestModel :
            requestModel ===  'gpt35' ? 'gpt-3.5-turbo'
            : requestModel ===  'gpt35_0613' ? 'gpt-3.5-turbo-0613'
            : requestModel ===  'gpt35_16k' ? 'gpt-3.5-turbo-16k'
            : requestModel ===  'gpt35_16k_0613' ? 'gpt-3.5-turbo-16k-0613'
            : requestModel === 'gpt4' ? 'gpt-4'
            : requestModel === 'gpt45' ? 'gpt-4.5-preview'
            : requestModel === 'gpt4_32k' ? 'gpt-4-32k'
            : requestModel === "gpt4_0613" ? 'gpt-4-0613'
            : requestModel === "gpt4_32k_0613" ? 'gpt-4-32k-0613'
            : requestModel === "gpt4_1106" ? 'gpt-4-1106-preview'
            : requestModel === 'gpt4_0125' ? 'gpt-4-0125-preview'
            : requestModel === "gptvi4_1106" ? 'gpt-4-vision-preview'
            : requestModel === "gpt35_0125" ? 'gpt-3.5-turbo-0125'
            : requestModel === "gpt35_1106" ? 'gpt-3.5-turbo-1106'
            : requestModel === 'gpt35_0301' ? 'gpt-3.5-turbo-0301'
            : requestModel === 'gpt4_0314' ? 'gpt-4-0314'
            : requestModel === 'gpt4_turbo_20240409' ? 'gpt-4-turbo-2024-04-09'
            : requestModel === 'gpt4_turbo' ? 'gpt-4-turbo'
            : requestModel === 'gpt4o' ? 'gpt-4o'
            : requestModel === 'gpt4o-2024-05-13' ? 'gpt-4o-2024-05-13'
            : requestModel === 'gpt4om' ? 'gpt-4o-mini'
            : requestModel === 'gpt4om-2024-07-18' ? 'gpt-4o-mini-2024-07-18'
            : requestModel === 'gpt4o-2024-08-06' ? 'gpt-4o-2024-08-06'
            : requestModel === 'gpt4o-2024-11-20' ? 'gpt-4o-2024-11-20'
            : requestModel === 'gpt4o-chatgpt' ? 'chatgpt-4o-latest'
            : requestModel === 'gpt4o1-preview' ? 'o1-preview'
            : requestModel === 'gpt4o1-mini' ? 'o1-mini'
            : arg.modelInfo.internalID ? arg.modelInfo.internalID
            : (!requestModel) ? 'gpt-3.5-turbo'
            : requestModel,
        messages: formatedChat,
        ...(arg.hostOmitCallerGenerationCap ? {} : { max_tokens: arg.maxTokens }),
        logit_bias: arg.bias,
        stream: false,

    })


    if(Object.keys(body.logit_bias).length === 0){
        delete body.logit_bias
    }

    if(
        arg.modelInfo.flags.includes(LLMFlags.OAICompletionTokens)
        && Object.hasOwn(body, 'max_tokens')
    ){
        body.max_completion_tokens = body.max_tokens
        delete body.max_tokens
    }

    if(db.generationSeed > 0){
        body.seed = db.generationSeed
    }

    if(db.jsonSchemaEnabled || arg.schema){
        body.response_format = {
            "type": "json_schema",
            "json_schema": getOpenAIJSONSchema(arg.schema)
        }
    }

    if(db.OAIPrediction){
        body.prediction = {
            type: "content",
            content: db.OAIPrediction
        }
    }

    if(aiModel === 'openrouter'){
        if(db.openrouterFallback){
            body.route = "fallback"
        }
        body.transforms = db.openrouterMiddleOut ? ['middle-out'] : []

        if(db.openrouterProvider){
            const provider: typeof db.openrouterProvider = {} as typeof db.openrouterProvider;
            if (db.openrouterProvider.order?.length) {
                provider.order = db.openrouterProvider.order;
            }
            if (db.openrouterProvider.only?.length) {
                provider.only = db.openrouterProvider.only;
            }
            if (db.openrouterProvider.ignore?.length) {
                provider.ignore = db.openrouterProvider.ignore;
            }
            if (Object.keys(provider).length) {
                body.provider = provider;
            }
        }

        if(db.useInstructPrompt){
            delete body.messages
            const prompt = applyChatTemplate(formated)
            body.prompt = prompt
        }
    }

    // Flex is an official-OpenAI-only service tier. Gate on the ACTUAL resolved
    // destination (same single-source-of-truth helper as the role predicate and
    // the send site), not the provider enum: enum-OpenAI also covers
    // OpenAI-compatible endpoints (Copilot, gateways) that reject the parameter
    // with 400 "service_tier is not supported" — which silently killed plugin
    // sub-model calls while db.openAIFlex was on (2026-07-22 incident).
    if(db.openAIFlex && arg.modelInfo.provider === LLMProvider.OpenAI && isOfficialOpenAIEndpoint(resolveOpenAIRequestUrl({
        aiModel,
        customURL: arg.customURL,
        endpoint: arg.modelInfo?.endpoint,
        nanogptUseSubscriptionEndpoint: db.nanogptUseSubscriptionEndpoint,
        autofillRequestUrl: db.autofillRequestUrl,
    }).url)){
        body.service_tier = "flex"
    }

    body = applyParameters(
        body,
        arg.modelInfo.parameters,
        {},
        arg.mode,
        {
            modelId: arg.modelInfo.id
        }
    )

    // DeepSeek V4 thinking enable: wire reasoning_effort alone has no effect
    // — the API requires `thinking: {type: 'enabled'}` alongside it. We use
    // the deepSeekThinkingInput flag as the signal (V4 Pro / Flash / reasoner
    // all carry it). This also flows correctly through Ollama Cloud since
    // it forwards extra fields to DeepSeek upstream.
    if(arg.modelInfo.flags.includes(LLMFlags.deepSeekThinkingInput)){
        if(body.reasoning_effort === 'minimal'){
            body.thinking = { type: 'disabled' }
            delete body.reasoning_effort
        } else {
            body.thinking = { type: 'enabled' }
            // DeepSeek only honours "high" or "max"; coerce client-side so
            // logs reflect what the server actually sees (low/medium would
            // be silently mapped to "high" anyway).
            if(body.reasoning_effort === 'low' || body.reasoning_effort === 'medium'){
                body.reasoning_effort = 'high'
            }
        }
    } else if(body.reasoning_effort === 'max'){
        // Non-DeepSeek reasoning models (OpenAI o-series, GPT-5) reject "max"
        // as 400 invalid_request. Clamp to "high".
        body.reasoning_effort = 'high'
    }

    if(arg.tools && arg.tools.length > 0){
        body.tools = arg.tools.map(tool => {
            return {
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: simplifySchema(tool.inputSchema),
                }
            }
        })
    }

    if(aiModel === 'reverse_proxy' && db.reverseProxyOobaMode){
        const OobaBodyTemplate = db.reverseProxyOobaArgs

        const keys = Object.keys(OobaBodyTemplate)
        for(const key of keys){
            if(OobaBodyTemplate[key] !== undefined && OobaBodyTemplate[key] !== null){
                body[key] = OobaBodyTemplate[key]
            }
        }

    }

    if(supportsInlayImage()){
        // inlay models doesn't support logit_bias
        // OpenAI's gpt based llm model supports both logit_bias and inlay image
        if(!(
            aiModel.startsWith('gpt') || 
            (aiModel == 'reverse_proxy' && (
                db.proxyRequestModel?.startsWith('gpt') ||
                (db.proxyRequestModel === 'custom' && db.customProxyRequestModel.startsWith('gpt'))
            )))){
            delete body.logit_bias
        }
    }

    // Same single-source-of-truth helper the provider-aware role predicate above resolved.
    const resolvedRequest = resolveOpenAIRequestUrl({
        aiModel,
        customURL: arg.customURL,
        endpoint: arg.modelInfo?.endpoint,
        nanogptUseSubscriptionEndpoint: db.nanogptUseSubscriptionEndpoint,
        autofillRequestUrl: db.autofillRequestUrl,
    })
    let replacerURL = resolvedRequest.url
    let risuIdentify = resolvedRequest.risuIdentify

    let headers = {
        "Authorization": "Bearer " + (arg.key ?? (aiModel === 'nanogpt' ? db.nanogptKey : aiModel === 'reverse_proxy' ?  db.proxyKey : (aiModel === 'openrouter' ? db.openrouterKey : (aiModel === 'vercel' ? db.vercelKey : db.openAIKey)))),
        "Content-Type": "application/json"
    }

    if(arg.modelInfo?.keyIdentifier){
        headers["Authorization"] = "Bearer " + db.OaiCompAPIKeys[arg.modelInfo.keyIdentifier]
    }
    if(aiModel === 'openrouter'){
        headers["X-Title"] = 'RisuAI'
        headers["HTTP-Referer"] = 'https://risuai.xyz'
    }
    if(aiModel === 'nanogpt' && db.nanogptProvider){
        headers["X-Provider"] = db.nanogptProvider
    }
    if(risuIdentify){
        headers["X-Proxy-Risu"] = 'RisuAI'
    }
    if(arg.multiGen){
        // Check if tools are enabled - multiGen with tools is not supported
        if(arg.tools && arg.tools.length > 0){
            return {
                type: 'fail',
                result: 'MultiGen mode cannot be used with tool calls. Please disable one of them.'
            }
        }
        body.n = db.genTime
    }
    if(aiModel === 'reverse_proxy' || aiModel.startsWith('xcustom:::')){
        body = applyAdditionalParameters(body, headers, getAdditionalParameters(aiModel))
    }

    // OpenAI Batch API: submit as async batch (50% discount, 24h)
    if(db.openAIBatch && arg.modelInfo.provider === LLMProvider.OpenAI){
        delete body.stream
        try {
            const { submitOpenAIBatch } = await import('../openAIBatchTracker')
            const apiKey = db.openAIKey
            const { batchId, placeholderStream } = await submitOpenAIBatch(body, apiKey)
            arg.additionalBatchId = batchId
            return { type: 'streaming', result: placeholderStream }
        } catch (e: any) {
            return { type: 'fail', result: e?.message || 'OpenAI Batch submission failed' }
        }
    }

    if(arg.useStreaming){
        body.stream = true

        if(arg.previewBody){
            return {
                type: 'success',
                result: JSON.stringify({
                    url: replacerURL,
                    body: body,
                    headers: headers
                })
            }
        }
        copilotTaskId = applyCopilotTaskHeaders(headers, replacerURL, copilotTaskId, copilotTaskId !== undefined)
        const da = await fetchNative(replacerURL, {
            body: JSON.stringify(body),
            method: "POST",
            headers: headers,
            signal: arg.abortSignal,
            chatId: arg.chatId,
            interceptor: 'openai_streaming',
            logCategory: 'llm',
            logSource: 'main',
            logModel: arg.modelInfo?.id,
            ...getLocalNetworkRequestOptions(replacerURL, arg.forceLocalNetwork),
        })

        if(da.status !== 200){
            return {
                type: "fail",
                result: await textifyReadableStream(da.body)
            }
        }

        if (!da.headers.get('Content-Type').includes('text/event-stream')){
            return {
                type: "fail",
                result: await textifyReadableStream(da.body)
            }
        }

        const transtream = getTranStream(arg)

        da.body.pipeTo(transtream.writable)

        return {
            type: 'streaming',
            result: wrapToolStream(transtream.readable, body, headers, replacerURL, arg, copilotTaskId)
        }
    }

    if(!arg.useStreaming){
        body.stream = false
    }

    if(arg.previewBody){
        return {
            type: 'success',
            result: JSON.stringify({
                url: replacerURL,
                body: body,
                headers: headers
            })
        }
    }

    return requestHTTPOpenAI(replacerURL, body, headers, arg)

}

async function requestHTTPOpenAI(replacerURL:string,body:any, headers:Record<string,string>, arg:RequestDataArgumentExtended, copilotTaskId?: string):Promise<requestDataResponse>{

    const isContinuation = copilotTaskId !== undefined
    copilotTaskId = applyCopilotTaskHeaders(headers, replacerURL, copilotTaskId, isContinuation)

    const db = getDatabase()
    const res = await globalFetch(replacerURL, {
        logCategory: 'llm',
        logSource: 'main',
        logModel: arg.modelInfo?.id,
        body: body,
        headers: headers,
        abortSignal: arg.abortSignal,
        chatId: arg.chatId,
        interceptor: 'openai_basic',
        ...getLocalNetworkRequestOptions(replacerURL, arg.forceLocalNetwork),
    })

    function processTextResponse(dat: any):string{
        if(dat?.choices[0]?.text){
            let text = dat.choices[0].text as string
            if(arg.extractJson && (db.jsonSchemaEnabled || arg.schema)){
                try {
                    const parsed = JSON.parse(text)
                    const extracted = extractJSON(parsed, arg.extractJson)
                    return extracted
                } catch (error) {
                    console.log(error)
                    return text
                }
            }
            return text
        }
        if(arg.extractJson && (db.jsonSchemaEnabled || arg.schema)){
            return extractJSON(dat.choices[0].message.content, arg.extractJson)
        }
        const msg:OpenAIChatFull = (dat.choices[0].message)
        let result = msg.content ?? ''
        if(arg.modelInfo.flags.includes(LLMFlags.deepSeekThinkingOutput)){
            console.log("Checking for reasoning content")
            let reasoningContent = ""
            result = result.replace(/(.*)\<\/think\>/gms, (m, p1) => {
                reasoningContent = p1
                return ""
            })
            console.log(`Reasoning Content: ${reasoningContent}`)
            if(reasoningContent){
                reasoningContent = reasoningContent.replace(/\<think\>/gms, '')
                result = `<Thoughts>\n${reasoningContent}\n</Thoughts>\n${result}`
            }
        }
        // For deepseek Official Reasoning Model: https://api-docs.deepseek.com/guides/thinking_mode#api-example
        const reasoningContentField = dat?.choices[0]?.reasoning_content ?? dat?.choices[0]?.message?.reasoning_content
        if(reasoningContentField){
            result = `<Thoughts>\n${reasoningContentField}\n</Thoughts>\n${result}`
        }
        // For openrouter, https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request#response.body.choices.message.reasoning
        if(dat?.choices?.[0]?.message?.reasoning){
            result = `<Thoughts>\n${dat.choices[0].message.reasoning}\n</Thoughts>\n${result}`
        }

        return result
    }

    const dat = res.data as any

    if(res.ok){
        try {
            // Collect all tool_calls from all choices
            let allToolCalls: ToolCall[] = []
            if(dat.choices) {
                for(const choice of dat.choices) {
                    if(choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
                        allToolCalls = allToolCalls.concat(choice.message.tool_calls)
                    }
                }
            }
            
            // Replace choices[0].message.tool_calls with all collected tool calls
            if(dat.choices?.[0]?.message && allToolCalls.length > 0) {
                dat.choices[0].message.tool_calls = allToolCalls
            }

            if(dat.choices?.[0]?.message?.tool_calls && dat.choices[0].message.tool_calls.length > 0){
                const toolCalls = dat.choices[0].message.tool_calls as ToolCall[]

                const messages = body.messages as OpenAIChatExtra[]
                
                messages.push(dat.choices[0].message)

                // Remove the last message content if simplifiedToolUse is enabled
                if(db.simplifiedToolUse && messages[messages.length - 1].content) {
                    messages[messages.length - 1].content = ''
                }
                
                const callCodes: string[] = []

                for(const toolCall of toolCalls){
                    if(!toolCall.function || !toolCall.function.name || toolCall.function.arguments === undefined || toolCall.function.arguments === null){
                        continue
                    }
                    try {
                        const functionArgs = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {}
                        if(arg.tools && arg.tools.length > 0){
                            const tool = arg.tools.find(t => t.name === toolCall.function.name)
                            if(!tool){
                                messages.push({
                                    role:'tool',
                                    content: 'No tool found with name: ' + toolCall.function.name,
                                    tool_call_id: toolCall.id
                                })
                            }
                            else{
                                const parsed = functionArgs
                                const x = (await callTool(tool.name, parsed)).filter(m => m.type === 'text')
                                if(x.length > 0){
                                    messages.push({
                                        role: 'tool',
                                        content: x[0].text,
                                        tool_call_id: toolCall.id
                                    })
                                    if(arg.rememberToolUsage){
                                        callCodes.push(await encodeToolCall({
                                            call: {
                                                id: toolCall.id,
                                                name: toolCall.function.name,
                                                arg: toolCall.function.arguments
                                            },
                                            response: x
                                        }))
                                    }
                                }
                                else{
                                    messages.push({
                                        role: 'tool',
                                        content: 'Tool call failed with no text response',
                                        tool_call_id: toolCall.id
                                    })
                                }
                            }
                        }
                    } catch (error) {
                        messages.push({
                            role: 'tool',
                            content: 'Tool call failed with error: ' + error,
                            tool_call_id: toolCall.id
                        })
                    }
                }                
                
                body.messages = messages

                // Send the next request recursively
                let resRec
                let attempt = 0
                
                do {
                    attempt++
                    resRec = await requestHTTPOpenAI(replacerURL, body, headers, arg, copilotTaskId)
                    
                    if (resRec.type != 'fail') {
                        break
                    }
                } while (attempt <= db.requestRetrys) // Retry up to db.requestRetrys times

                const callCode = callCodes.join('\n\n')

                // Combine the tool call results with the main response (does not include text response if simplifiedToolUse is enabled)
                const result = (db.simplifiedToolUse ? '' : (processTextResponse(dat) ?? '') + '\n\n') + callCode
                        
                if(resRec.type === 'fail') {
                    notifyError(`Failed to fetch model response after tool execution`)
                    return {
                        type: 'success',
                        result: result
                    }
                } else if(resRec.type === 'success') {
                    return {
                        type: 'success',
                        result: result + '\n\n' + resRec.result
                    }
                }
                        
                return resRec
            }
                    
            if(arg.multiGen && dat.choices){
                if(arg.extractJson && (db.jsonSchemaEnabled || arg.schema)){
                    
                    const c = dat.choices.map((v:{message:{content:string}}) => {
                        const extracted = extractJSON(v.message.content ?? '', arg.extractJson)
                        return ["char", extracted]
                    })
                    
                    return {
                        type: 'multiline',
                        result: c
                    }
                }
                return {
                    type: 'multiline',
                    result: dat.choices.map((v) => {
                        return ["char", v.message.content ?? '']
                    })
                }
            }            
                    
            const result = processTextResponse(dat) ?? ''
            
            return {
                type: 'success',
                result: result
            }
            
        } catch (error) {                    
            return {
                type: 'fail',
                result: (language.errors.httpError + `${JSON.stringify(dat)}`)
            }
        }
    }
    
    if(dat.error && dat.error.message){                    
        return {
            type: 'fail',
            result: (language.errors.httpError + `${dat.error.message}`)
        }
    }

    return {
        type: 'fail',
        result: (language.errors.httpError + `${JSON.stringify(res.data)}`)
    }
}

export async function requestOpenAILegacyInstruct(arg:RequestDataArgumentExtended):Promise<requestDataResponse>{
    const formated = arg.formated
    const db = getDatabase()
    const maxTokens = arg.maxTokens
    const temperature = arg.temperature
    const prompt = formated.filter(m => m.content?.trim()).map(m => {
        let author = '';

        if(m.role == 'system'){
            m.content = m.content.trim();
        }

        console.log(m.role +":"+m.content);
        switch (m.role) {
            case 'user': author = 'User'; break;
            case 'assistant': author = 'Assistant'; break;
            case 'system': author = 'Instruction'; break;
            default: author = m.role; break;
        }

        return `\n## ${author}\n${m.content.trim()}`;
        //return `\n\n${author}: ${m.content.trim()}`;
    }).join("") + `\n## Response\n`;

    if(arg.previewBody){
        return {
            type: 'success',
            result: JSON.stringify({
                error: "This model is not supported in preview mode"
            })
        }
    }

    const completionsUrl = arg.customURL ?? "https://api.openai.com/v1/completions"
    const response = await globalFetch(completionsUrl, {
        logCategory: 'llm',
        logSource: 'main',
        logModel: 'gpt-3.5-turbo-instruct',
        body: {
            model: "gpt-3.5-turbo-instruct",
            prompt: prompt,
            ...(arg.hostOmitCallerGenerationCap ? {} : { max_tokens: maxTokens }),
            temperature: temperature,
            top_p: 1,
            stop:["User:"," User:", "user:", " user:"],
            presence_penalty: arg.PresensePenalty || (db.PresensePenalty / 100),
            frequency_penalty: arg.frequencyPenalty || (db.frequencyPenalty / 100),
        },
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + (arg.key ?? db.openAIKey)
        },
        chatId: arg.chatId,
        abortSignal: arg.abortSignal,
        ...getLocalNetworkRequestOptions(completionsUrl),
    });

    if(!response.ok){
        return {
            type: 'fail',
            result: (language.errors.httpError + `${JSON.stringify(response.data)}`)
        }
    }
    const text:string = response.data.choices[0].text
    return {
        type: 'success',
        result: text.replace(/##\n/g, '')
    }
    
}

export async function requestOpenAIResponseAPI(arg:RequestDataArgumentExtended):Promise<requestDataResponse>{

    const formated = arg.formated
    const db = getDatabase()
    const aiModel = arg.aiModel
    const maxTokens = arg.maxTokens

    const items:ResponseItem[] = []

    for(let i=0;i<formated.length;i++){
        const content = formated[i]
        switch(content.role){
            case 'function':
                break
            case 'assistant':{
                const item:ResponseOutputItem = {
                    content: [],
                    role: content.role,
                    status: 'complete',
                    type: 'message',
                }

                item.content.push({
                    type: 'output_text',
                    text: content.content,
                    annotations: []
                })

                items.push(item)
                break
            }
            case 'user':
            case 'system':{
                const item:ResponseInputItem = {
                    content: [],
                    role: content.role
                }

                item.content.push({
                    type: 'input_text',
                    text: content.content
                })

                content.multimodals ??= []
                for(const multimodal of content.multimodals){
                    if(multimodal.type === 'image'){
                        item.content.push({
                            type: 'input_image',
                            detail: 'auto',
                            image_url: multimodal.base64
                        })
                    }
                    else{
                        item.content.push({
                            type: 'input_file',
                            file_data: multimodal.base64,
                        })
                    }
                }

                items.push(item)
                break
            }
        }
    }

    if(items[items.length-1].role === 'assistant'){
        (items[items.length-1] as ResponseOutputItem).status = 'incomplete'
    }
    
    const body = applyParameters({
        model: arg.modelInfo.internalID ?? aiModel,
        input: items,
        ...(arg.hostOmitCallerGenerationCap ? {} : { max_output_tokens: maxTokens }),
        tools: [],
        store: false
    }, ['temperature', 'top_p'], {}, arg.mode, {
        modelId: arg.modelInfo.id
    })

    let requestURL = arg.customURL ?? "https://api.openai.com/v1/responses"
    if(arg.modelInfo?.endpoint){
        requestURL = arg.modelInfo.endpoint
    }

    let risuIdentify = false
    if(requestURL.startsWith("risu::")){
        risuIdentify = true
        requestURL = requestURL.replace("risu::", '')
    }

    if(aiModel === 'reverse_proxy' && db.autofillRequestUrl){
        try{
            const url = new URL(requestURL)
            const pathSegments = url.pathname.split('/').filter(Boolean)
            const lastSegment = pathSegments[pathSegments.length - 1] ?? ''

            if(url.searchParams.has('api-version') && url.pathname.includes('/responses')){
                // Azure-style Responses API URL already includes the endpoint
            }
            else if(lastSegment === 'responses'){
                // keep as-is
            }
            else if(lastSegment === 'v1'){
                url.pathname = url.pathname.replace(/\/?$/, '/responses')
            }
            else{
                url.pathname = url.pathname.replace(/\/?$/, '/v1/responses')
            }

            requestURL = url.toString()
        }
        catch{
            const [baseURL, query] = requestURL.split('?', 2)
            let nextURL = baseURL
            const pathSegments = nextURL.split('/').filter(Boolean)
            const lastSegment = pathSegments[pathSegments.length - 1] ?? ''
            const hasApiVersion = query?.includes('api-version=')

            if(hasApiVersion && nextURL.includes('/responses')){
                // Azure-style Responses API URL already includes the endpoint
            }
            else if(lastSegment === 'responses'){
                // keep as-is
            }
            else if(lastSegment === 'v1'){
                nextURL += nextURL.endsWith('/') ? 'responses' : '/responses'
            }
            else{
                nextURL += nextURL.endsWith('/') ? 'v1/responses' : '/v1/responses'
            }

            requestURL = query ? `${nextURL}?${query}` : nextURL
        }
    }

    const headers = {
        "Authorization": "Bearer " + (arg.key ?? db.openAIKey),
        "Content-Type": "application/json"
    }

    if(risuIdentify){
        headers["X-Proxy-Risu"] = 'RisuAI'
    }

    if(arg.previewBody){
        return {
            type: 'success',
            result: JSON.stringify({
                url: requestURL,
                body: body,
                headers: headers
            })
        }
    }

    if(db.modelTools.includes('search')){
        body.tools.push('web_search_preview')
    }

    const response = await globalFetch(requestURL, {
        logCategory: 'llm',
        logSource: 'main',
        logModel: arg.modelInfo?.id,
        body: body,
        headers: headers,
        chatId: arg.chatId,
        abortSignal: arg.abortSignal,
        interceptor: 'openai_response_api',
        ...getLocalNetworkRequestOptions(requestURL),
    });

    if(!response.ok){
        return {
            type: 'fail',
            result: (language.errors.httpError + `${JSON.stringify(response.data)}`)
        }
    }

    let result: string = (response.data.output?.find((m:ResponseOutputItem) => m.type === 'message') as ResponseOutputItem)?.content?.find(m => m.type === 'output_text')?.text

    if(!result){
        return {
            type: 'fail',
            result: JSON.stringify(response.data)
        }
    }
    return {
        type: 'success',
        result: result
    }
}

function getTranStream(arg:RequestDataArgumentExtended):TransformStream<Uint8Array, StreamResponseChunk> {
    // Incremental SSE parser. State persists across transform() calls so
    // each chunk only processes its newly-arrived lines (prior O(n²) behavior
    // re-split the entire growing buffer every chunk).
    let buffer = ""
    let readed: {[key:string]:string} = {}
    let reasoningContent = ""
    const decoder = new TextDecoder('utf-8')
    const db = getDatabase()

    const composeEnqueue = (control: TransformStreamDefaultController<StreamResponseChunk>) => {
        if(arg.extractJson && (db.jsonSchemaEnabled || arg.schema)){
            const JSONreaded:{[key:string]:string} = {}
            for(const key in readed){
                JSONreaded[key] = extractJSON(readed[key], arg.extractJson)
            }
            control.enqueue(JSONreaded)
        } else if(reasoningContent){
            control.enqueue({
                ...readed,
                "0": `<Thoughts>\n${reasoningContent}\n</Thoughts>\n${readed["0"] ?? ''}`
            })
        } else {
            control.enqueue({ ...readed })
        }
    }

    const processLine = (line: string, control: TransformStreamDefaultController<StreamResponseChunk>): boolean => {
        if(!line.startsWith("data: ")) return false
        const rawChunk = line.slice(6)
        if(rawChunk === "[DONE]"){
            if(arg.modelInfo.flags.includes(LLMFlags.deepSeekThinkingOutput) && readed["0"]){
                readed["0"] = readed["0"].replace(/(.*)\<\/think\>/gms, (_m, p1) => {
                    reasoningContent = p1
                    return ""
                })
                if(reasoningContent){
                    reasoningContent = reasoningContent.replace(/\<think\>/gm, '')
                }
            }
            composeEnqueue(control)
            return true
        }
        try {
            const parsed = JSON.parse(rawChunk)
            const choices = parsed.choices ?? []
            for(const choice of choices){
                const chunkText: string = choice.delta?.content ?? choice.text ?? ''
                if(chunkText){
                    const key = arg.multiGen ? choice.index.toString() : "0"
                    const prev = readed[key] ?? ""
                    if(prev.length > 0 && chunkText.length > prev.length && chunkText.startsWith(prev)){
                        readed[key] = chunkText
                    } else {
                        readed[key] = prev + chunkText
                    }
                }
                if(choice?.delta?.tool_calls){
                    if(!readed["__tool_calls"]){
                        readed["__tool_calls"] = JSON.stringify({})
                    }
                    const toolCallsData = JSON.parse(readed["__tool_calls"])
                    for(const toolCall of choice.delta.tool_calls){
                        const index = toolCall.index ?? 0
                        if(!toolCallsData[index]){
                            toolCallsData[index] = {
                                id: toolCall.id || null,
                                type: 'function',
                                function: { name: null, arguments: '' }
                            }
                        }
                        if(toolCall.id) toolCallsData[index].id = toolCall.id
                        if(toolCall.function?.name) toolCallsData[index].function.name = toolCall.function.name
                        if(toolCall.function?.arguments) toolCallsData[index].function.arguments += toolCall.function.arguments
                    }
                    readed["__tool_calls"] = JSON.stringify(toolCallsData)
                }
                const reasoningDelta = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning
                if(reasoningDelta){
                    const rc: string = reasoningDelta
                    if(reasoningContent.length > 0 && rc.length > reasoningContent.length && rc.startsWith(reasoningContent)){
                        reasoningContent = rc
                    } else {
                        reasoningContent += rc
                    }
                }
            }
        } catch {}
        return false
    }

    return new TransformStream<Uint8Array, StreamResponseChunk>({
        transform(chunk, control) {
            buffer += decoder.decode(chunk, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''

            let terminated = false
            for(const line of lines){
                if(processLine(line, control)){
                    terminated = true
                    break
                }
            }
            if(!terminated){
                composeEnqueue(control)
            }
        },
        flush(control){
            const tail = buffer + decoder.decode()
            buffer = ''
            if(tail.trim()){
                processLine(tail, control)
            }
            composeEnqueue(control)
        }
    })
}

function wrapToolStream(
    stream: ReadableStream<StreamResponseChunk>,
    body:any,
    headers:Record<string,string>,
    replacerURL:string,
    arg:RequestDataArgumentExtended,
    copilotTaskId?: string
):ReadableStream<StreamResponseChunk> {
    return new ReadableStream<StreamResponseChunk>({
        async start(controller) {

            const db = getDatabase()
            let reader = stream.getReader()
            let prefix = ''
            let lastValue
            let currentCopilotTaskId = copilotTaskId

            while(true){
                let {done, value} = await reader.read()

                let content = value?.['0'] || ''
                if(done){
                    value = lastValue ?? {'0': ''}
                    content = value?.['0'] || ''
                    
                    const toolCalls = Object.values(JSON.parse(value?.['__tool_calls'] || '{}') || {}) as ToolCall[]; 
                    if(toolCalls && toolCalls.length > 0){
                        const messages = body.messages as OpenAIChatExtra[]

                        messages.push({
                            role: 'assistant',
                            content: (db.simplifiedToolUse ? '' : content),
                            tool_calls: toolCalls.map(call => ({
                                id: call.id,
                                type: 'function',
                                function: {
                                    name: call.function.name,
                                    arguments: call.function.arguments
                                }
                            }))
                        })

                        const callCodes: string[] = []
                    
                        for(const toolCall of toolCalls){
                            if(!toolCall.function || !toolCall.function.name || !toolCall.function.arguments){
                                continue
                            }
                            try {
                                const functionArgs = JSON.parse(toolCall.function.arguments)
                                if(arg.tools && arg.tools.length > 0){
                                    const tool = arg.tools.find(t => t.name === toolCall.function.name)
                                    if(!tool){
                                        messages.push({
                                            role:'tool',
                                            content: 'No tool found with name: ' + toolCall.function.name,
                                            tool_call_id: toolCall.id
                                        })
                                    }
                                    else{
                                        const parsed = functionArgs
                                        const x = (await callTool(tool.name, parsed)).filter(m => m.type === 'text')
                                        if(x.length > 0){
                                            messages.push({
                                                role: 'tool',
                                                content: x[0].text,
                                                tool_call_id: toolCall.id
                                            })
                                            if(arg.rememberToolUsage){
                                                callCodes.push(await encodeToolCall({
                                                    call: {
                                                        id: toolCall.id,
                                                        name: toolCall.function.name,
                                                        arg: toolCall.function.arguments
                                                    },
                                                    response: x
                                                }))
                                            }
                                        }
                                        else{
                                            messages.push({
                                                role: 'tool',
                                                content: 'Tool call failed with no text response',
                                                tool_call_id: toolCall.id
                                            })
                                        }
                                    }
                                }
                            } catch (error) {
                                messages.push({
                                    role: 'tool',
                                    content: 'Tool call failed with error: ' + error,
                                    tool_call_id: toolCall.id
                                })
                            }
                        }    
                        
                        body.messages = messages
                        // Reapply Copilot task headers for tool continuation (same taskId)
                        currentCopilotTaskId = applyCopilotTaskHeaders(headers, replacerURL, currentCopilotTaskId, true)

                        let resRec
                        let attempt = 0
                        let errorFlag = true

                        do {
                            attempt++
                            resRec = await fetchNative(replacerURL, {
                                logCategory: 'llm',
                                logSource: 'sub',
                                logModel: arg.modelInfo?.id,
                                body: JSON.stringify(body),
                                method: "POST",
                                headers: headers,
                                signal: arg.abortSignal,
                                chatId: arg.chatId,
                                interceptor: 'openai_tool',
                                ...getLocalNetworkRequestOptions(replacerURL),
                            })
                            
                            if(resRec.status == 200 && resRec.headers.get('Content-Type').includes('text/event-stream')) {
                                errorFlag = false
                                break
                            }     
                        } while (attempt <= db.requestRetrys) // Retry up to db.requestRetrys times
                        
                        if(errorFlag){
                            notifyError(`Failed to fetch model response after tool execution`)
                            return controller.close()
                        }
                        
                        const transtream = getTranStream(arg)                    
                        resRec.body.pipeTo(transtream.writable)
                        
                        reader = transtream.readable.getReader()
                        
                        prefix += (content && !db.simplifiedToolUse ? content + '\n\n' : '') + callCodes.join('\n\n')
                        controller.enqueue({"0": prefix})

                        continue
                    }
                    return controller.close()
                }
                
                lastValue = value
                
                controller.enqueue({"0": (prefix ? prefix + '\n\n' : '') + content})
            }
        }
    })
}
