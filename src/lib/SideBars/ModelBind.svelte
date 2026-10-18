<script lang="ts">
    import { DBState, ModelPresetListTabIndex, selectedCharID } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import { ChevronDownIcon, SettingsIcon } from "@lucide/svelte";
    import { alertConfirm, notifySuccess } from "src/ts/alert";
    import { openSettings, SettingsRoute, ModelPresetTab } from "src/ts/routing";
    import ModelList from "../UI/ModelList.svelte";
    import ModelPresetList from "../UI/ModelPresetList.svelte";
    import ShSwitch from "../UI/GUI/ShSwitch.svelte";
    import ShButton from "../UI/GUI/ShButton.svelte";
    import { emptyModelBinding, LEGACY_SLOT, legacySlotValue, type ModelBindingSet } from "src/ts/preset/types";

    let currentChat = $derived(
        DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage]
    );

    let auxExpanded = $state(false);

    // A global regime choice still applies to existing chats.
    let lock = $derived(DBState.db.nodeOnlyModelModeLock ?? 'none');

    // Whether THIS chat resolves through its binding (mirrors
    // resolveChatModelBinding): a 'preset' lock forces it; under 'none' it is
    // the chat's own stored choice.
    let inBinding = $derived(
        lock === 'preset' ? true :
        lock === 'legacy' ? false :
        (currentChat?.useModelPreset ?? false)
    );

    const AUX_TASKS = ['memory', 'translate', 'emotion', 'otherAx'] as const;
    type AuxTask = typeof AUX_TASKS[number];

    // A chat outside the binding uses the global classic config; shown as the
    // binding that amounts to: every slot "legacy · global setting", aux slots
    // following the global "separate aux models" switch. A '@legacy' aux slot
    // means "the global model for this task, else the sub model" — the same
    // rule classic applies, so nothing changes when the chat later gets this
    // binding for real.
    function classicAsBinding(): ModelBindingSet {
        const sep = !!DBState.db.seperateModelsForAxModels;
        const aux = sep ? LEGACY_SLOT : '';
        return { main: LEGACY_SLOT, sub: LEGACY_SLOT, separateAux: sep, aux: {
            memory: sep ? legacySlotValue(DBState.db.seperateModels?.memory) : aux,
            emotion: sep ? legacySlotValue(DBState.db.seperateModels?.emotion) : aux,
            translate: sep ? legacySlotValue(DBState.db.seperateModels?.translate) : aux,
            otherAx: sep ? legacySlotValue(DBState.db.seperateModels?.otherAx) : aux,
        } };
    }

    let shown = $derived(inBinding ? currentChat?.modelBinding : (currentChat ? classicAsBinding() : undefined));

    // Seed the bundle when entering binding regime: copy the global default if
    // set (visible write-time seeding, not a runtime fallback), else start empty.
    // Normalize every field to a defined primitive — bind:value / bind:checked on
    // a $bindable rejects undefined (Svelte props_invalid_value).
    function ensureBinding() {
        if (!currentChat) return;
        if (!currentChat.modelBinding) {
            const def = DBState.db.defaultModelBinding;
            currentChat.modelBinding = def ? structuredClone($state.snapshot(def)) : emptyModelBinding();
        }
        const b = currentChat.modelBinding;
        b.main ??= '';
        b.sub ??= '';
        b.separateAux ??= false;
        b.aux ??= { memory: '', emotion: '', translate: '', otherAx: '' };
        b.aux.memory ??= '';
        b.aux.emotion ??= '';
        b.aux.translate ??= '';
        b.aux.otherAx ??= '';
    }

    // Changing a slot of a chat outside the binding moves it into the binding,
    // starting from what its classic config amounts to — every other slot keeps
    // working exactly as before.
    function enterBinding() {
        if (!currentChat || inBinding) return;
        currentChat.modelBinding = classicAsBinding();
        currentChat.useModelPreset = true;
        if (lock === 'legacy') DBState.db.nodeOnlyModelModeLock = 'none';
    }

    function setSlot(slot: 'main' | 'sub', value: string) {
        if (!currentChat) return;
        enterBinding();
        ensureBinding();
        currentChat.modelBinding![slot] = value;
    }

    function setAuxSlot(task: AuxTask, value: string) {
        if (!currentChat) return;
        enterBinding();
        ensureBinding();
        currentChat.modelBinding!.aux[task] = value;
    }

    function setSeparateAux(on: boolean) {
        if (!currentChat) return;
        if (!inBinding) {
            // Outside the binding this is the global classic switch, as before.
            DBState.db.seperateModelsForAxModels = on;
            return;
        }
        ensureBinding();
        currentChat.modelBinding!.separateAux = on;
    }

    function openModelModeSettings() {
        // Model-mode settings live on the Model Preset page's Options tab
        // (moved there from Accessibility > Sidebar in f678216e).
        openSettings(SettingsRoute.ModelPreset, undefined, undefined, ModelPresetTab.Options);
    }

    async function confirmSetAsDefault() {
        if (!currentChat?.modelBinding) return;
        if (!(await alertConfirm(language.modelPresetSetDefaultConfirm))) return;
        DBState.db.defaultModelBinding = structuredClone($state.snapshot(currentChat.modelBinding));
        // New chats start from this binding (the "new chat model mode" setting).
        DBState.db.useModelPresetByDefault = true;
        notifySuccess(language.modelPresetDefaultSaved);
    }

    // Make sure the bundle exists whenever this chat resolves through it
    // (including chats forced into it by the global 'preset' lock).
    $effect(() => {
        if (currentChat && inBinding) ensureBinding();
    });

    const auxLabels: Record<AuxTask, () => string> = {
        memory: () => language.axModelMemory,
        translate: () => language.axModelTranslate,
        emotion: () => language.axModelEmotion,
        otherAx: () => language.axModelOther,
    };
</script>

{#snippet globalLegacyModel(kind: 'main' | 'sub')}
    <div class="flex flex-col gap-1 pl-2 border-l border-selected">
        <div class="text-[11px] text-textcolor2 px-1">{language.modelSlotLegacyGlobalHint}</div>
        {#if kind === 'main'}
            <ModelList compact bind:value={DBState.db.aiModel} />
        {:else}
            <ModelList compact bind:value={DBState.db.subModel} />
        {/if}
    </div>
{/snippet}

<div class="flex flex-col gap-1 mt-4">
    <div class="flex items-center gap-1">
        <div class="text-[11px] text-textcolor2 px-1 flex-1 min-w-0">
            {language.modelBindingTitle}
        </div>
        <ShButton size="xs" variant="ghost" className="shrink-0" onclick={openModelModeSettings} title={language.modelPresetConfigure}>
            <SettingsIcon size={14} />
        </ShButton>
    </div>

    {#if currentChat && lock === 'none'}
        <div class="flex items-center justify-between gap-2">
            <span>{language.useModelPresetBindingToggle}</span>
            <ShSwitch checked={!!currentChat.useModelPreset} onCheckedChange={(v) => { currentChat.useModelPreset = v; if (v) ensureBinding(); }} />
        </div>
    {/if}

    {#if shown}
        <!-- Binding slots: each holds a model preset or a legacy model. -->
        <ModelPresetList allowLegacy warnIfEmpty value={shown.main} onChange={(v) => setSlot('main', v)} />
        {#if shown.main === LEGACY_SLOT}
            {@render globalLegacyModel('main')}
        {/if}
        <div class="flex gap-1 items-stretch">
            <div class="flex-1 min-w-0">
                <ModelPresetList allowLegacy warnIfEmpty value={shown.sub} onChange={(v) => setSlot('sub', v)} />
            </div>
            <ShButton size="icon" className="shrink-0" onclick={() => { auxExpanded = !auxExpanded }} title={language.seperateModelsForAxModels}>
                <ChevronDownIcon size={16} class={`transition-transform${auxExpanded ? ' rotate-180' : ''}`} />
            </ShButton>
        </div>
        {#if shown.sub === LEGACY_SLOT}
            {@render globalLegacyModel('sub')}
        {/if}
        {#if auxExpanded}
            <div class="flex flex-col gap-1 mt-1 pl-2 border-l border-selected">
                <div class="w-full flex items-center justify-between gap-2 min-h-10 rounded-md px-1">
                    <span class="min-w-0">{language.seperateModelsForAxModels}</span>
                    <ShSwitch className="shrink-0" checked={shown.separateAux} onCheckedChange={setSeparateAux} />
                </div>
                {#each AUX_TASKS as task}
                    <div class="text-[11px] text-textcolor2 px-1">{auxLabels[task]()}</div>
                    <ModelPresetList allowLegacy blankable disabled={!shown.separateAux} value={shown.aux[task]} onChange={(v) => setAuxSlot(task, v)} />
                    {#if shown.separateAux && shown.aux[task] === LEGACY_SLOT}
                        <div class="pl-2 border-l border-selected">
                            <ModelList compact blankable blankLabel={language.useDefaultSubModel} bind:value={DBState.db.seperateModels[task]} />
                        </div>
                    {/if}
                {/each}
            </div>
        {/if}
    {/if}

    {#if inBinding && currentChat?.modelBinding}
        <ShButton variant="ghost" size="xs" className="w-full text-textcolor2" onclick={confirmSetAsDefault}>
            {language.modelPresetSaveAsDefaultButton}
        </ShButton>
    {/if}
</div>
