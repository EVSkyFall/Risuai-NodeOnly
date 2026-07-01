<script lang="ts">
    import { DBState, selectedCharID } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import { ChevronDownIcon, SaveIcon } from "@lucide/svelte";
    import { alertConfirm, notifySuccess } from "src/ts/alert";
    import ModelList from "../UI/ModelList.svelte";
    import ModelPresetList from "../UI/ModelPresetList.svelte";
    import ShSwitch from "../UI/GUI/ShSwitch.svelte";
    import Help from "../Others/Help.svelte";
    import type { ModelBindingSet } from "src/ts/preset/types";

    let currentChat = $derived(
        DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage]
    );

    let auxExpanded = $state(false);

    function emptyBinding(): ModelBindingSet {
        return { main: '', sub: '', separateAux: false, aux: { memory: '', emotion: '', translate: '', otherAx: '' } };
    }

    // Seed the bundle when entering binding regime: copy the global default if
    // set (visible write-time seeding, not a runtime fallback), else start empty.
    // Normalize every field to a defined primitive — bind:value / bind:checked on
    // a $bindable rejects undefined (Svelte props_invalid_value).
    function ensureBinding() {
        if (!currentChat) return;
        if (!currentChat.modelBinding) {
            const def = DBState.db.defaultModelBinding;
            currentChat.modelBinding = def ? structuredClone($state.snapshot(def)) : emptyBinding();
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

    function onToggle(v: boolean) {
        if (!currentChat) return;
        currentChat.useModelPreset = v;
        if (v) ensureBinding();
    }

    async function confirmSetAsDefault() {
        if (!currentChat?.modelBinding) return;
        if (!(await alertConfirm(language.modelPresetSetDefaultConfirm))) return;
        DBState.db.defaultModelBinding = structuredClone($state.snapshot(currentChat.modelBinding));
        notifySuccess(language.modelPresetDefaultSaved);
    }

    // Make sure the bundle exists whenever the binding UI is shown.
    $effect(() => {
        if (currentChat?.useModelPreset) ensureBinding();
    });
</script>

<div class="flex flex-col gap-1 mt-4">
    {#if currentChat}
        <div class="w-full flex items-center justify-between gap-2 min-h-10 rounded-md px-1">
            <span class="flex items-center gap-1 min-w-0">
                <span>{language.useModelPresetBindingToggle}</span>
                <Help key="useModelPresetBinding" />
            </span>
            <div class="flex items-center gap-1 shrink-0">
                {#if currentChat.useModelPreset}
                    <button
                        class="text-textcolor2 hover:text-primary cursor-pointer"
                        onclick={confirmSetAsDefault}
                        title={language.modelPresetSetAsDefault}
                    >
                        <SaveIcon size={18} />
                    </button>
                {/if}
                <ShSwitch checked={!!currentChat.useModelPreset} onCheckedChange={onToggle} />
            </div>
        </div>
    {/if}
    <div class="text-[11px] text-textcolor2 px-1">
        {currentChat?.useModelPreset ? language.modelPresetBindingTitle : `${language.model}/${language.submodel}`}
    </div>

    {#if !currentChat?.useModelPreset}
        <!-- Classic regime: global model selection, untouched. -->
        <ModelList compact bind:value={DBState.db.aiModel} />
        <div class="flex gap-1 items-stretch">
            <div class="flex-1 min-w-0">
                <ModelList compact bind:value={DBState.db.subModel} />
            </div>
            <button
                class="shrink-0 flex items-center justify-center px-2 rounded-md border border-darkborderc bg-darkbutton hover:bg-selected"
                onclick={() => { auxExpanded = !auxExpanded }}
                title={language.seperateModelsForAxModels}
            >
                <ChevronDownIcon size={16} class={`transition-transform${auxExpanded ? ' rotate-180' : ''}`} />
            </button>
        </div>
        {#if auxExpanded}
            <div class="flex flex-col gap-1 mt-1 pl-2 border-l border-selected">
                <div class="w-full flex items-center justify-between gap-2 min-h-10 rounded-md px-1">
                    <span class="min-w-0">{language.seperateModelsForAxModels}</span>
                    <ShSwitch className="shrink-0" bind:checked={DBState.db.seperateModelsForAxModels} />
                </div>
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelMemory}</div>
                <ModelList compact blankable blankLabel={language.useDefaultSubModel} disabled={!DBState.db.seperateModelsForAxModels} bind:value={DBState.db.seperateModels.memory} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelTranslate}</div>
                <ModelList compact blankable blankLabel={language.useDefaultSubModel} disabled={!DBState.db.seperateModelsForAxModels} bind:value={DBState.db.seperateModels.translate} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelEmotion}</div>
                <ModelList compact blankable blankLabel={language.useDefaultSubModel} disabled={!DBState.db.seperateModelsForAxModels} bind:value={DBState.db.seperateModels.emotion} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelOther}</div>
                <ModelList compact blankable blankLabel={language.useDefaultSubModel} disabled={!DBState.db.seperateModelsForAxModels} bind:value={DBState.db.seperateModels.otherAx} />
            </div>
        {/if}
    {:else if currentChat?.modelBinding}
        <!-- Binding regime: per-chat ModelPreset bundle. -->
        <ModelPresetList warnIfEmpty bind:value={currentChat.modelBinding.main} />
        <div class="flex gap-1 items-stretch">
            <div class="flex-1 min-w-0">
                <ModelPresetList warnIfEmpty bind:value={currentChat.modelBinding.sub} />
            </div>
            <button
                class="shrink-0 flex items-center justify-center px-2 rounded-md border border-darkborderc bg-darkbutton hover:bg-selected"
                onclick={() => { auxExpanded = !auxExpanded }}
                title={language.seperateModelsForAxModels}
            >
                <ChevronDownIcon size={16} class={`transition-transform${auxExpanded ? ' rotate-180' : ''}`} />
            </button>
        </div>
        {#if auxExpanded}
            <div class="flex flex-col gap-1 mt-1 pl-2 border-l border-selected">
                <div class="w-full flex items-center justify-between gap-2 min-h-10 rounded-md px-1">
                    <span class="min-w-0">{language.seperateModelsForAxModels}</span>
                    <ShSwitch className="shrink-0" bind:checked={currentChat.modelBinding.separateAux} />
                </div>
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelMemory}</div>
                <ModelPresetList blankable disabled={!currentChat.modelBinding.separateAux} bind:value={currentChat.modelBinding.aux.memory} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelTranslate}</div>
                <ModelPresetList blankable disabled={!currentChat.modelBinding.separateAux} bind:value={currentChat.modelBinding.aux.translate} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelEmotion}</div>
                <ModelPresetList blankable disabled={!currentChat.modelBinding.separateAux} bind:value={currentChat.modelBinding.aux.emotion} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelOther}</div>
                <ModelPresetList blankable disabled={!currentChat.modelBinding.separateAux} bind:value={currentChat.modelBinding.aux.otherAx} />
            </div>
        {/if}
    {/if}
</div>
