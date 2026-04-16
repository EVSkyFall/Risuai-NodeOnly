<script lang="ts">
  import { DBState } from 'src/ts/stores.svelte'
  import Check from "src/lib/UI/GUI/CheckInput.svelte"
  import Accordion from 'src/lib/UI/Accordion.svelte'
  import { language } from 'src/lang'
  import ModelList from 'src/lib/UI/ModelList.svelte'
  import TextInput from "src/lib/UI/GUI/TextInput.svelte"
</script>

<div class="flex items-center mt-4">
  <Check bind:check={DBState.db.seperateModelsForAxModels} name={language.seperateModelsForAxModels}></Check>
</div>
{#if DBState.db.seperateModelsForAxModels}
  <Check bind:check={DBState.db.doNotChangeSeperateModels} name={language.doNotChangeSeperateModels}></Check>
  <Accordion name={language.axModelsDef} styled>
    <span class="text-textcolor mt-4"> Memory </span>
    <ModelList bind:value={DBState.db.seperateModels.memory} blankable />

    <span class="text-textcolor mt-4"> Translations </span>
    <ModelList bind:value={DBState.db.seperateModels.translate} blankable />

    <span class="text-textcolor mt-4"> Emotion </span>

    <ModelList bind:value={DBState.db.seperateModels.emotion} blankable />

    <span class="text-textcolor mt-4"> OtherAx </span>

    <ModelList bind:value={DBState.db.seperateModels.otherAx} blankable />
  </Accordion>
{/if}

<Accordion name="Sub Model Parameters" styled>
  <span class="text-textcolor text-sm mt-2">Max Context Size (0 = use main)</span>
  <input type="number" class="text-textcolor bg-darkbg border border-borderc rounded px-2 py-1 w-full mt-1" min="0" bind:value={DBState.db.subMaxContext} />
  <span class="text-textcolor text-sm mt-2">Max Response Size (0 = use main)</span>
  <input type="number" class="text-textcolor bg-darkbg border border-borderc rounded px-2 py-1 w-full mt-1" min="0" bind:value={DBState.db.subMaxResponse} />
  <span class="text-textcolor2 text-xs mt-1">0 = follows main model's value</span>
</Accordion>
