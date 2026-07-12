<script lang="ts">
    import type { character, Message } from 'src/ts/storage/database.svelte';
    import { mount, onDestroy, unmount } from 'svelte';
    import Chat from './Chat.svelte';
    import { getCharImage } from 'src/ts/characters';
    import { createSimpleCharacter, DBState, selectedCharID, ReloadChatPointer } from 'src/ts/stores.svelte';
    import { chatFoldedStateMessageIndex } from 'src/ts/globalApi.svelte';
    import { get } from 'svelte/store';
    import { scrollWithinContainer } from './scrollWithin';
    
    const getCurrentChatRoomId = () => {
        const charId = get(selectedCharID);
        if (charId < 0) return null;
        const char = DBState.db.characters[charId];
        if (!char) return null;
        return char.chats?.[char.chatPage]?.id ?? null;
    };

    let {
        messages,
        currentCharacter,
        onReroll,
        onNextSwipe = () => {},
        unReroll,
        onDeleteSwipe = () => {},
        currentUsername,
        userIcon,
        loadPages,
        userIconPortrait,
        hasNewUnreadMessage = $bindable(false)
    }:{
        messages: Message[]
        currentCharacter: character
        onReroll: (exact?: boolean) => void
        onNextSwipe?: () => void
        unReroll: () => void
        onDeleteSwipe?: () => void
        currentUsername: string
        userIcon: string
        loadPages: number
        userIconPortrait?: boolean
        hasNewUnreadMessage?: boolean
    } = $props();

    let chatBody: HTMLDivElement;
    // Mounted Chat instances keyed by a STABLE identity, not by content:
    // streaming mutates message.data every chunk, and keying on content used
    // to unmount+remount the whole Chat subtree per chunk (full flicker,
    // every <img> refetched). Streaming-time changes (data, generationInfo,
    // names) update the mounted component in place through its reactive
    // $state props. Everything a user INTERACTION can change (swipes,
    // disabled, reload pointers, reroll target, room switch) stays in the
    // identity so those transitions remount — in-place updates there would
    // leak open edit/translation sessions across semantically new content.
    type MountRecord = { inst: {}, props: Record<string, any>, content: string, el: HTMLElement };
    let mountRecords: Map<string, MountRecord> = new Map();

    //Non-cryptographic hash function to generate a unique hash for each message
    function hashCode(str:string):number {
        let hash = 0;
        for (let i = 0, len = str.length; i < len; i++) {
            let chr = str.charCodeAt(i);
            hash = (hash << 5) - hash + chr;
            hash |= 0; // Convert to 32bit integer
        }
        if(hash == 0){
            hash = 1; // Ensure hash is not zero
        }
        return hash;
    }

    const noopSwipe = () => {};

    const updateChatBody = () => {
        if(!chatBody){
            return
        }

        let nextHash = '';
        let currentHashes: Set<string> = new Set();
        const charImage = getCharImage(currentCharacter.image, 'css')
        const userImage = getCharImage(userIcon, 'css')
        const simpleChar = createSimpleCharacter(currentCharacter);
        // Once per pass: room scoping for identity (branch clones copy message
        // chatIds verbatim). NOTE: no deep character signature here — reading
        // a large character (Omninode-scale triggerscript/assets) through the
        // $state proxy inside this $effect registers a dependency per leaf and
        // saturates the main thread on long chats. Character changes propagate
        // on remount only, exactly like the old content-hash behavior.
        const roomId = getCurrentChatRoomId() ?? 'noroom';
        let loadStart = messages.length - 1
        let loadEnd = messages.length - loadPages

        // Find the last real (non-comment, non-disabled) char message index
        // Only show reroll if it's the actual last non-disabled message
        let lastRealCharIdx = -1;
        let lastNonDisabledIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (!messages[i].isComment && !messages[i].disabled) {
                lastNonDisabledIdx = i;
                break;
            }
        }
        if (lastNonDisabledIdx >= 0 && messages[lastNonDisabledIdx].role === 'char') {
            lastRealCharIdx = lastNonDisabledIdx;
        }

        if(chatFoldedStateMessageIndex.index !== -1){
            loadStart = chatFoldedStateMessageIndex.index
            loadEnd = Math.max(0, chatFoldedStateMessageIndex.index - loadPages)
        }

        const reloadPointerMap = get(ReloadChatPointer);

        for(let i=loadStart ; i >= loadEnd; i--){
            if(i < 0) break; // Prevent out of bounds
            const message = messages[i];
            const messageLargePortrait = message.role === 'user' ? (userIconPortrait ?? false) : ((currentCharacter as character).largePortrait ?? false);
            const reloadPointer = reloadPointerMap[i] ?? 0;
            const isRerollTarget = i === lastRealCharIdx;
            const swipes = message.swipes;
            const swipeId = message.swipeId ?? 0;

            // Identity = the old content hash MINUS message.data (plus room
            // scoping): any interaction-driven transition (swipe, disable,
            // reload, reroll-target shift, room switch) remounts exactly as
            // before. Only streaming-time mutations flow through the content
            // string into in-place prop updates.
            const identity = 'id|' + roomId + '|' + (message.chatId ?? '') + '|' + (message.time ?? '') + '|' + i.toString() + '|' + message.role + '|' + swipeId.toString() + '|' + (swipes?.length ?? 0).toString() + '|' + message.disabled?.toString() + '|' + (message.isComment ?? false).toString() + '|' + reloadPointer.toString() + '|' + messageLargePortrait.toString() + '|' + isRerollTarget.toString();
            // Only shallow, streaming-relevant reads here — generationId is a
            // single leaf; deep-serializing generationInfo (or the character)
            // in a tracked context is a long-chat performance landmine.
            const content = message.data + '|' + currentUsername + '|' + currentCharacter.name + '|' + messages.length.toString() + '|' + (message.generationInfo?.generationId ?? '');
            currentHashes.add(identity);

            const existing = mountRecords.get(identity);
            if(existing){
                if(existing.content !== content){
                    const p = existing.props;
                    p.message = message.data;
                    p.totalLength = messages.length;
                    p.messageGenerationInfo = message.generationInfo;
                    p.name = message.role === 'user' ? currentUsername : currentCharacter.name;
                    existing.content = content;
                }
            }
            else{
                const b = document.createElement('div');
                b.classList.add('chat-message-container');
                const props = $state({
                    message: message.data,
                    isLastMemory: false,
                    idx: i,
                    totalLength: messages.length,
                    img: message.role === 'user' ? userImage : charImage,
                    onReroll: onReroll,
                    onNextSwipe: isRerollTarget ? onNextSwipe : noopSwipe,
                    unReroll: unReroll,
                    onDeleteSwipe: isRerollTarget ? onDeleteSwipe : noopSwipe,
                    rerollIcon: (isRerollTarget ? 'force' : false) as 'force' | false,
                    character: simpleChar,
                    largePortrait: messageLargePortrait,
                    messageGenerationInfo: message.generationInfo,
                    role: message.role,
                    name: message.role === 'user' ? currentUsername : currentCharacter.name,
                    isComment: message.isComment ?? false,
                    disabled: message.disabled ?? false,
                    currentPage: isRerollTarget ? swipeId + 1 : 1,
                    totalPages: isRerollTarget ? (swipes?.length ?? 1) : 1,
                });
                const inst = mount(Chat, {
                    target: b,
                    props,
                })
                mountRecords.set(identity, { inst, props, content, el: b });
                // Container elements are tracked in mountRecords — identities
                // contain arbitrary ids, so no attribute-selector queries.
                const nextElement = nextHash === '' ? null : (mountRecords.get(nextHash)?.el ?? null);
                if(nextElement){
                    chatBody.insertBefore(b, nextElement.nextSibling);
                }
                else{
                    chatBody.prepend(b);
                }
            }
            nextHash = identity;

        }

        //@ts-expect-error Set<T> requires type arg, and Set.difference needs 'esnext' lib (polyfilled by Core-js)
        const toRemove:Set = new Set(mountRecords.keys()).difference(currentHashes);
        toRemove.forEach((hash) => {
            const rec = mountRecords.get(hash);
            if(rec){
                unmount(rec.inst);
                rec.el.remove();
                mountRecords.delete(hash);
            }
        });
    };

    onDestroy(() => {
        mountRecords.forEach((rec) => {
            unmount(rec.inst);
        });
        mountRecords.clear();
    })

    function checkIfAtBottom() {
        if (!chatBody || !chatBody.parentElement) return true;
        const sc = chatBody.parentElement;
        const lastEl = chatBody.firstElementChild;
        if (!lastEl) return true;
        const rect = lastEl.getBoundingClientRect();
        const scRect = sc.getBoundingClientRect();
        return rect.top <= scRect.bottom + 100;
    }

    function scrollLatestIntoChatScreen() {
        if(!chatBody) return;
        const element = chatBody.firstElementChild as HTMLElement | null;
        const chatScreen = chatBody.parentElement;
        if(!element || !chatScreen) return;
        scrollWithinContainer(element, chatScreen, { block: 'start', behavior: 'instant' });
    }

    export const scrollToLatestMessage = () => {
        if(!chatBody) return;
        hasNewUnreadMessage = false;
        scrollLatestIntoChatScreen();
    }

    let previousLength = 0;
    let previousChatRoomId: string | null = null;

    $effect(() => {
        void $ReloadChatPointer; // Make $effect track ReloadChatPointer changes
        const wasAtBottom = checkIfAtBottom();
        updateChatBody()

        const currentChatRoomId = getCurrentChatRoomId();
        const isSameChat = currentChatRoomId === previousChatRoomId;

        // Only auto-scroll if it's the same chat and new messages were added
        if(isSameChat && messages.length > previousLength){
            const lastMsg = messages[messages.length - 1];
            if(lastMsg && lastMsg.role === 'char' && DBState.db.autoScrollToNewMessage){
                if(wasAtBottom || DBState.db.alwaysScrollToNewMessage){
                    setTimeout(() => {
                        scrollLatestIntoChatScreen();
                    }, 700);
                } else {
                    hasNewUnreadMessage = true;
                }
            }
        }
        previousLength = messages.length;
        previousChatRoomId = currentChatRoomId;
    })

</script>

<div class="flex flex-col-reverse" bind:this={chatBody}></div>
