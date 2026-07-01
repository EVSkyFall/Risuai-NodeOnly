<script lang="ts">
    import type { Snippet } from 'svelte';

    interface Props {
        title: string;
        children?: Snippet;
    }

    let { title, children }: Props = $props();
</script>

<div class="mt-8 first:mt-2">
    <h3 class="text-base font-bold">{title}</h3>
    <div class="mt-2">
        {@render children?.()}
    </div>
</div>
