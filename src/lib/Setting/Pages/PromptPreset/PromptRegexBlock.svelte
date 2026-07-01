<script lang="ts">
    import { DBState } from "src/ts/stores.svelte";
    import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
</script>

<RegexList bind:value={DBState.db.presetRegex} buttons />
