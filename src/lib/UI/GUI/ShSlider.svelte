<script lang="ts">
    // Sh slider — shadcn slider port + RisuAI theming.
    // bits-ui Slider headless under the hood (drag, keyboard ↑↓← →, ARIA).
    // Single-thumb scalar value, paired with an inline number input for
    // precise entry. See .agent/guide/ui.md.
    import { Slider as SliderPrimitive } from 'bits-ui';
    import { cn } from 'src/lib/utils';
    import { language } from 'src/lang';

    interface Props {
        value?: number;
        min?: number;
        max?: number;
        step?: number;
        disabled?: boolean;
        showInput?: boolean;
        inputWidth?: string;
        placeholder?: string;
        className?: string;
        /** When set, the editable number input is replaced by a read-only label
         * showing format(value). Use for sliders whose value maps to a word
         * (e.g. "Default"/"Big") or a unit-suffixed display ("120%"). */
        format?: (value: number) => string;
    }

    let {
        value = $bindable(),
        min = 0,
        max = 100,
        step = 1,
        disabled = false,
        showInput = true,
        inputWidth = 'w-20',
        placeholder,
        className = '',
        format,
    }: Props = $props();

    const inputPlaceholder = $derived(placeholder ?? language.disabled ?? '—');

    function clamp(v: number) {
        return Math.min(max, Math.max(min, v));
    }

    // Coarsen the slider step when the (max-min)/step ratio is huge.
    // The number input keeps the original step so users can still type
    // a precise value (e.g. 4321). Slider drag is for coarse pick.
    // Without this, max_tokens (range 128000, step 1) fires onValueChange
    // ~256× per pixel of drag and lags the whole form.
    const sliderStep = $derived.by(() => {
        if (step <= 0) return 1;
        const range = max - min;
        if (range <= 0) return step;
        const numSteps = range / step;
        if (numSteps <= 500) return step;
        // Target ~100 slider positions, rounded to a "nice" magnitude.
        const target = range / 100;
        const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
        const rounded = Math.round(target / magnitude) * magnitude;
        return Math.max(step, rounded);
    });

    // bits-ui v2 Slider with type="single" exposes a scalar value.
    // We mirror outer ↔ inner explicitly: outer→inner via $effect,
    // inner→outer via onValueChange callback (avoids effect loop).
    // Initialize from the bound value before bits-ui mounts. Starting below
    // min would let the headless slider normalize to min and overwrite a
    // seeded default such as maxOutputTokens=8192 with 1.
    // svelte-ignore state_referenced_locally
    let internal = $state<number>(typeof value === 'number' ? clamp(value) : min);

    $effect(() => {
        const v = typeof value === 'number' ? clamp(value) : min;
        if (internal !== v) internal = v;
    });

    function onValueChange(v: number) {
        value = v;
    }

    function onInput(e: Event) {
        const el = e.currentTarget as HTMLInputElement;
        const n = el.valueAsNumber;
        if (Number.isNaN(n)) return;
        value = clamp(n);
        // Snap the field down immediately when typing past max (can't block
        // typing toward a multi-digit min, so under-min is snapped on commit).
        if (n > max) el.value = String(value);
    }

    // On blur/enter, force the field to the clamped model value so it can never
    // be left showing an out-of-range number.
    function onCommit(e: Event) {
        (e.currentTarget as HTMLInputElement).value = String(value ?? '');
    }
</script>

<div class={cn('flex items-center gap-2 w-full', className)}>
    <SliderPrimitive.Root
        type="single"
        bind:value={internal}
        {min}
        {max}
        step={sliderStep}
        {disabled}
        {onValueChange}
        data-slot="slider"
        data-unset={value === undefined ? '' : undefined}
        class={
            'relative flex w-full touch-none items-center select-none h-5 ' +
            'data-disabled:opacity-50 data-disabled:pointer-events-none ' +
            'data-[unset]:opacity-40'
        }
    >
        {#snippet children({ thumbItems })}
            <span
                data-slot="slider-track"
                class="bg-darkbutton relative h-2 grow overflow-hidden rounded-full"
            >
                <SliderPrimitive.Range
                    data-slot="slider-range"
                    class="bg-primary absolute h-full"
                />
            </span>
            {#each thumbItems as thumb (thumb)}
                <SliderPrimitive.Thumb
                    data-slot="slider-thumb"
                    index={thumb.index}
                    class={
                        'block size-4 shrink-0 rounded-full border-2 border-primary bg-white shadow-sm ' +
                        'transition-[box-shadow,transform] cursor-grab active:cursor-grabbing ' +
                        'focus-visible:outline-hidden focus-visible:ring-3 focus-visible:ring-borderc/50 ' +
                        'disabled:pointer-events-none disabled:opacity-50'
                    }
                />
            {/each}
        {/snippet}
    </SliderPrimitive.Root>
    {#if format}
        <span class={cn('shrink-0 text-sm text-textcolor2 text-right tabular-nums', inputWidth)}>
            {format(value ?? min)}
        </span>
    {:else if showInput}
        <input
            type="number"
            value={value ?? ''}
            oninput={onInput}
            onchange={onCommit}
            {min}
            {max}
            {step}
            {disabled}
            placeholder={inputPlaceholder}
            class={cn(
                'shrink-0 numinput rounded-md border border-darkborderc bg-transparent ' +
                'h-8 px-2 py-1 text-sm text-textcolor text-right ' +
                'placeholder:text-textcolor2 placeholder:text-xs ' +
                'focus:border-borderc focus:ring-2 focus:ring-borderc/50 focus:outline-hidden ' +
                'disabled:opacity-50 disabled:cursor-not-allowed transition-colors',
                inputWidth
            )}
        />
    {/if}
</div>

<style>
    .numinput::-webkit-outer-spin-button,
    .numinput::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }
    .numinput {
        -moz-appearance: textfield;
        appearance: textfield;
    }
</style>
