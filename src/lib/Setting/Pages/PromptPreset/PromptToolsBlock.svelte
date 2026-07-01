<script lang="ts">
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
</script>

<div class="flex items-center">
    <Check name={language.search} check={DBState.db.modelTools.includes('search')} onChange={() => {
        if (DBState.db.modelTools.includes('search')) {
            DBState.db.modelTools = DBState.db.modelTools.filter((tool) => tool !== 'search');
        } else {
            DBState.db.modelTools.push('search');
        }
    }} />
    <Help key="searchTool"/>
</div>
