<script lang="ts">
    import Accordion from "src/lib/UI/Accordion.svelte";
  import { DBState } from 'src/ts/stores.svelte'
  import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte'
  import ShAccordion from 'src/lib/UI/GUI/ShAccordion.svelte'
  import { language } from 'src/lang'
  import ModelList from 'src/lib/UI/ModelList.svelte'
  import TextInput from "src/lib/UI/GUI/TextInput.svelte"
</script>

<div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc">
  <span class="text-sm text-textcolor">{language.seperateModelsForAxModels}</span>
  <ShSwitch
    checked={!!DBState.db.seperateModelsForAxModels}
    onCheckedChange={(v) => DBState.db.seperateModelsForAxModels = v}
  />
</div>
{#if DBState.db.seperateModelsForAxModels}
  <div class="pb-3">
  <ShAccordion name={language.axModelsDef} variant="card">
    <div class="flex flex-col gap-1 px-1">
      <span class="text-sm text-textcolor mt-2">{language.axModelMemory}</span>
      <ModelList bind:value={DBState.db.seperateModels.memory} blankable blankLabel={language.useDefaultSubModel} />

      <span class="text-sm text-textcolor mt-2">{language.axModelTranslate}</span>
      <ModelList bind:value={DBState.db.seperateModels.translate} blankable blankLabel={language.useDefaultSubModel} />

      <span class="text-sm text-textcolor mt-2">{language.axModelEmotion}</span>
      <ModelList bind:value={DBState.db.seperateModels.emotion} blankable blankLabel={language.useDefaultSubModel} />

      <span class="text-sm text-textcolor mt-2">{language.axModelOther}</span>
      <ModelList bind:value={DBState.db.seperateModels.otherAx} blankable blankLabel={language.useDefaultSubModel} />
    </div>
  </ShAccordion>
  </div>
{/if}

<Accordion name="Sub Model Parameters" styled>
  <span class="text-textcolor text-sm mt-2">Max Context Size (0 = use main)</span>
  <input type="number" class="text-textcolor bg-darkbg border border-borderc rounded px-2 py-1 w-full mt-1" min="0" bind:value={DBState.db.subMaxContext} />
  <span class="text-textcolor text-sm mt-2">Max Response Size (0 = use main)</span>
  <input type="number" class="text-textcolor bg-darkbg border border-borderc rounded px-2 py-1 w-full mt-1" min="0" bind:value={DBState.db.subMaxResponse} />
  <span class="text-textcolor2 text-xs mt-1">0 = follows main model's value</span>
</Accordion>
