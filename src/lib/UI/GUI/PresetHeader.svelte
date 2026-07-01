<script lang="ts">
    import { ChevronRightIcon } from "@lucide/svelte";

    interface Props {
        label: string;
        activeName: string;
        onManage: () => void;
    }

    let {
        label,
        activeName,
        onManage,
    }: Props = $props();

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onManage();
        }
    }
</script>

<div
    role="button"
    tabindex="0"
    aria-label={`${label}: ${activeName}`}
    onclick={onManage}
    onkeydown={handleKeydown}
    class="w-full flex items-center gap-3 bg-darkbg border border-darkborderc rounded-md px-3 py-2.5 mb-4 cursor-pointer hover:bg-selected/30 transition-colors"
>
    <div class="flex flex-col min-w-0 grow">
        <span class="text-xs text-textcolor2">{label}</span>
        <span class="text-sm text-textcolor truncate">{activeName}</span>
    </div>
    <ChevronRightIcon size={18} class="shrink-0 text-textcolor2" />
</div>
