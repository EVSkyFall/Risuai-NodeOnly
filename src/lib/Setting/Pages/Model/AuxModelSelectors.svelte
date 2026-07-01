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
  <Accordion name={language.axModelsDef} styled>
    <span class="text-textcolor mt-4">{language.axModelMemory}</span>
    <ModelList bind:value={DBState.db.seperateModels.memory} blankable blankLabel={language.useDefaultSubModel} />

    <span class="text-textcolor mt-4">{language.axModelTranslate}</span>
    <ModelList bind:value={DBState.db.seperateModels.translate} blankable blankLabel={language.useDefaultSubModel} />

    <span class="text-textcolor mt-4">{language.axModelEmotion}</span>

    <ModelList bind:value={DBState.db.seperateModels.emotion} blankable blankLabel={language.useDefaultSubModel} />

    <span class="text-textcolor mt-4">{language.axModelOther}</span>

    <ModelList bind:value={DBState.db.seperateModels.otherAx} blankable blankLabel={language.useDefaultSubModel} />
  </Accordion>
{/if}

<Accordion name="Sub Model Parameters" styled>
  <span class="text-textcolor text-sm mt-2">Max Context Size (0 = use main)</span>
  <input type="number" class="text-textcolor bg-darkbg border border-borderc rounded px-2 py-1 w-full mt-1" min="0" bind:value={DBState.db.subMaxContext} />
  <span class="text-textcolor text-sm mt-2">Max Response Size (0 = use main)</span>
  <input type="number" class="text-textcolor bg-darkbg border border-borderc rounded px-2 py-1 w-full mt-1" min="0" bind:value={DBState.db.subMaxResponse} />
  <span class="text-textcolor2 text-xs mt-1">0 = follows main model's value</span>
</Accordion>
