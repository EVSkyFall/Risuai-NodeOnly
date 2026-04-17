import { Sha256 } from "@aws-crypto/sha256-js"
import { HttpRequest } from "@smithy/protocol-http"
import { SignatureV4 } from "@smithy/signature-v4"
import { fetchNative, globalFetch, textifyReadableStream } from "src/ts/globalApi.svelte"
import { LLMFlags, LLMFormat, isClaudeAdaptiveThinkingOnlyModel } from "src/ts/model/modellist"
import { registerClaudeObserver } from "src/ts/observer.svelte"
import { getDatabase } from "src/ts/storage/database.svelte"
import { replaceAsync, simplifySchema, sleep } from "src/ts/util"
import { v4 } from "uuid"
import type { MultiModal } from "../index.svelte"
import { extractJSON } from "../templates/jsonSchema"
import { callTool, decodeToolCall, encodeToolCall } from "../mcp/mcp"
import type { RequestDataArgumentExtended, requestDataResponse, StreamResponseChunk } from './request'
import { applyParameters } from './shared'

interface Claude3TextBlock {
    type: 'text',
    text: string,
    cache_control?: {
        "type": "ephemeral",
        "ttl"?: "5m" | "1h"
    }
}

interface Claude3ImageBlock {
    type: 'image',
    source: {
        type: 'base64'
        media_type: string,
        data: string
    }
    cache_control?: {
        "type": "ephemeral"
        "ttl"?: "5m" | "1h"
    }
}

interface Claude3ToolUseBlock {
    "type": "tool_use",
    "id": string,
    "name": string,
    "input": any,
    cache_control?: {
        "type": "ephemeral"
        "ttl"?: "5m" | "1h"
    }
}

interface Claude3ToolResponseBlock {
    type: "tool_result",
    tool_use_id: string
    content: Claude3ContentBlock[]
    cache_control?: {
        "type": "ephemeral"
        "ttl"?: "5m" | "1h"
    }
}

type Claude3ContentBlock = Claude3TextBlock|Claude3ImageBlock|Claude3ToolUseBlock|Claude3ToolResponseBlock

interface Claude3Chat {
    role: 'user'|'assistant'
    content: Claude3ContentBlock[]
}

interface Claude3ExtendedChat {
    role: 'user'|'assistant'
    content: Claude3ContentBlock[]|string
}

export async function requestClaude(arg:RequestDataArgumentExtended):Promise<requestDataResponse> {
    const formated = arg.formated
    const db = getDatabase()
    const aiModel = arg.aiModel
    const useStreaming = arg.useStreaming
    let replacerURL = arg.customURL ?? ('https://api.anthropic.com/v1/messages')
    let apiKey = arg.key || ((aiModel === 'reverse_proxy') ? db.proxyKey : db.claudeAPIKey)
    const maxTokens = arg.maxTokens
    if(aiModel === 'reverse_proxy' && db.autofillRequestUrl){
        if(replacerURL.endsWith('v1')){
            replacerURL += '/messages'
        }
        else if(replacerURL.endsWith('v1/')){
            replacerURL += 'messages'
        }
        else if(!(replacerURL.endsWith('messages') || replacerURL.endsWith('messages/'))){
            if(replacerURL.endsWith('/')){
                replacerURL += 'v1/messages'
            }
            else{
                replacerURL += '/v1/messages'
            }
        }
    }

    let claudeChat: Claude3Chat[] = []
    let systemPrompt:string = ''

    const addClaudeChat = (chat:{
        role: 'user'|'assistant'
        content: string,
        cache: boolean
    }, multimodals?:MultiModal[]) => {
        if(claudeChat.length > 0 && claudeChat[claudeChat.length-1].role === chat.role){
            let content = claudeChat[claudeChat.length-1].content
            if(multimodals && multimodals.length > 0 && !Array.isArray(content)){
                content = [{    
                    type: 'text',
                    text: content
                }]
            }

            if(Array.isArray(content)){
                let lastContent = content[content.length-1]
                if( lastContent?.type === 'text'){
                    lastContent.text += "\n\n" + chat.content
                    content[content.length-1] = lastContent
                }
                else{
                    content.push({
                        type: 'text',
                        text: chat.content
                    })
                }

                if(multimodals && multimodals.length > 0){
                    for(const modal of multimodals){
                        if(modal.type === 'image'){
                            const dataurl = modal.base64
                            const base64 = dataurl.split(',')[1]
                            const mediaType = dataurl.split(';')[0].split(':')[1]

                            content.unshift({
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: mediaType,
                                    data: base64
                                }
                            })
                        }
                    }
                }
            }
            if(chat.cache){

                if(db.claude1HourCaching){
                    content[content.length-1].cache_control = {
                        type: 'ephemeral',
                        ttl: "1h"
                    }
                }
                else{
                    content[content.length-1].cache_control = {
                        type: 'ephemeral'
                    }
                }
            }
            claudeChat[claudeChat.length-1].content = content
        }
        else{
            let formatedChat:Claude3Chat = {
                role: chat.role,
                content: [{
                    type: 'text',
                    text: chat.content
                }]
            }
            if(multimodals && multimodals.length > 0){
                formatedChat.content = [{
                    type: 'text',
                    text: chat.content
                }]
                for(const modal of multimodals){
                    if(modal.type === 'image'){
                        const dataurl = modal.base64
                        const base64 = dataurl.split(',')[1]
                        const mediaType = dataurl.split(';')[0].split(':')[1]

                        formatedChat.content.unshift({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: mediaType,
                                data: base64
                            }
                        })
                    }
                }

            }
            if(chat.cache){
                if(db.claude1HourCaching){
                    formatedChat.content[0].cache_control = {
                        type: 'ephemeral',
                        ttl: "1h"
                    }
                }
                else{
                    formatedChat.content[0].cache_control = {
                        type: 'ephemeral'
                    }
                }
            }
            claudeChat.push(formatedChat)
        }
    }
    for(const chat of formated){
        switch(chat.role){
            case 'user':{
                addClaudeChat({
                    role: 'user',
                    content: chat.content,
                    cache: chat.cachePoint
                }, chat.multimodals)
                break
            }
            case 'assistant':{
                addClaudeChat({
                    role: 'assistant',
                    content: chat.content,
                    cache: chat.cachePoint
                }, chat.multimodals)
                break
            }
            case 'system':{
                if(claudeChat.length === 0){
                    systemPrompt += '\n\n' + chat.content
                }
                else{
                    addClaudeChat({
                        role: 'user',
                        content: "System: " + chat.content,
                        cache: chat.cachePoint
                    })
                }
                break
            }
            case 'function':{
                //ignore function for now
                break
            }
        }
    }
    if(claudeChat.length === 0 && systemPrompt === ''){
        return {
            type: 'fail',
            result: 'No input'
        }
    }
    if(claudeChat.length === 0 && systemPrompt !== ''){
        claudeChat.push({
            role: 'user',
            content: [{
                type: 'text',
                text: 'Start'
            }]
        })
        systemPrompt = ''
    }
    if(claudeChat[0].role !== 'user'){
        claudeChat.unshift({
            role: 'user',
            content: [{
                type: 'text',
                text: 'Start'
            }]
        })
    }

    //check for tool calls
    for(let j=0;j<claudeChat.length;j++){
        let chat = claudeChat[j]
        for(let i=0;i<chat.content.length;i++){
            let content = chat.content[i]
            if(content.type === 'text'){
                content.text = await replaceAsync(content.text,/<tool_call>(.*?)<\/tool_call>/g, async (match:string, p1:string) => {
                    try {
                        const parsed = await decodeToolCall(p1)
                        if(parsed?.call && parsed?.response){
                            const toolUse:Claude3ToolUseBlock = {
                                type: 'tool_use',
                                id: parsed.call.id,
                                name: parsed.call.name,
                                input: parsed.call.arg
                            }
                            const toolResponse:Claude3ToolResponseBlock = {
                                type: 'tool_result',
                                tool_use_id: parsed.call.id,
                                content: parsed.response.map((v:any) => {
                                    if(v.type === 'text'){
                                        return {
                                            type: 'text',
                                            text: v.text
                                        }
                                    }
                                    if(v.type === 'image'){
                                        return {
                                            type: 'image',
                                            source: {
                                                type: 'base64',
                                                media_type: v.mimeType,
                                                data: v.data
                                            }
                                        }
                                    }
                                    return {
                                        type: 'text',
                                        text: `Unsupported tool response type: ${v.type}`
                                    }
                                })
                            }
                            claudeChat.splice(j, 0, {
                                role: 'assistant',
                                content: [toolUse]
                            })

                            claudeChat.splice(j+1, 0, {
                                role: 'user',
                                content: [toolResponse]
                            })
                            j+=2
                            chat = claudeChat[j]
                            return ''
                        }
                    } catch (error) {
                        
                    }

                    return ''
                })
            }
        }
    }

    let finalChat:Claude3ExtendedChat[] = claudeChat

    if(aiModel === 'reverse_proxy'){
        finalChat = claudeChat.map((v) => {
            if(v.content.length > 0 && v.content[0].type === 'text'){
                return {
                    role: v.role,
                    content: v.content[0].text
                }
            }
        })
    }

    console.log(arg.modelInfo.parameters)
    let body = applyParameters({
        model: arg.modelInfo.internalID,
        messages: finalChat,
        system: systemPrompt.trim(),
        max_tokens: maxTokens,
        stream: useStreaming ?? false,
    }, arg.modelInfo.parameters, {
        'thinking_tokens': 'thinking.budget_tokens'
    }, arg.mode, {
        modelId: arg.modelInfo.id
    })

    // Handle thinking mode: off, adaptive, or budget
    // Opus 4.7+ and Mythos reject manual `thinking.type: enabled` — force adaptive.
    const adaptiveOnly = arg.modelInfo.flags.includes(LLMFlags.claudeAdaptiveThinkingOnly)
        || isClaudeAdaptiveThinkingOnlyModel(arg.modelInfo.internalID)
        || isClaudeAdaptiveThinkingOnlyModel(arg.modelInfo.id)
    const adaptiveCapable = adaptiveOnly || arg.modelInfo.flags.includes(LLMFlags.claudeAdaptiveThinking)

    if(db.thinkingType === 'off' && !adaptiveOnly){
        delete body.thinking
        delete body.output_config
    }
    else if(adaptiveOnly){
        // Adaptive-only models (Opus 4.7+): thinking off by default; opt-in via thinkingType.
        // Sampling params return 400 on any non-default value — omit entirely (per Anthropic docs).
        delete body.thinking
        delete body.temperature
        delete body.top_k
        delete body.top_p
        if(db.thinkingType !== 'off'){
            const thinkingObj: any = { type: 'adaptive' }
            // Opus 4.7 default is `display: "omitted"` (empty thinking field).
            // Opt back into summarized text when user toggles the setting on.
            if(db.claudeAdaptiveDisplaySummarized) thinkingObj.display = 'summarized'
            body.thinking = thinkingObj
        }
    }
    else if(db.thinkingType === 'adaptive' && adaptiveCapable){
        delete body.thinking
        const thinkingObj: any = { type: 'adaptive' }
        if(db.claudeAdaptiveDisplaySummarized) thinkingObj.display = 'summarized'
        body.thinking = thinkingObj
        body.temperature = 1
        delete body.top_k
        delete body.top_p
    }

    // Effort is independent from thinking — applies to all output tokens.
    // Send whenever model supports adaptive (and thus effort) and value is non-default.
    if(adaptiveCapable && db.adaptiveThinkingEffort && db.adaptiveThinkingEffort !== 'high'){
        body.output_config = { ...(body.output_config || {}), effort: db.adaptiveThinkingEffort }
    } else if(!adaptiveCapable){
        delete body.output_config
    }
    else if(body?.thinking?.budget_tokens === 0){
        delete body.thinking
    }
    else if(body?.thinking?.budget_tokens && body?.thinking?.budget_tokens > 0){
        body.thinking.type = 'enabled'
    }
    else if(body?.thinking?.budget_tokens === null){
        delete body.thinking
    }

    if(systemPrompt === ''){
        delete body.system
    }

    const bedrock = arg.modelInfo.format === LLMFormat.AWSBedrockClaude

    if(bedrock && aiModel !== 'reverse_proxy'){
        function getCredentialParts(key:string) {
            const [accessKeyId, secretAccessKey, region] = key.split(":");
          
            if (!accessKeyId || !secretAccessKey || !region) {
              throw new Error("The key assigned to this request is invalid.");
            }
          
            return { accessKeyId, secretAccessKey, region };
        }
        const { accessKeyId, secretAccessKey, region } = getCredentialParts(apiKey);

        const AMZ_HOST = "bedrock-runtime.%REGION%.amazonaws.com";
        const host = AMZ_HOST.replace("%REGION%", region);
        const stream = false;   // todo?

        // https://docs.claude.com/en/api/claude-on-amazon-bedrock#global-vs-regional-endpoints
        let useGlobal = false;
        
        const datePart = Number(arg.modelInfo.internalID.match(/(\d{8})/)?.[0]);
        const versionMatch = arg.modelInfo.internalID.match(/claude-(?:opus-|sonnet-|haiku-)?(\d+)-(\d+)/);

        if (datePart && !isNaN(datePart)) {
            useGlobal = datePart >= 20250929;
        } else if (versionMatch) {
            const majorVersion = Number(versionMatch[1]);
            const minorVersion = Number(versionMatch[2]);
            useGlobal = (majorVersion > 4) || (majorVersion === 4 && minorVersion >= 5);
        }

        const awsModel = useGlobal 
            ? "global." + arg.modelInfo.internalID 
            : "us." + arg.modelInfo.internalID;

        const url = `https://${host}/model/${awsModel}/invoke${stream ? "-with-response-stream" : ""}`

        let params = {...body}
        params.anthropic_version = "bedrock-2023-05-31"
        delete params.model
        delete params.stream
        if (params.thinking?.type === "enabled" || params.thinking?.type === "adaptive"){
            params.temperature = 1.0
            delete params.top_k
            delete params.top_p
        }

        const rq = new HttpRequest({
            method: "POST",
            protocol: "https:",
            hostname: host,
            path: `/model/${awsModel}/invoke${stream ? "-with-response-stream" : ""}`,
            headers: {
              ["Host"]: host,
              ["Content-Type"]: "application/json",
              ["accept"]: "application/json",
            },
            body: JSON.stringify(params),
        });
        
        const signer = new SignatureV4({
            sha256: Sha256,
            credentials: { accessKeyId, secretAccessKey },
            region,
            service: "bedrock",
        });
        
        const signed = await signer.sign(rq);

        if(arg.previewBody){
            return {
                type: 'success',
                result: JSON.stringify({
                    url: url,
                    body: params,
                    headers: signed.headers
                })
            }

        }

        const res = await globalFetch(url, {
            method: "POST",
            body: params,
            headers: signed.headers,
            plainFetchForce: true,
            chatId: arg.chatId,
            abortSignal: arg.abortSignal,
            interceptor: 'anthropic_bedrock'
        })

        if(!res.ok){
            return {
                type: 'fail',
                result: JSON.stringify(res.data)
            }
        }
        if(res.data.error){
            return {
                type: 'fail',
                result: JSON.stringify(res.data.error)
            }
        }
        const contents = res?.data?.content
        if(!contents || contents.length === 0){
            return {
                type: 'fail',
                result: JSON.stringify(res.data)
            }
        }
        let resText = ''
        let thinking = false
        for(const content of contents){
            if(content.type === 'text'){
                if(thinking){
                    resText += "</Thoughts>\n\n"
                    thinking = false
                }
                resText += content.text
            }
            if(content.type === 'thinking'){
                if(!thinking){
                    resText += "<Thoughts>\n"
                    thinking = true
                }
                resText += content.thinking ?? ''
            }
            if(content.type === 'redacted_thinking'){
                if(!thinking){
                    resText += "<Thoughts>\n"
                    thinking = true
                }
                resText += '\n{{redacted_thinking}}\n'
            }
        }
    
    
        if(arg.extractJson && db.jsonSchemaEnabled){
            return {
                type: 'success',
                result: extractJSON(resText, db.jsonSchema)
            }
        }
        return {
            type: 'success',
            result: resText
        }
    }


    let headers:{
        [key:string]:string
    } = {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "accept": "application/json",
    }

    const isCopilot = isCopilotURL(replacerURL)

    // Copilot: Bearer auth instead of x-api-key, drop anthropic-version
    if (isCopilot) {
        headers["Authorization"] = "Bearer " + apiKey
        delete headers['anthropic-version']
    }

    let betas:string[] = []

    // Skip Anthropic-specific beta headers for Copilot
    if (!isCopilot) {
        if(body.max_tokens > 8192){
            betas.push('output-128k-2025-02-19')
        }

        if(db.claude1HourCaching){
            betas.push('extended-cache-ttl-2025-04-11')
        }
    }

    if(betas.length > 0){
        headers['anthropic-beta'] = betas.join(',')
    }

    if(db.usePlainFetch){
        headers['anthropic-dangerous-direct-browser-access'] = 'true'
    }

    if(arg.tools && arg.tools.length > 0){
        body.tools = arg.tools.map((v) => {
            return {
                name: v.name,
                description: v.description,
                input_schema: simplifySchema(v.inputSchema)
            }
        })

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

    if(db.claudeBatching){
        if(body.stream !== undefined){
            delete body.stream
        }
        const id = v4()
        const resp = await fetchNative(replacerURL + '/batches', {
            "body": JSON.stringify({
                "requests": [{
                    "custom_id": id,
                    "params": body,
                }]
            }),
            "method": "POST",
            signal: arg.abortSignal,
            headers: headers,
            interceptor: 'anthropic_batching'
        })

        if(resp.status !== 200){
            return {
                type: 'fail',
                result: await textifyReadableStream(resp.body)
            }
        }

        const r = (await resp.json())

        if(!r.id){
            return {
                type: 'fail',
                result: 'No results URL returned from Claude batch request'
            }
        }

        const statusUrl = replacerURL + `/batches/${r.id}`
        const resultsUrl = replacerURL + `/batches/${r.id}/results`
        const cancelUrl = replacerURL + `/batches/${r.id}/cancel`
        const abortSignal = arg.abortSignal

        // Streaming is used in batch API to apply successful response even after abortSignal is fired
        // In order to do otherwise, `request.ts` and `index.svelte.ts` should be edited to bypass abort signal check
        const stream = new ReadableStream<StreamResponseChunk>({
            async start(controller){
                const batchStartTime = Date.now()
                const BATCH_TIMEOUT = 24 * 60 * 60 * 1000 + 600 * 1000 // 24 hours + 10 minutes
                let cancelRequested = false

                while(true){
                    try {
                        await sleep(3000)
                        if(abortSignal?.aborted && !cancelRequested){
                            cancelRequested = true
                            try {
                                await fetchNative(cancelUrl, {
                                    "body": "{}",
                                    "method": "POST",
                                    "headers": headers,
                                    "interceptor": 'anthropic_batching_cancel'
                                })
                            } catch(e) {
                                // ignore cancel request errors
                            }
                        }
                        if(Date.now() - batchStartTime > BATCH_TIMEOUT){
                            controller.error(new Error('Claude batch request timed out after 24 hours'))
                            return
                        }

                        const statusRes = await fetchNative(statusUrl, {
                            "method": "GET",
                            "headers": headers,
                            "signal": cancelRequested ? undefined : abortSignal,
                            "interceptor": 'anthropic_batching_status'
                        })

                        if(statusRes.status !== 200){
                            controller.error(new Error(await textifyReadableStream(statusRes.body)))
                            return
                        }

                        const statusData = await statusRes.json()

                        if(statusData.processing_status !== 'ended'){
                            continue
                        }

                        const batchRes = await fetchNative(resultsUrl, {
                            "method": "GET",
                            "headers": headers,
                            "signal": cancelRequested ? undefined : abortSignal,
                            "interceptor": 'anthropic_batching_results'
                        })

                        if(batchRes.status !== 200){
                            controller.error(new Error(await textifyReadableStream(batchRes.body)))
                            return
                        }

                        //since jsonl
                        const batchTextData = (await batchRes.text()).split('\n').filter((v) => v.trim() !== ''). map((v) => {
                            try {
                                return JSON.parse(v)
                            } catch (error) {
                                return null
                            }
                        }).filter((v) => v !== null)
                        
                        for(const batchData of batchTextData){
                            const type = batchData?.result?.type
                            console.log('Claude batch result type:', type)
                            if(batchData?.result?.type === 'succeeded'){
                                const contents = batchData.result.message.content ?? []
                                let resText = ''
                                let thinking = false
                                for(const content of contents){
                                    if(content.type === 'text'){
                                        if(thinking){
                                            resText += "</Thoughts>\n\n"
                                            thinking = false
                                        }
                                        resText += content.text
                                    }
                                    if(content.type === 'thinking'){
                                        if(!thinking){
                                            resText += "<Thoughts>\n"
                                            thinking = true
                                        }
                                        resText += content.thinking ?? ''
                                    }
                                    if(content.type === 'redacted_thinking'){
                                        if(!thinking){
                                            resText += "<Thoughts>\n"
                                            thinking = true
                                        }
                                        resText += '\n{{redacted_thinking}}\n'
                                    }
                                }

                                if(thinking){
                                    resText += "</Thoughts>\n\n"
                                    thinking = false
                                }

                                controller.enqueue({ "0": resText })
                                controller.close()
                                return
                            }
                            if(batchData?.result?.type === 'errored'){
                                const batchError = batchData.result.error

                                const message = batchError?.error?.message ? 
                                `${batchError.error.type}: ${batchError.error.message}` : 
                                JSON.stringify(batchError)

                                controller.error(new Error(message))
                                return
                            }
                            if(batchData?.result?.type === 'canceled'){
                                controller.close()
                                return
                            }
                            if(batchData?.result?.type === 'expired'){
                                controller.error(new Error('Claude batch request expired'))
                                return
                            }
                        }
                    } catch (error) {
                        console.error('Error while waiting for Claude batch results:', error)
                    }
                }
            }
        })

        return {
            type: 'streaming',
            result: stream
        }
    }
    
    
    if(db.claudeRetrivalCaching){
        registerClaudeObserver({
            url: replacerURL,
            body: body,
            headers: headers
        })
    }

    // Copilot: strip trailing assistant messages (prefill not supported)
    if (isCopilot) {
        while (body.messages?.length > 0 && body.messages[body.messages.length - 1]?.role === 'assistant') {
            body.messages.pop()
        }
    }

    return requestClaudeHTTP(replacerURL, headers, body, arg)
}

function isCopilotURL(url: string): boolean {
    return url.includes('githubcopilot.com') || url.includes('copilot')
}

let _copilotInteractionId: string | null = null
function getCopilotInteractionId(): string {
    if (!_copilotInteractionId) _copilotInteractionId = v4()
    return _copilotInteractionId
}

function applyCopilotTaskHeaders(headers: { [key: string]: string }, url: string, taskId?: string, isContinuation = false): string | undefined {
    if (!isCopilotURL(url)) return taskId
    const id = taskId ?? v4()
    headers['X-Request-Id'] = id
    headers['X-Agent-Task-Id'] = id
    headers['X-Interaction-Id'] = getCopilotInteractionId()
    headers['X-Initiator'] = isContinuation ? 'agent' : 'user'
    headers['OpenAI-Intent'] = 'conversation-panel'
    headers['X-GitHub-Api-Version'] = '2025-05-01'
    if (url.includes('/v1/messages')) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14,context-management-2025-06-27,advanced-tool-use-2025-11-20'
    }
    return id
}

async function requestClaudeHTTP(replacerURL:string, headers:{[key:string]:string}, body:any, arg:RequestDataArgumentExtended, copilotTaskId?: string):Promise<requestDataResponse> {

    const isContinuation = copilotTaskId !== undefined
    copilotTaskId = applyCopilotTaskHeaders(headers, replacerURL, copilotTaskId, isContinuation)
    
    if(arg.useStreaming){

        let res: Response
        let lastErrText = ''
        const STREAM_MAX_RETRIES = 5
        // Exponential-ish backoff: 3s, 6s, 12s, 20s, 30s
        const RETRY_DELAYS_MS = [3000, 6000, 12000, 20000, 30000]
        for(let attempt = 0; attempt < STREAM_MAX_RETRIES; attempt++){
            try {
                res = await fetchNative(replacerURL, {
                    body: JSON.stringify(body),
                    headers: headers,
                    method: "POST",
                    chatId: arg.chatId,
                    signal: arg.abortSignal,
                    interceptor: 'anthropic_streaming'
                })
            } catch(fetchErr: any) {
                // Network error (ERR_INCOMPLETE_CHUNKED_ENCODING, TypeError: network error, etc.)
                console.warn(`[Anthropic Stream] Fetch error on attempt ${attempt + 1}/${STREAM_MAX_RETRIES}: ${fetchErr?.message || fetchErr}`)
                lastErrText = fetchErr?.message || 'network error'
                if(attempt < STREAM_MAX_RETRIES - 1){
                    const waitMs = RETRY_DELAYS_MS[attempt] ?? 30000
                    await sleep(waitMs)
                    continue
                }
                return { type: 'fail' as const, result: `Network error after ${STREAM_MAX_RETRIES} retries: ${lastErrText}` }
            }
            if(res.status === 200){
                lastErrText = ''
                break
            }
            // Non-200: drain body once into lastErrText for diagnostics / retry decision
            lastErrText = await textifyReadableStream(res.body)
            // Retry on transient errors
            if(attempt < STREAM_MAX_RETRIES - 1 && (res.status === 429 || res.status >= 500 || res.status === 400)){
                const isRetryable = res.status === 429 || res.status >= 500
                    || lastErrText?.includes('model_not_supported')
                    || lastErrText?.includes('overload')
                    || lastErrText?.includes('unavailable')
                if(isRetryable){
                    const waitMs = RETRY_DELAYS_MS[attempt] ?? 30000
                    console.warn(`[Anthropic Stream] Retry ${attempt + 1}/${STREAM_MAX_RETRIES} after ${waitMs}ms: ${lastErrText.substring(0, 100)}`)
                    await sleep(waitMs)
                    continue
                }
            }
            break
        }

        if(res.status !== 200){
            return {
                type: 'fail',
                result: lastErrText || `HTTP ${res.status}`
            }
        }
        let breakError = ''
        let thinking = false

        // Track tool_use blocks during streaming for MCP tool call handling
        let streamToolUseBlocks: any[] = []
        let currentToolBlock: any = null
        let streamStopReason: string | null = null
        let streamContentBlocks: any[] = []

        const stream = new ReadableStream<StreamResponseChunk>({
            async start(controller){
                let text = ''
                let reader = res.body.getReader()
                let parserData = ''
                const decoder = new TextDecoder()
                const parseEvent = ((e:string) => {
                    try {
                        const parsedData = JSON.parse(e)

                        if(parsedData?.type === 'content_block_start'){
                            const cb = parsedData?.content_block
                            if(cb?.type === 'tool_use'){
                                currentToolBlock = {
                                    type: 'tool_use',
                                    id: cb.id,
                                    name: cb.name,
                                    input: {},
                                    _inputJson: ''
                                }
                                streamContentBlocks.push(currentToolBlock)
                                console.warn(`%c[Tool Call] ${cb.name}`, 'color: #4fc3f7; font-weight: bold', { id: cb.id })
                            } else if(cb?.type === 'text'){
                                currentToolBlock = { type: 'text', text: '' }
                                streamContentBlocks.push(currentToolBlock)
                            } else if(cb?.type === 'thinking'){
                                currentToolBlock = { type: 'thinking', thinking: '', signature: '' }
                                streamContentBlocks.push(currentToolBlock)
                            } else if(cb?.type === 'redacted_thinking'){
                                currentToolBlock = { type: 'redacted_thinking', data: cb.data || '' }
                                streamContentBlocks.push(currentToolBlock)
                                if(!thinking){
                                    text += "<Thoughts>\n"
                                    thinking = true
                                }
                                text += '\n{{redacted_thinking}}\n'
                            } else {
                                currentToolBlock = null
                            }
                        }

                        if(parsedData?.type === 'content_block_delta'){
                            const dt = parsedData?.delta
                            if(dt?.type === 'input_json_delta' && currentToolBlock?.type === 'tool_use'){
                                currentToolBlock._inputJson += (dt.partial_json || '')
                            }
                            else if(dt?.type === 'text' || dt?.type === 'text_delta'){
                                if(currentToolBlock?.type === 'text'){
                                    currentToolBlock.text += dt?.text ?? ''
                                }
                                if(thinking){
                                    text += "</Thoughts>\n\n"
                                    thinking = false
                                }
                                text += dt?.text ?? ''
                            }
                            else if(dt?.type === 'thinking' || dt?.type === 'thinking_delta'){
                                if(currentToolBlock?.type === 'thinking'){
                                    currentToolBlock.thinking += dt?.thinking ?? ''
                                }
                                if(!thinking){
                                    text += "<Thoughts>\n"
                                    thinking = true
                                }
                                text += dt?.thinking ?? ''
                            }
                            else if(dt?.type === 'signature_delta'){
                                if(currentToolBlock?.type === 'thinking'){
                                    currentToolBlock.signature = dt?.signature ?? ''
                                }
                            }
                            else if(dt?.type === 'redacted_thinking'){
                                if(!thinking){
                                    text += "<Thoughts>\n"
                                    thinking = true
                                }
                                text += '\n{{redacted_thinking}}\n'
                            }
                        }

                        if(parsedData?.type === 'content_block_stop'){
                            if(currentToolBlock?.type === 'tool_use'){
                                const rawJson = currentToolBlock._inputJson || '{}'
                                try { currentToolBlock.input = JSON.parse(rawJson) } catch { currentToolBlock.input = {} }
                                delete currentToolBlock._inputJson
                                streamToolUseBlocks.push(currentToolBlock)
                                console.warn(`%c[Tool Input] ${currentToolBlock.name}`, 'color: #81c784; font-weight: bold', currentToolBlock.input)
                            }
                            currentToolBlock = null
                        }

                        if(parsedData?.type === 'message_delta'){
                            streamStopReason = parsedData?.delta?.stop_reason || null
                        }

                        if(parsedData?.type === 'error'){
                            const errormsg:string = parsedData?.error?.message
                            if(errormsg && errormsg.toLocaleLowerCase().includes('overload') && db.antiServerOverloads){
                                controller.enqueue({
                                    "0": "Overload detected, retrying..."
                                })

                                return 'overload'
                            }
                            text += "Error:" + parsedData?.error?.message

                        }

                    }
                    catch (error) {
                    }



                })
                let breakWhile = false
                let i = 0;
                let prevText = ''
                let streamRetryCount = 0
                const STREAM_MID_RETRY_MAX = 2
                while(true){
                    try {
                        if(arg?.abortSignal?.aborted || breakWhile){
                            break
                        }
                        const {done, value} = await reader.read()
                        if(done){
                            // Check if stream ended prematurely (no stop_reason received)
                            if(!streamStopReason && !text){
                                // Empty response with no stop_reason = broken stream, treat as error
                                throw new Error('Stream ended prematurely (no data received)')
                            }
                            if(!streamStopReason && text && !breakWhile){
                                // Had text but no stop_reason = truncated response, treat as error for retry
                                throw new Error('Stream truncated (no stop_reason)')
                            }
                            break
                        }
                        streamRetryCount = 0 // reset on successful read
                        parserData += (decoder.decode(value))
                        let parts = parserData.split('\n')
                        for(;i<parts.length-1;i++){
                            prevText = text
                            if(parts?.[i]?.startsWith('data: ')){
                                const d = await parseEvent(parts[i].slice(6))
                                if(d === 'overload'){
                                    parserData = ''
                                    prevText = ''
                                    text = ''
                                    reader.cancel()
                                    const res = await fetchNative(replacerURL, {
                                        body: JSON.stringify(body),
                                        headers: headers,
                                        method: "POST",
                                        chatId: arg.chatId,
                                        signal: arg.abortSignal,
                                        interceptor: 'anthropic_streaming_retry'
                                    })
                            
                                    if(res.status !== 200){
                                        controller.enqueue({
                                            "0": await textifyReadableStream(res.body)
                                        })
                                        breakWhile = true
                                        break
                                    }

                                    reader = res.body.getReader()
                                    break
                                }
                            }
                        }
                        i--;
                        text = prevText

                        controller.enqueue({
                            "0": text
                        })

                    } catch (error) {
                        if(arg?.abortSignal?.aborted) break

                        // Preserve completed tool_use blocks — execute them and let Claude continue
                        if(streamToolUseBlocks.length > 0){
                            console.warn(`[Anthropic Stream] Connection lost (${error?.message || ''}), but ${streamToolUseBlocks.length} tool(s) completed — proceeding with tool execution as if stop_reason=tool_use`)
                            streamStopReason = 'tool_use'
                            try { reader.cancel() } catch {}
                            break
                        }

                        // Preserve completed text/thinking via prefix continuation
                        // Push partial assistant response as message and ask to continue
                        const completedBlocks = streamContentBlocks.filter(b =>
                            b.type === 'text' ||
                            b.type === 'redacted_thinking' ||
                            (b.type === 'thinking' && b.thinking && b.thinking.length > 0)
                        )
                        const hasContent = completedBlocks.length > 0 || text.length > 0

                        streamRetryCount++
                        if(streamRetryCount > STREAM_MID_RETRY_MAX){
                            breakError = `Stream failed after ${STREAM_MID_RETRY_MAX} retries`
                            break
                        }
                        const waitMs = Math.min(streamRetryCount * 5000, 30000)

                        if(hasContent){
                            console.warn(`[Anthropic Stream] Connection lost (${error?.message || ''}), attempting continuation-style retry: ${text.length} chars + ${completedBlocks.length} blocks preserved, ${streamRetryCount}/${STREAM_MID_RETRY_MAX} in ${waitMs}ms`)
                            try { reader.cancel() } catch {}
                            await sleep(waitMs)
                            // Build proper multi-turn: assistant with partial content + user "continue" instruction
                            // This avoids prefill (which Copilot rejects) and uses valid Anthropic multi-turn structure
                            const contBody = JSON.parse(JSON.stringify(body))
                            const blocksForContinuation = [...completedBlocks]
                            const hasCompletedText = completedBlocks.some(b => b.type === 'text')
                            if(!hasCompletedText && text){
                                blocksForContinuation.push({ type: 'text', text })
                            }
                            // Partial text not captured in content_block_stop yet — include it
                            if(hasCompletedText && text){
                                const lastTextBlock = [...blocksForContinuation].reverse().find(b => b.type === 'text')
                                if(lastTextBlock && text.length > (lastTextBlock.text?.length || 0)){
                                    lastTextBlock.text = text
                                }
                            }
                            contBody.messages = [
                                ...(contBody.messages || []),
                                { role: 'assistant', content: blocksForContinuation },
                                { role: 'user', content: '[SYSTEM: The previous response was cut off mid-generation due to a network error. Your partial output above was captured. Do NOT repeat any of it — continue seamlessly from the exact point it was cut, as if resuming mid-sentence if necessary. Preserve tone, style, and formatting from your partial response.]' }
                            ]
                            try {
                                const retryRes = await fetchNative(replacerURL, {
                                    body: JSON.stringify(contBody),
                                    headers: headers,
                                    method: "POST",
                                    chatId: arg.chatId,
                                    signal: arg.abortSignal,
                                    interceptor: 'anthropic_streaming_prefix_retry'
                                })
                                if(retryRes.status === 200){
                                    reader = retryRes.body.getReader()
                                    parserData = ''
                                    // Reset per-stream state but KEEP accumulated text/blocks (will append)
                                    streamStopReason = null
                                    currentToolBlock = null
                                    i = 0
                                    continue
                                }
                                console.warn(`[Anthropic Stream] Continuation retry got ${retryRes.status} — falling back to full retry`)
                                try { await textifyReadableStream(retryRes.body) } catch {}
                            } catch(contErr) {
                                console.warn(`[Anthropic Stream] Continuation retry error: ${contErr?.message || contErr} — falling back to full retry`)
                            }
                        }

                        // Full retry fallback
                        console.warn(`[Anthropic Stream] Full retry ${streamRetryCount}/${STREAM_MID_RETRY_MAX} in ${waitMs}ms (had ${text.length} chars, 0 completed tools)`)
                        try { reader.cancel() } catch {}
                        text = ''
                        parserData = ''
                        prevText = ''
                        thinking = false
                        streamToolUseBlocks = []
                        currentToolBlock = null
                        streamStopReason = null
                        streamContentBlocks = []
                        i = 0
                        await sleep(waitMs)
                        try {
                            const retryRes = await fetchNative(replacerURL, {
                                body: JSON.stringify(body),
                                headers: headers,
                                method: "POST",
                                chatId: arg.chatId,
                                signal: arg.abortSignal,
                                interceptor: 'anthropic_streaming_retry'
                            })
                            if(retryRes.status === 200){
                                reader = retryRes.body.getReader()
                                parserData = ''
                                continue
                            }
                            console.warn(`[Anthropic Stream] Retry got ${retryRes.status}`)
                            try { await textifyReadableStream(retryRes.body) } catch {}
                        } catch(retryErr) {
                            console.warn(`[Anthropic Stream] Retry fetch error: ${retryErr?.message || retryErr}`)
                        }
                    }
                }

                // If stream broke with an error, emit it as text and close normally
                // (controller.error() causes unhandled alert popups)
                if(breakError){
                    controller.enqueue({ "0": text + `\n\n---\n**[${breakError}. Please retry (reroll).]**` })
                    controller.close()
                    return
                }

                // Rescue incomplete tool_use block that didn't get content_block_stop
                if(currentToolBlock?.type === 'tool_use'){
                    const rawJson = currentToolBlock._inputJson || '{}'
                    try { currentToolBlock.input = JSON.parse(rawJson) } catch { currentToolBlock.input = {} }
                    delete currentToolBlock._inputJson
                    streamToolUseBlocks.push(currentToolBlock)
                    console.warn(`[Anthropic Stream] Rescued incomplete tool_use: ${currentToolBlock.name}`, currentToolBlock.input)
                    currentToolBlock = null
                    if(!streamStopReason) streamStopReason = 'tool_use'
                }

                // Handle tool_use in streaming: execute tools and send results back
                console.warn(`%c[Stream End]`, 'color: #aaa', `stop_reason=${streamStopReason} | toolUseBlocks=${streamToolUseBlocks.length} | textLen=${text.length}`)
                // Whenever the model produced tool_use blocks, run them and continue —
                // regardless of stop_reason. Anthropic's signal varies (tool_use, pause_turn,
                // sometimes end_turn via Vertex/Copilot proxies), so trust the content.
                if(streamToolUseBlocks.length > 0){
                    const messages: Claude3ExtendedChat[] = body.messages
                    const filteredBlocks = streamContentBlocks.filter(b =>
                        b.type === 'text' || b.type === 'tool_use' ||
                        b.type === 'redacted_thinking' ||
                        (b.type === 'thinking' && b.thinking && b.thinking.length > 0)
                    )
                    messages.push({
                        role: 'assistant',
                        content: filteredBlocks
                    })
                    const toolResponse: Claude3Chat = { role: 'user', content: [] }
                    for(const toolBlock of streamToolUseBlocks){
                        console.warn(`%c[Tool Exec] ${toolBlock.name}`, 'color: #ffb74d; font-weight: bold', 'Starting...')
                        const execStart = performance.now()
                        const used = await callTool(toolBlock.name, toolBlock.input)
                        const r: Claude3ToolResponseBlock = {
                            type: 'tool_result',
                            tool_use_id: toolBlock.id,
                            content: used.map((v) => {
                                switch(v.type){
                                    case 'text': return { type: 'text', text: v.text }
                                    case 'image': return { type: 'image', source: { type: 'base64', media_type: v.mimeType, data: v.data } }
                                    default: return { type: 'text', text: `Unsupported: ${v.type}` }
                                }
                            })
                        }
                        console.warn(`%c[Tool Result] ${toolBlock.name}`, 'color: #a5d6a7; font-weight: bold',
                            `${Math.round(performance.now() - execStart)}ms`,
                            used.map(v => v.type === 'text' ? v.text?.substring(0, 200) : `[${v.type}]`))
                        toolResponse.content.push(r)
                        if(arg.rememberToolUsage){
                            arg.additionalOutput ??= ''
                            arg.additionalOutput += await encodeToolCall({
                                call: { id: toolBlock.id, name: toolBlock.name, arg: toolBlock.input },
                                response: used
                            })
                        }
                    }
                    messages.push(toolResponse)
                    body.messages = messages
                    if(thinking){
                        text += "</Thoughts>\n\n"
                        thinking = false
                        controller.enqueue({ "0": text })
                    }
                    // Streaming continuation — retries handled by requestClaudeHTTP's fetch retry logic
                    body.stream = true
                    console.warn(`%c[Tool Continuation]`, 'color: #ce93d8; font-weight: bold', `Resuming with ${streamToolUseBlocks.length} tool result(s)...`)
                    const TOOL_CONT_MAX_RETRIES = 5
                    let toolContSuccess = false
                    for(let toolContAttempt = 0; toolContAttempt < TOOL_CONT_MAX_RETRIES; toolContAttempt++){
                        try {
                            const continuationResult = await requestClaudeHTTP(replacerURL, headers, body, arg, copilotTaskId)
                            if(continuationResult.type === 'streaming'){
                                const contReader = (continuationResult.result as ReadableStream).getReader()
                                let contText = ''
                                let contBroken = false
                                let contChunks = 0
                                try {
                                    while(true){
                                        const {done: cDone, value: cValue} = await contReader.read()
                                        if(cDone) break
                                        contChunks++
                                        contText = (cValue as any)?.["0"] ?? ''
                                        controller.enqueue({ "0": text + contText })
                                    }
                                } catch(readErr) {
                                    console.warn(`[Tool Continuation] Stream read error on attempt ${toolContAttempt + 1}: ${readErr?.message || readErr}`)
                                    contBroken = true
                                }
                                // Check if continuation actually produced meaningful output
                                if(!contBroken && contChunks > 0 && contText && !contText.includes('[Tool continuation failed') && !contText.includes('[Stream failed')){
                                    toolContSuccess = true
                                    break
                                }
                                if(!contBroken && contChunks === 0){
                                    console.warn(`[Tool Continuation] Empty response on attempt ${toolContAttempt + 1}`)
                                    contBroken = true
                                }
                                // Fall through to retry
                            } else if(continuationResult.type === 'success'){
                                controller.enqueue({ "0": text + continuationResult.result })
                                toolContSuccess = true
                                break
                            } else {
                                const errMsg = continuationResult.result || 'unknown error'
                                console.warn(`[Tool Continuation] Attempt ${toolContAttempt + 1}/${TOOL_CONT_MAX_RETRIES} failed: ${String(errMsg).substring(0, 100)}`)
                            }
                        } catch(e: any) {
                            console.warn(`[Tool Continuation] Attempt ${toolContAttempt + 1}/${TOOL_CONT_MAX_RETRIES} error: ${e?.message || e}`)
                        }
                        // Retry with backoff
                        if(toolContAttempt < TOOL_CONT_MAX_RETRIES - 1){
                            const waitMs = Math.min((toolContAttempt + 1) * 5000, 30000)
                            console.warn(`[Tool Continuation] Retrying in ${waitMs}ms...`)
                            await sleep(waitMs)
                            continue
                        }
                    }
                    if(!toolContSuccess){
                        controller.enqueue({ "0": '\n\n---\n**[Tool continuation failed after all retries. Please retry (reroll).]**' })
                    }
                }

                controller.close()
            },
            cancel(){
            }
        })

        return {
            type: 'streaming',
            result: stream
        }

    }

    const db = getDatabase()
    let res: any
    const MAX_RETRIES = 5
    const RETRY_DELAYS_MS = [3000, 6000, 12000, 20000, 30000]
    for(let attempt = 0; attempt < MAX_RETRIES; attempt++){
        res = await globalFetch(replacerURL, {
            body: body,
            headers: headers,
            method: "POST",
            chatId: arg.chatId,
            abortSignal: arg.abortSignal,
            interceptor: 'anthropic_http'
        })

        if(res.ok && !res.data?.error) break

        // Retry on transient errors (model_not_supported, overload, 429, 500+, unavailable)
        const errStr = JSON.stringify(res.data)
        const isRetryable = res.status === 429
            || res.status >= 500
            || errStr?.includes('model_not_supported')
            || errStr?.includes('overload')
            || errStr?.includes('unavailable')
        if(!isRetryable || attempt >= MAX_RETRIES - 1) break

        const waitMs = RETRY_DELAYS_MS[attempt] ?? 30000
        console.log(`[Anthropic] Retry ${attempt + 1}/${MAX_RETRIES} after ${waitMs}ms: ${errStr.substring(0, 100)}`)
        await sleep(waitMs)
    }

    if(!res.ok){
        const stringlified = JSON.stringify(res.data)
        return {
            type: 'fail',
            result: stringlified,
            failByServerError: stringlified?.toLocaleLowerCase()?.includes('overload')
        }
    }
    if(res.data.error){
        const stringlified = JSON.stringify(res.data.error)
        return {
            type: 'fail',
            result: stringlified,
            failByServerError: stringlified?.toLocaleLowerCase()?.includes('overload')
        }
    }
    const contents = res?.data?.content
    if(!contents || contents.length === 0){
        return {
            type: 'fail',
            result: JSON.stringify(res.data)
        }
    }
    let resText = ''
    let thinking = false

    const hasToolUse = (contents as any[]).some((v) => v.type === 'tool_use')

    if(hasToolUse){

        const messages:Claude3ExtendedChat[] = body.messages
        const response:Claude3Chat = {
            role: 'user',
            content: []
        }
        
        for(const content of (contents as Claude3ContentBlock[])){
            if(messages[messages.length-1].role !== 'assistant'){
                messages.push({
                    role: 'assistant',
                    content: []
                })
            }
            if(typeof messages[messages.length-1].content === 'string'){
                messages[messages.length-1].content = [{
                    type: 'text',
                    text: messages[messages.length-1].content as string
                }]
            }

            if(content.type === 'tool_use'){
                const used = await callTool(content.name, content.input)
                const r:Claude3ToolResponseBlock = {
                    type: 'tool_result',
                    tool_use_id: content.id,
                    content: used.map((v) => {
                        switch(v.type){
                            case 'text':{
                                return {
                                    type: 'text',
                                    text: v.text,
                                }
                            }
                            case 'image':{
                                return {
                                    type: 'image',
                                    source: {
                                        type: 'base64',
                                        media_type: v.mimeType,
                                        data: v.data
                                    }
                                }
                            }
                            default:{
                                return {
                                    type: 'text',
                                    text: `Unsupported tool response type: ${v.type}`
                                }
                            }
                        }
                    })
                }
                response.content.push(r)
                if(arg.rememberToolUsage){
                    arg.additionalOutput ??= ''
                    arg.additionalOutput += await encodeToolCall({
                        call: {
                            id: content.id,
                            name: content.name,
                            arg: content.input
                        },
                        response: used
                    })
                }
            }

            (messages[messages.length-1] as Claude3Chat).content.push(content)
        }

        messages.push(response)

        body.messages = messages
        body.stream = false

        return requestClaudeHTTP(replacerURL, headers, body, arg, copilotTaskId)
    }
    for(const content of contents){
        if(content.type === 'text'){
            if(thinking){
                resText += "</Thoughts>\n\n"
                thinking = false
            }
            resText += content.text
        }
        if(content.type === 'thinking'){
            if(!thinking){
                resText += "<Thoughts>\n"
                thinking = true
            }
            resText += content.thinking ?? ''
        }
        if(content.type === 'redacted_thinking'){
            if(!thinking){
                resText += "<Thoughts>\n"
                thinking = true
            }
            resText += '\n{{redacted_thinking}}\n'
        }
        if(content.type === 'tool_use'){

        }
    }


    arg.additionalOutput ??= ""
    if(arg.extractJson && db.jsonSchemaEnabled){
        return {
            type: 'success',
            result: arg.additionalOutput + extractJSON(resText, db.jsonSchema)
        }
    }
    return {
        type: 'success',
        result: arg.additionalOutput + resText
    }
}
