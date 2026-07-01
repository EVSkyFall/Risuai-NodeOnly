<script lang="ts">
    import SettingRenderer from "../../SettingRenderer.svelte";
    import { modelPresetOptionsItems } from "src/ts/setting/modelPresetOptionsData";
</script>

<SettingRenderer items={modelPresetOptionsItems} layout="row" />
