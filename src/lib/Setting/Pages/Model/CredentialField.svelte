<script lang="ts">
    import type { ModelPreset, RegistryFieldSchema, RegistryUiField } from "src/ts/preset/types";
    import { language } from "src/lang";
    import { localizeDescription } from "src/ts/preset/registry/i18n";
    import { addApiKey, getApiKey, listApiKeys } from "src/ts/preset/apiKeyPool";
    import { untrack } from "svelte";
    import SecretInput from "src/lib/UI/GUI/SecretInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";

    interface Props {
        preset: ModelPreset;
        schemaField: RegistryFieldSchema;
        uiField: RegistryUiField;
        userValues: Record<string, unknown>;
    }

    let { preset, schemaField, uiField, userValues = $bindable() }: Props = $props();

    const fieldKey = $derived(schemaField.key);
    const providerBaseId = $derived(preset.profileSnapshot?.providerBaseId);
    const localizedDescription = $derived(localizeDescription(schemaField));

    // pool = use a saved key (preset.apiKeyRef); direct = type into userValues.
    // Seed from whether the preset already references a pooled key.
    let mode = $state<'pool' | 'direct'>(untrack(() => preset.apiKeyRef) ? 'pool' : 'direct');
    let showAll = $state(false);

    const directKey = $derived(userValues[fieldKey]);
    const hasDirectKey = $derived(typeof directKey === 'string' && directKey.length > 0);

    const poolEntries = $derived(listApiKeys(showAll ? undefined : providerBaseId));

    // apiKeyRef points at a pooled key that no longer exists (deleted). Show a
    // "deleted key" fallback option instead of a blank select.
    const danglingRef = $derived(!!preset.apiKeyRef && !getApiKey(preset.apiKeyRef));

    // Invariant: direct mode never leaves a pool reference behind, or requests
    // would still resolve the pooled key (apiKeyRef wins in buildModelPresetCredential).
    $effect(() => {
        if (mode === 'direct' && preset.apiKeyRef) preset.apiKeyRef = undefined;
    });

    // Dedicated naming dialog. The shared alertInput modal dropped the typed
    // name (focus/IME) and had no empty-name guard, so we own a small dialog
    // here: explicit focus + disabled confirm when empty.
    let showSaveDialog = $state(false);
    let pendingName = $state('');
    let nameInput = $state<HTMLInputElement>();

    $effect(() => {
        if (showSaveDialog && nameInput) {
            const el = nameInput;
            requestAnimationFrame(() => el.focus());
        }
    });

    function openSaveDialog() {
        if (!hasDirectKey) return;
        pendingName = '';
        showSaveDialog = true;
    }

    function confirmSave() {
        const key = userValues[fieldKey];
        const name = pendingName.trim();
        if (typeof key !== 'string' || key.length === 0 || !name) return;
        const entry = addApiKey({ name, key, provider: providerBaseId });
        preset.apiKeyRef = entry.id;
        pendingName = '';
        showSaveDialog = false;
        mode = 'pool';
    }
</script>

<div class="flex flex-col gap-1">
    <div class="flex items-center justify-between gap-2">
        <span class="text-sm text-textcolor flex items-center gap-1">
            {schemaField.label}
            {#if schemaField.required}<span class="text-red-400">*</span>{/if}
        </span>
        <SegmentedControl
            bind:value={mode}
            size="sm"
            className="shrink-0 mb-0!"
            options={[
                { value: 'pool', label: language.apiKeyModePool },
                { value: 'direct', label: language.apiKeyModeDirect },
            ]}
        />
    </div>
    {#if localizedDescription}
        <span class="text-xs text-textcolor2">{localizedDescription}</span>
    {/if}

    {#if mode === 'pool'}
        {#if poolEntries.length === 0 && !danglingRef}
            <span class="text-xs text-textcolor2 py-1">{language.apiKeyPoolEmpty}</span>
        {:else}
            <SelectInput bind:value={preset.apiKeyRef as string}>
                <OptionInput value="">{language.apiKeySelectNone}</OptionInput>
                {#if danglingRef}
                    <OptionInput value={preset.apiKeyRef as string}>{language.apiKeyDeletedOption}</OptionInput>
                {/if}
                {#each poolEntries as entry (entry.id)}
                    <OptionInput value={entry.id}>{entry.name}{showAll && entry.provider ? ` (${entry.provider})` : ''}</OptionInput>
                {/each}
            </SelectInput>
        {/if}
        <CheckInput bind:check={showAll} name={language.apiKeyShowAll} className="text-xs mt-1" />
    {:else}
        <SecretInput
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
            fullwidth
        />
        {#if hasDirectKey}
            <div class="flex justify-end mt-1">
                <ShButton variant="ghost" size="sm" onclick={openSaveDialog}>
                    {language.apiKeySave}
                </ShButton>
            </div>
        {/if}
    {/if}
</div>

<ShDialog bind:open={showSaveDialog} size="sm">
    {#snippet title()}{language.apiKeyNamePrompt}{/snippet}
    <input
        bind:this={nameInput}
        bind:value={pendingName}
        class="border border-darkborderc rounded-md px-3 py-2 text-textcolor bg-transparent focus:ring-borderc focus:ring-2 focus:outline-hidden w-full"
        placeholder={language.apiKeyName}
        autocomplete="off"
        onkeydown={(e) => { if (e.key === 'Enter' && !e.isComposing) confirmSave(); }}
    />
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => { showSaveDialog = false; pendingName = ''; }}>{language.cancel}</ShButton>
        <ShButton variant="default" disabled={!pendingName.trim()} onclick={confirmSave}>{language.apiKeyFormSave}</ShButton>
    {/snippet}
</ShDialog>
