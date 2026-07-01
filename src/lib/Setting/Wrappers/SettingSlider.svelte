<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import SliderInput from 'src/lib/UI/GUI/SliderInput.svelte';
    import ShSlider from 'src/lib/UI/GUI/ShSlider.svelte';
    import Help from 'src/lib/Others/Help.svelte';
    import SettingRowLayout from './SettingRowLayout.svelte';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    let localValue: any = $state(untrack(() => getSettingValue(item, ctx)));

    // Sync: DB → local (one-way read)
    $effect(() => {
        localValue = getSettingValue(item, ctx);
    });

    // Write-back: local → DB (guarded)
    $effect(() => {
        const val = localValue;
        if (val === UNINITIALIZED) return;
        untrack(() => {
            if (val !== getSettingValue(item, ctx)) {
                setSettingValue(item, val, ctx);
            }
        });
    });

    let customText = $derived(
        typeof item.options?.customText === 'function'
            ? item.options.customText(localValue)
            : item.options?.customText
    );

    // Read-only display formatter for the ShSlider row layout: only for sliders
    // whose value maps to a word/unit label (customText). Numeric sliders —
    // including fixed/decimal ones like line height — keep ShSlider's editable
    // input so the user can type a precise value.
    let rowFormat = $derived.by(() => {
        const ct = item.options?.customText;
        if (ct === undefined) return undefined;
        return typeof ct === 'function' ? ct : () => ct as string;
    });
</script>

{#if ctx.layout === 'row'}
    <SettingRowLayout {item}>
        {#snippet control()}
            <div class="w-48">
                <ShSlider
                    min={item.options?.min ?? 0}
                    max={item.options?.max ?? 100}
                    step={item.options?.step ?? 1}
                    format={rowFormat}
                    inputWidth="w-16"
                    bind:value={localValue}
                />
            </div>
        {/snippet}
    </SettingRowLayout>
{:else}
    <span class="text-textcolor {item.classes ?? ''}">
        {getLabel(item)}
        {#if item.helpKey}<Help key={item.helpKey as any}/>{/if}
    </span>
    <SliderInput
        className="mt-2"
        marginBottom={true}
        min={item.options?.min}
        max={item.options?.max}
        step={item.options?.step}
        fixed={item.options?.fixed}
        multiple={item.options?.multiple}
        disableable={item.options?.disableable}
        {customText}
        bind:value={localValue}
    />
{/if}
