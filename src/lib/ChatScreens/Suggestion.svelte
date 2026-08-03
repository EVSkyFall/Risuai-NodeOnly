<script lang="ts">
    import { requestChatData } from "src/ts/process/request/request";
    import { doingChat, type OpenAIChat } from "../../ts/process/index.svelte";
    import { chatGenKey, generationStates, syncDoingChat } from "../../ts/process/generationState";
    import { setDatabase, type character, type Message, type Database } from "../../ts/storage/database.svelte";
	import { DBState } from 'src/ts/stores.svelte';
    import { selectedCharID } from "../../ts/stores.svelte";
    import { translate } from "src/ts/translator/translator";
    import { CopyIcon, LanguagesIcon, RefreshCcwIcon } from "@lucide/svelte";
    import { alertConfirm } from "src/ts/alert";
    import { language } from "src/lang";
    import { getUserName, replacePlaceholders } from "../../ts/util";
    import { onDestroy, untrack } from 'svelte';
    import { ParseMarkdown } from "src/ts/parser/parser.svelte";
    import {defaultAutoSuggestPrompt} from "../../ts/storage/defaultPrompts.js";

    interface Props {
        send: () => any;
        messageInput: (string:string) => any;
    }

    let { send, messageInput }: Props = $props();
    let suggestMessages:string[] = $state(DBState.db.characters[$selectedCharID]?.chats[DBState.db.characters[$selectedCharID].chatPage]?.suggestMessages)
    let suggestMessagesTranslated:string[] = $state()
    let toggleTranslate:boolean = $state(DBState.db.autoTranslate)
    let progress:boolean = $state();
    let abortController:AbortController | undefined;
    let activeRequestIdentity: string | undefined
    let refreshEpoch = $state(0)
    let requestEpoch = 0
    let selectedChatId = $derived.by(() => {
        const currentChar = DBState.db.characters[$selectedCharID]
        return currentChar?.chats?.[currentChar.chatPage]?.id
    })
    let currentChatBusy = $derived($doingChat || $generationStates.has(chatGenKey(selectedChatId)))

    interface SuggestionTrigger {
        charId: number
        chatPage: number
        chatId?: string
        busy: boolean
        refreshEpoch: number
    }

    function cancelCurrentRequest() {
        requestEpoch += 1
        abortController?.abort()
        abortController = undefined
        activeRequestIdentity = undefined
        progress = false
    }

    function requestIdentity(trigger: SuggestionTrigger): string {
        return `${trigger.charId}:${trigger.chatPage}:${trigger.chatId ?? ''}`
    }

    function invalidateSuggestions(charId: number, chatPage: number, chatId?: string) {
        const currentChar = DBState.db.characters[charId]
        const currentChat = currentChar?.chats?.[chatPage]
        if (currentChat?.id === chatId) currentChat.suggestMessages = []
        suggestMessages = []
    }

    function triggerStillCurrent(trigger: SuggestionTrigger): boolean {
        const currentChar = DBState.db.characters[$selectedCharID]
        return $selectedCharID === trigger.charId
            && currentChar?.chatPage === trigger.chatPage
            && currentChar?.chats?.[trigger.chatPage]?.id === trigger.chatId
            && !currentChatBusy
    }

    async function generateSuggestions(trigger: SuggestionTrigger, currentChar: character) {
        const messages: Message[] = [...currentChar.chats[trigger.chatPage].message]
        const lastMessages = messages.slice(Math.max(messages.length - 10, 0))
        if (lastMessages.length === 0) return
        const prompt = DBState.db.autoSuggestPrompt && DBState.db.autoSuggestPrompt.length > 0 ? DBState.db.autoSuggestPrompt : defaultAutoSuggestPrompt
        let promptbody: OpenAIChat[] = [
            {
                role:'system',
                content: replacePlaceholders(prompt, currentChar.name)
            }
            ,{
                role: 'user', 
                content: lastMessages.map(b=>(b.role==='char'? currentChar.name : getUserName())+":"+b.data).reduce((a,b)=>a+','+b)
            }
        ]

        if(DBState.db.subModel === "textgen_webui" || DBState.db.subModel === 'mancer' || DBState.db.subModel.startsWith('local_')){
            promptbody = [
                {
                    role: 'system',
                    content: replacePlaceholders(DBState.db.autoSuggestPrompt, currentChar.name)
                },
                ...lastMessages.map(({ role, data }) => ({
                    role: role === "user" ? "user" as const : "assistant" as const,
                    content: data,
                })),
            ]
        }

        progress = true
        const controller = new AbortController()
        abortController = controller
        activeRequestIdentity = requestIdentity(trigger)
        const epoch = ++requestEpoch
        const isCurrentRequest = () => epoch === requestEpoch && controller === abortController
        try {
            const rq2 = await requestChatData({
                formated: promptbody,
                bias: {},
                currentChar : currentChar as character
            }, 'submodel', controller.signal)
            if (!isCurrentRequest() || !triggerStillCurrent(trigger)) return
            if(rq2.type !== 'fail' && rq2.type !== 'streaming' && rq2.type !== 'multiline'){
                const suggestMessagesNew = rq2.result.split('\n').filter(msg => msg.startsWith('-')).map(msg => msg.replace('-','').trim())
                const db:Database = DBState.db;
                db.characters[trigger.charId].chats[trigger.chatPage].suggestMessages = suggestMessagesNew
                suggestMessages = suggestMessagesNew
            }
        } catch (error) {
            if (isCurrentRequest() && !controller.signal.aborted) console.error(error)
        } finally {
            if (isCurrentRequest()) {
                progress = false
                abortController = undefined
                activeRequestIdentity = undefined
            }
        }
    }

    function reconcileSuggestions(trigger: SuggestionTrigger) {
        if (trigger.busy) {
            cancelCurrentRequest()
            invalidateSuggestions(trigger.charId, trigger.chatPage, trigger.chatId)
            return
        }
        const currentChar = DBState.db.characters[trigger.charId]
        const currentChat = currentChar?.chats?.[trigger.chatPage]
        if (!currentChar || !currentChat || currentChat.id !== trigger.chatId) {
            cancelCurrentRequest()
            return
        }
        if (progress && activeRequestIdentity !== requestIdentity(trigger)) cancelCurrentRequest()
        suggestMessages = currentChat.suggestMessages
        if (progress || (suggestMessages && suggestMessages.length > 0)) return
        void generateSuggestions(trigger, currentChar)
    }

    const translateSuggest = async (toggle, messages)=>{
        if(toggle && messages && messages.length > 0) {
            suggestMessagesTranslated = []
            for(let i = 0; i < suggestMessages.length; i++){
                let msg = suggestMessages[i]
                let translated = await translate(msg, false)
                suggestMessagesTranslated[i] = translated
            }
        }
    }

    onDestroy(() => { cancelCurrentRequest() })

    $effect.pre(() => {
        const charId = $selectedCharID
        const currentChar = DBState.db.characters[charId]
        const chatPage = currentChar?.chatPage ?? -1
        const chatId = currentChar?.chats?.[chatPage]?.id
        const busy = currentChatBusy
        const refresh = refreshEpoch
        untrack(() => {
            reconcileSuggestions({ charId, chatPage, chatId, busy, refreshEpoch: refresh })
        })
    });
    $effect.pre(() => {translateSuggest(toggleTranslate, suggestMessages)});
</script>

<div class="ml-4 flex flex-wrap">
    {#if progress}
        <div class="flex bg-textcolor2 p-2 rounded-lg items-center">
            <div class="loadmove mx-2"></div>
            <div>{language.creatingSuggestions}</div>
        </div>        
    {:else if !currentChatBusy}
        {#if DBState.db.translator !== ''}
            <div class="flex mr-2 mb-2">
                <button class={"bg-textcolor2 hover:bg-darkbutton font-bold py-2 px-4 rounded-sm " + (toggleTranslate ? 'text-green-500' : 'text-textcolor')}
                    onclick={() => {
                        toggleTranslate = !toggleTranslate
                    }}
                >
                    <LanguagesIcon/>
                </button>
            </div>    
        {/if}
        

        <div class="flex mr-2 mb-2">
            <button class="bg-textcolor2 hover:bg-darkbutton font-bold py-2 px-4 rounded-sm text-textcolor"
                onclick={() => {
                    alertConfirm(language.askReRollAutoSuggestions).then((result) => {
                        if(result) {
                            const currentChar = DBState.db.characters[$selectedCharID]
                            invalidateSuggestions($selectedCharID, currentChar?.chatPage ?? -1, selectedChatId)
                            // pulse the compat store to retrigger the subscriber
                            // above, then re-converge it with generationStates
                            // (covers a generation starting in the async gap)
                            doingChat.set(true)
                            doingChat.set(false)        
                            syncDoingChat()
                            refreshEpoch += 1
                        }
                    })
                }}
            >
                <RefreshCcwIcon/>
            </button>
        </div>
        {#each suggestMessages??[] as suggest, i}
            <div class="flex mr-2 mb-2">
                <button class="bg-textcolor2 hover:bg-darkbutton text-textcolor font-bold py-2 px-4 rounded-sm" onclick={() => {
                    suggestMessages = []
                    messageInput(suggest)
                    send()
                }}>
                {#await ParseMarkdown((DBState.db.translator !== '' && toggleTranslate && suggestMessagesTranslated && suggestMessagesTranslated.length > 0) ? suggestMessagesTranslated[i]??suggest : suggest) then md}
                    {@html md}
                {/await}
                </button>
                <button class="bg-textcolor2 hover:bg-darkbutton text-textcolor font-bold py-2 px-4 rounded-sm ml-1" onclick={() => {
                    messageInput(suggest)
                }}>
                    <CopyIcon/>
                </button>
            </div>
        {/each}
        
    {/if}
</div>

<style>
    
    .loadmove {
        animation: spin 1s linear infinite;
        border-radius: 50%;
        border: 0.4rem solid rgba(0,0,0,0);
        width: 1rem;
        height: 1rem;
        border-top: 0.4rem solid var(--risu-theme-textcolor);
        border-left: 0.4rem solid var(--risu-theme-textcolor);
    }

    @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }
</style>

