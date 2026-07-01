<script lang="ts">
    import SettingRenderer from "../SettingRenderer.svelte";
    import {
        accessibilityEditingItems,
        accessibilityScrollItems,
        accessibilitySidebarItems,
        accessibilityOtherItems,
    } from "src/ts/setting/accessibilitySettingsData";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import { language } from "src/lang";

    let submenu = $state(0);
</script>

<SettingPage title={language.accessibility}>
<SettingTabs
    tabs={[
        { label: language.accTabEditing, value: 0 },
        { label: language.accTabScroll, value: 1 },
        { label: language.accTabSidebar, value: 2 },
        { label: language.others, value: 3 },
    ]}
    bind:selected={submenu}
/>

{#if submenu === 0}
    <SettingRenderer items={accessibilityEditingItems} layout="row" />
{:else if submenu === 1}
    <SettingRenderer items={accessibilityScrollItems} layout="row" />
{:else if submenu === 2}
    <SettingRenderer items={accessibilitySidebarItems} layout="row" />
{:else if submenu === 3}
    <SettingRenderer items={accessibilityOtherItems} layout="row" />
{/if}
</SettingPage>
