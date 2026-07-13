import { get } from "svelte/store";
import { CharEmotion, selectedCharID } from "../stores.svelte";
import { type character, type customscript, getDatabase, getCurrentCharacter, getCurrentChat } from "../storage/database.svelte";
import { downloadFile } from "../globalApi.svelte";
import { alertError, notifySuccess } from "../alert";
import { language } from "src/lang";
import { selectSingleFile } from "../util";
import { assetRegex, type CbsConditions, risuChatParser as risuChatParserOrg, type simpleCharacterArgument } from "../parser/parser.svelte";
import { getModuleAssets, getModuleRegexScripts, getModuleTriggers } from "./modules";
import { HypaProcesser } from "./memory/hypamemory";
import { runLuaEditTrigger } from "./scriptings";
import { pluginV2 } from "../plugins/plugins.svelte";
import { runTrigger } from "./triggers";

const dreg = /{{data}}/g
const randomness = /\|\|\|/g

export type ScriptMode = 'editinput'|'editoutput'|'editprocess'|'editdisplay'

type pScript = {
    script: customscript,
    order: number
    actions: string[]
}

export async function processScript(char:character, data:string, mode:ScriptMode, cbsConditions:CbsConditions = {}){
    return (await processScriptFull(char, data, mode, -1, cbsConditions)).data
}

export function exportRegex(s?:customscript[]){
    let db = getDatabase()
    const script = s ?? db.globalscript
    const data = Buffer.from(JSON.stringify({
        type: 'regex',
        data: script
    }), 'utf-8')
    downloadFile(`regexscript_export.json`,data)
    notifySuccess(language.successExport)
}

export async function importRegex(o?:customscript[]):Promise<customscript[]>{
    o = o ?? []
    const filedata = (await selectSingleFile(['json'])).data
    if(!filedata){
        return o
    }
    let db = getDatabase()
    try {
        const imported= JSON.parse(Buffer.from(filedata).toString('utf-8'))
        if(imported.type === 'regex' && imported.data){
            const datas:customscript[] = imported.data
            const script = o
            for(const data of datas){
                script.push(data)
            }
            return o
        }
        else{
            alertError("File invaid or corrupted")
        }

    } catch (error) {
        alertError(error)
    }
    return o
}

let bestMatchCache = new Map<string, string>()
let processScriptCache = new Map<string, string>()

// Whole-pass result cache for editdisplay: processScriptCache only covers the
// post-Lua CBS+regex stage, so remount cascades re-ran every Lua edit trigger
// for identical message text. This memoizes the full pass keyed on the pre-Lua
// input + script/trigger identity. Staleness tradeoff is the same one
// processScriptCache already accepts for CBS variable reads: output that
// depends on state other than the inputs serves a stale result until the text
// changes or the GUI reloads (resetScriptCache).
const EDIT_DISPLAY_PASS_CACHE_MAX = 128
let editDisplayPassCache = new Map<string, string>()
let triggerCodeHashCache = new Map<string, string>()

function hashTriggerCode(code: string){
    const cached = triggerCodeHashCache.get(code)
    if(cached !== undefined){
        return cached
    }
    let hash = 5381
    for(let i = 0; i < code.length; i++){
        hash = ((hash << 5) + hash + code.charCodeAt(i)) | 0
    }
    const result = hash.toString(36) + ':' + code.length.toString(36)
    triggerCodeHashCache.set(code, result)
    return result
}

function getTriggerCodeSignature(char: character|simpleCharacterArgument){
    // Mirrors runLuaEditTrigger's trigger sourcing (char triggers + module triggers).
    const triggers = (char.triggerscript ?? []).concat(getModuleTriggers())
    let sig = ''
    for(const trigger of triggers){
        if(trigger?.effect?.[0]?.type === 'triggerlua'){
            sig += hashTriggerCode(trigger.effect[0].code ?? '') + ';'
        }
        else if(trigger?.type === 'display'){
            // v2 display triggers run inside the cached pass (runTrigger 'display');
            // their effect definitions are part of the pass identity — editing one
            // does not bump ReloadGUIPointer, so the key must catch it.
            sig += 'd' + hashTriggerCode(JSON.stringify(trigger.effect ?? null)) + ';'
        }
    }
    return sig
}

function generateScriptCacheKey(scripts: customscript[], data: string, mode: ScriptMode, chatID = -1, cbsConditions: CbsConditions = {}) {
    let hash = data + '|||' + mode + '|||';
    for (const script of scripts) {
        if(script.type !== mode){
            continue
        }
        hash += `${script.flag?.includes('<cbs>') ? risuChatParser(script.in, { chatID: chatID, cbsConditions }) : script.in}|||${script.out}${chatID}|||${script.flag ?? ''}|||${script.ableFlag ? 1 : 0}`;
    }
    return hash;
}

function cacheScript(hash:string, result:string){
    processScriptCache.set(hash, result)

    if(processScriptCache.size > 1000){
        processScriptCache.delete(processScriptCache.keys().next().value)
    }

}

function getScriptCache(hash:string){
    return processScriptCache.get(hash)
}

export function resetScriptCache(){
    processScriptCache = new Map()
    editDisplayPassCache = new Map()
    triggerCodeHashCache = new Map()
}

// Streaming script circuit breaker: while a message is streaming, one
// pathologically slow edit-script pass (heavy Lua triggers / catastrophic
// regex on partial text) must not be repeated on every chunk — a single
// over-budget pass suspends mid-stream edit passes for THAT message until
// the stream ends. The final full pass at stream end always runs, so the
// persisted result is byte-identical to today's behavior.
export const STREAM_SCRIPT_BUDGET_MS = 1000
const streamingScriptCircuit = {
    active: false,
    msgIndex: -1,
    tripped: false,
    // Stream epoch: an abandoned pass can resolve after its own stream ended
    // and a NEW stream re-armed the same message index (rerolls). The finally
    // trip must only apply to the stream that started the pass.
    token: 0,
}
export function armStreamingScriptCircuit(msgIndex: number){
    streamingScriptCircuit.active = true
    streamingScriptCircuit.msgIndex = msgIndex
    streamingScriptCircuit.tripped = false
    streamingScriptCircuit.token += 1
}
// Immediate trip for the stream loop's race timeout: without it, the global
// circuit stays untripped until the abandoned pass resolves, and every raw
// text update would launch a fresh render-side editdisplay pass in between.
export function tripStreamingScriptCircuit(){
    if(streamingScriptCircuit.active){
        streamingScriptCircuit.tripped = true
    }
}
export function disarmStreamingScriptCircuit(){
    streamingScriptCircuit.active = false
    streamingScriptCircuit.msgIndex = -1
    streamingScriptCircuit.tripped = false
}
export function isStreamingScriptTripped(){
    return streamingScriptCircuit.active && streamingScriptCircuit.tripped
}

export async function processScriptFull(char:character|simpleCharacterArgument, data:string, mode:ScriptMode, chatID = -1, cbsConditions:CbsConditions = {}){
    const circuitTarget = (mode === 'editoutput' || mode === 'editdisplay')
        && streamingScriptCircuit.active
        && chatID === streamingScriptCircuit.msgIndex
    const circuitToken = streamingScriptCircuit.token
    if(circuitTarget && streamingScriptCircuit.tripped){
        return {data, emoChanged: false}
    }
    let passCacheKey: string | null = null
    if(mode === 'editdisplay'){
        // Mirrors the scripts array construction inside processScriptFullInner.
        const db = getDatabase()
        const scripts = (db.presetRegex ?? []).concat(char.customscript).concat(getModuleRegexScripts())
        // chatID and cbsConditions are appended unconditionally: generateScriptCacheKey
        // only folds them in per matching editdisplay regex script, so with zero such
        // scripts two messages with identical raw text would collide even though CBS
        // output ({{chatindex}}, {{role}}, {{isfirstmsg}}, ...) depends on them. The
        // pluginV2 hook-set size keeps runtime hook add/remove from serving stale passes.
        passCacheKey = generateScriptCacheKey(scripts, data, mode, chatID, cbsConditions)
            + '|||CTX|' + chatID + '|' + (cbsConditions.firstmsg ? 1 : 0) + '|' + (cbsConditions.chatRole ?? '')
            + '|||P|' + pluginV2[mode].size
            + '|||LUA|' + getTriggerCodeSignature(char)
        const cached = editDisplayPassCache.get(passCacheKey)
        if(cached !== undefined){
            return {data: cached, emoChanged: false}
        }
    }
    const start = performance.now()
    try{
        const res = await processScriptFullInner(char, data, mode, chatID, cbsConditions)
        // Don't store passes for the actively streaming message: every chunk is
        // a unique input, and dozens of one-shot entries would churn the FIFO
        // cap and evict the static-message entries right before the post-stream
        // remount cascade needs them. The final post-disarm pass stores normally.
        if(passCacheKey !== null && !circuitTarget){
            editDisplayPassCache.set(passCacheKey, res.data)
            if(editDisplayPassCache.size > EDIT_DISPLAY_PASS_CACHE_MAX){
                editDisplayPassCache.delete(editDisplayPassCache.keys().next().value)
            }
        }
        return res
    }
    finally{
        const dur = performance.now() - start
        // Re-check live circuit state: a pass that started under a previous
        // stream may resolve after disarm (or after the next stream re-armed,
        // possibly on the SAME message index after a reroll), and must not trip
        // the circuit for a stream it did not run under.
        const stillTarget = circuitTarget
            && streamingScriptCircuit.active
            && chatID === streamingScriptCircuit.msgIndex
            && circuitToken === streamingScriptCircuit.token
        if(stillTarget && dur > STREAM_SCRIPT_BUDGET_MS){
            streamingScriptCircuit.tripped = true
            console.warn(`[StreamScriptCircuit] ${mode} pass took ${Math.round(dur)}ms (budget ${STREAM_SCRIPT_BUDGET_MS}ms) — suspending mid-stream script passes for message ${chatID} until stream end`)
        }
        else if(dur > 500){
            console.warn(`[ScriptPerf] processScriptFull ${mode} took ${Math.round(dur)}ms (msg ${chatID})`)
        }
    }
}

async function processScriptFullInner(char:character|simpleCharacterArgument, data:string, mode:ScriptMode, chatID = -1, cbsConditions:CbsConditions = {}){
    let db = getDatabase()
    let emoChanged = false
    data = await runLuaEditTrigger(char, mode, data, { index:chatID })

    if(mode === 'editdisplay'){
        const currentChar = getCurrentCharacter()
        if(currentChar){
            try{
                const perf = performance.now()
                const d = await runTrigger(currentChar, 'display', {
                    chat: getCurrentChat(),
                    displayMode: true,
                    displayData: data
                })
    
                data = d?.displayData ?? data
                console.log('Trigger time', performance.now() - perf)
            }
            catch(e){
                console.error(e)
            }
        }
    }

    if(pluginV2[mode].size > 0){
        for(const plugin of pluginV2[mode]){
            const res = await plugin(data)
            if(res !== null && res !== undefined){
                data = res
            }
        }
    }

    data = risuChatParser(data, { chatID: chatID, cbsConditions })
    const scripts = (db.presetRegex ?? []).concat(char.customscript).concat(getModuleRegexScripts())
    const hash = generateScriptCacheKey(scripts, data, mode, chatID, cbsConditions)
    const cached = getScriptCache(hash)
    if(cached){
        return {data: cached, emoChanged: false}
    }
    
    if(scripts.length === 0){
        cacheScript(hash, data)
        return {data, emoChanged}
    }
    function executeScript(pscript:pScript){
        const script = pscript.script
        
        if(script.in === ''){
            return
        }

        if(script.type === mode){

            let outScript2 = script.out.replaceAll("$n", "\n")
            let outScript = outScript2.replace(dreg, "$&")
            let flag = 'g'
            if(script.ableFlag){
                flag = script.flag || 'g'
            }
            if(outScript.startsWith('@@move_top') || outScript.startsWith('@@move_bottom') || pscript.actions.includes('move_top') || pscript.actions.includes('move_bottom')){
                flag = flag.replace('g', '') //temperary fix
            }
            if(outScript.endsWith('>') && !pscript.actions.includes('no_end_nl')){
                outScript += '\n'
            }
            //remove unsupported flag
            flag = flag.trim().replace(/[^dgimsuvy]/g, '')

            //remove repeated flags
            flag = flag.split('').filter((v, i, a) => a.indexOf(v) === i).join('')
            
            if(flag.length === 0){
                flag = 'u'
            }

            let input = script.in
            if(pscript.actions.includes('cbs')){
                input = risuChatParser(input, { chatID: chatID, cbsConditions })
            }

            const reg = new RegExp(input, flag)
            if(outScript.startsWith('@@') || pscript.actions.length > 0){
                if(reg.test(data)){
                    if(outScript.startsWith('@@emo ')){
                        const emoName = script.out.substring(6).trim()
                        let charemotions = get(CharEmotion)
                        let tempEmotion = charemotions[char.chaId]
                        if(!tempEmotion){
                            tempEmotion = []
                        }
                        if(tempEmotion.length > 4){
                            tempEmotion.splice(0, 1)
                        }
                        if(char.type !== 'simple'){
                            for(const emo of char.emotionImages){
                                if(emo[0] === emoName){
                                    const emos:[string, string,number] = [emo[0], emo[1], Date.now()]
                                    tempEmotion.push(emos)
                                    charemotions[char.chaId] = tempEmotion
                                    CharEmotion.set(charemotions)
                                    emoChanged = true
                                    break
                                }
                            }
                        }
                    }
                    else if((outScript.startsWith('@@inject') || pscript.actions.includes('inject')) && chatID !== -1){
                        const selchar = db.characters[get(selectedCharID)]
                        selchar.chats[selchar.chatPage].message[chatID].data = data
                        data = data.replace(reg, "")
                    }
                    else if(
                        outScript.startsWith('@@move_top') || outScript.startsWith('@@move_bottom') ||
                        pscript.actions.includes('move_top') || pscript.actions.includes('move_bottom')
                    ){
                        const isGlobal = flag.includes('g')
                        const matchAll = isGlobal ? data.matchAll(reg) : [data.match(reg)]
                        data = data.replace(reg, "")
                        for(const matched of matchAll){
                            if(matched){
                                const inData = matched[0]
                                let out = outScript.replace('@@move_top ', '').replace('@@move_bottom ', '')
                                    .replace(/(?<!\$)\$[0-9]+/g, (v)=>{
                                        const index = parseInt(v.substring(1))
                                        if(index < matched.length){
                                            return matched[index]
                                        }
                                        return v
                                    })
                                    .replace(/\$\&/g, inData)
                                    .replace(/(?<!\$)\$<([^>]+)>/g, (v) => {
                                        const groupName = parseInt(v.substring(2, v.length - 1))
                                        if(matched.groups && matched.groups[groupName]){
                                            return matched.groups[groupName]
                                        }
                                        return v
                                    })
                                if(outScript.startsWith('@@move_top') || pscript.actions.includes('move_top')){
                                    data = out + '\n' +data
                                }
                                else{
                                    data = data + '\n' + out
                                }
                            }
                        }
                        data = risuChatParser(data, { chatID: chatID, cbsConditions })
                    }
                    else{
                        data = risuChatParser(data.replace(reg, outScript), { chatID: chatID, cbsConditions })
                    }
                }
                else{
                    if((outScript.startsWith('@@repeat_back') || pscript.actions.includes('repeat_back'))  && chatID !== -1){
                        const v = outScript.split(' ', 2)[1]
                        const selchar = db.characters[get(selectedCharID)]
                        const chat = selchar.chats[selchar.chatPage]
                        let lastChat = chat.fmIndex === -1 ? selchar.firstMessage : selchar.alternateGreetings[chat.fmIndex]
                        let pointer = chatID - 1
                        while(pointer >= 0){
                            if(chat.message[pointer].role === chat.message[chatID].role){
                                lastChat = chat.message[pointer].data
                                break
                            }
                            pointer--
                        }

                        const r = lastChat.match(reg)
                        if(!v){
                            data = data + r[0]
                        }
                        else if(r[0]){
                            switch(v){
                                case 'end':
                                    data = data + r[0]
                                    break
                                case 'start':
                                    data = r[0] + data
                                    break
                                case 'end_nl':
                                    data = data + "\n" + r[0]
                                    break
                                case 'start_nl':
                                    data = r[0] + "\n" + data
                                    break
                            }

                        }                        
                    }
                }
            }
            else{
                data = risuChatParser(data.replace(reg, outScript), { chatID: chatID, cbsConditions })
            }
        }
    }

    let parsedScripts:pScript[] = []
    let orderChanged = false
    for (const script of scripts){
        if(script.ableFlag && script.flag?.includes('<')){
            const rregex = /<(.+?)>/g
            const scriptData = safeStructuredClone(script)
            let order = 0
            const actions:string[] = []
            scriptData.flag = scriptData.flag?.replace(rregex, (v:string, p1:string) => {
                const meta = p1.split(',').map((v) => v.trim())
                for(const m of meta){
                    if(m.startsWith('order ')){
                        order = parseInt(m.substring(6))
                        orderChanged = true
                    }
                    else{
                        actions.push(m)
                    }
                }

                return ''
            })
            parsedScripts.push({
                script: scriptData,
                order,
                actions
            })
            continue
        }
        parsedScripts.push({
            script,
            order: 0,
            actions: []
        })
    }

    if(orderChanged){
        parsedScripts.sort((a, b) => b.order - a.order) //sort by order
    }
    for (const script of parsedScripts){
        try {
            const start = performance.now()
            executeScript(script)
            const dur = performance.now() - start
            if(dur > 250){
                console.warn(`[ScriptPerf] customscript '${script.script.comment || script.script.in.slice(0, 40)}' (${mode}) took ${Math.round(dur)}ms`)
            }
        } catch (error) {
            console.error(error)
        }
    }

    

    if(db.dynamicAssets && (char.type === 'simple' || char.type === 'character') && char.additionalAssets && char.additionalAssets.length > 0){
        if((!db.dynamicAssetsEditDisplay && mode === 'editdisplay')
            || mode === 'editinput' || mode === 'editprocess'){
            cacheScript(hash, data)
            return {data, emoChanged}
        }
        const assetNames = char.additionalAssets.map((v) => v[0])

        const moduleAssets = getModuleAssets()
        if(moduleAssets.length > 0){
            for(const asset of moduleAssets){
                assetNames.push(asset[0])
            }
        }

        const processer = new HypaProcesser()
        await processer.addText(assetNames)
        const matches = data.matchAll(assetRegex)

        for(const match of matches){
            const type = match[1]
            const assetName = match[2]
            const cacheKey = char.chaId + '::' + assetName
            if(type !== 'emotion' && type !== 'source'){
                if(bestMatchCache.has(cacheKey)){
                    data = data.replaceAll(match[0], `{{${type}::${bestMatchCache.get(cacheKey)}}}`)
                }
                else if(!assetNames.includes(assetName)){
                    const searched = await processer.similaritySearch(assetName)
                    const bestMatch = searched[0]
                    if(bestMatch){
                        data = data.replaceAll(match[0], `{{${type}::${bestMatch}}}`)
                        bestMatchCache.set(cacheKey, bestMatch)
                    }
                }
            }
        }
    }

    cacheScript(hash, data)

    return {data, emoChanged}
}


const rgx = /(?:{{|<)(.+?)(?:}}|>)/gm
export const risuChatParser = risuChatParserOrg
