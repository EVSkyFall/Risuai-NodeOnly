<script lang="ts">
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import PromptSettings from "../PromptSettings.svelte";
</script>

{#if DBState.db.promptTemplate}
    <PromptSettings mode='inline' subMenu={1} />
{:else}
    <div class="flex items-center">
        <Check check={false} name={language.usePromptTemplate} onChange={() => {
            DBState.db.promptTemplate = [];
        }}/>
        <Help key="usePromptTemplate"/>
    </div>
{/if}
