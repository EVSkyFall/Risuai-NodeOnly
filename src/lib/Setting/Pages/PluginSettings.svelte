<script lang="ts">
    import { PlusIcon, LinkIcon, CodeXmlIcon, PowerIcon, PowerOffIcon, ShieldIcon, RotateCcwIcon, XIcon, HardDriveUploadIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShDropdownMenuItem from "src/lib/UI/GUI/ShDropdownMenuItem.svelte";
    import ShDropdownMenuSeparator from "src/lib/UI/GUI/ShDropdownMenuSeparator.svelte";
    import FolderedList, { type FolderedItemPlacement } from "src/lib/UI/FolderedList.svelte";
    import { alertConfirm, alertMd, alertSelect, notifyError, notifySuccess } from "src/ts/alert";
    import { TriangleAlert } from '@lucide/svelte';

    import { DBState, hotReloading } from "src/ts/stores.svelte";
    import { checkPluginUpdate, importPlugin, loadPlugins, updatePlugin } from "src/ts/plugins/plugins.svelte";
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import {
        listPluginPermissionStates,
        pluginPermissionDescList,
        resetPluginPermission,
        setPluginPermissionPreset,
        type PluginPermissionDesc,
        type PluginPermissionPresetState,
    } from "src/ts/plugins/apiV3/v3.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import { hotReloadPluginFiles, stopHotReload, requestResumeHotReload, isHotReloadActive, hasPersistedHandle } from "src/ts/plugins/apiV3/developMode";
    import * as pluginStorageStore from "src/ts/plugins/pluginStorageStore";

    // Plugins are keyed by name (no id); track expanded parameter panels by name.
    let showParams = $state<string[]>([])

    function toggleParams(index: number) {
        const name = DBState.db.plugins[index]?.name
        if (!name) return
        if (showParams.includes(name)) {
            showParams = showParams.filter(n => n !== name)
            // The permission section lives inside this panel, so collapsing the
            // row hides it. Drop its state too, or reopening the row would
            // resurrect a section the user had already put away.
            if (openPermissionPlugin === name) closePermissionPanel()
        } else {
            showParams = [...showParams, name]
        }
    }

    function hasParams(plugin: typeof DBState.db.plugins[number]) {
        return plugin.version !== 1 && Object.keys(plugin.arguments ?? {}).filter((k) => !k.startsWith("hidden_")).length > 0
    }

    // V3 plugins always have a detail panel (the storage access switch).
    function hasPanel(plugin: typeof DBState.db.plugins[number]) {
        return hasParams(plugin) || plugin.version === '3.0' || openPermissionPlugin === plugin.name
    }

    const FULL_STORAGE_WARN_BYTES = 100 * 1024 * 1024
    function storageSizeText(bytes: number) {
        return bytes >= 1024 * 1024
            ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
            : `${Math.ceil(bytes / 1024)} KB`
    }
    function fullStorageGuideUrl() {
        const lang = DBState.db.language === 'ko' ? 'ko' : 'en'
        return `https://github.com/PocketRisu/PocketRisu/blob/main/docs/${lang}/plugin-storage.md`
    }

    function togglePlugin(index: number) {
        const plugin = DBState.db.plugins[index]
        plugin.enabled = !plugin.enabled
        DBState.db.plugins[index] = plugin
        loadPlugins()
        void requestImmediateSave()
    }

    async function resetPermission(index: number) {
        const plugin = DBState.db.plugins[index]
        const label = plugin.displayName ?? plugin.name
        if (!await alertConfirm(language.resetPluginPermissionConfirm.replace("{}", label))) return
        await resetPluginPermission(plugin.name)
        notifySuccess(language.resetPluginPermissionDone.replace("{}", label))
        // The menu reaches this while the panel may be open on the same plugin;
        // without a reload its segmented controls keep showing the old presets.
        if (openPermissionPlugin === plugin.name) await loadPermissionStates(plugin.name)
    }

    async function removePlugin(index: number) {
        const plugin = DBState.db.plugins[index]
        if (!plugin) return
        if (!await alertConfirm(language.removeConfirm + (plugin.displayName ?? plugin.name))) return
        if (DBState.db.currentPluginProvider === plugin.name) {
            DBState.db.currentPluginProvider = "";
        }
        DBState.db.plugins = (DBState.db.plugins ?? []).filter((_, i) => i !== index)
        loadPlugins()
        void requestImmediateSave()
    }

    /** Rebuilds `db.plugins` from the folder list's reported order/membership. */
    function applyPlacements(placements: FolderedItemPlacement[]) {
        const plugins = DBState.db.plugins
        const next = placements.map(({ index, folderId }) => ({ ...plugins[index], folderId }))
        if (next.length !== plugins.length) return
        DBState.db.plugins = next
        void requestImmediateSave()
    }

    async function openDevTools() {
        const options = ["Import plugin with hot reload", "Download plugin template"]
        if (hotReloadRunning) options.push("Stop hot reload")
        else if (hasSavedHandle) options.push("Resume hot reload")
        options.push(language.cancel)
        const selected = parseInt(await alertSelect(options))
        if (selected === 0) {
            await hotReloadPluginFiles()
            hotReloadRunning = isHotReloadActive()
            hasSavedHandle = await hasPersistedHandle()
        } else if (selected === 1) {
            const a = document.createElement('a')
            a.href = '/plugin_start.7z'
            a.download = 'plugin_starter.7z'
            a.click()
        } else if (selected === 2 && hotReloadRunning) {
            await stopHotReload()
            hotReloadRunning = false
            hasSavedHandle = false
            hotReloading.length = 0
        } else if (selected === 2 && hasSavedHandle) {
            hotReloadRunning = await requestResumeHotReload()
            if (!hotReloadRunning) notifyError("Permission denied — pick the file again via hot reload import.")
        }
    }

    let hotReloadRunning = $state(isHotReloadActive())
    let hasSavedHandle = $state(false)
    hasPersistedHandle().then(v => { hasSavedHandle = v })

    // Only one permission panel is open at a time, so the loaded states can be a
    // single record instead of a per-plugin map.
    let openPermissionPlugin = $state<string | null>(null)
    let permissionStates = $state<Record<PluginPermissionDesc, PluginPermissionPresetState> | null>(null)
    let permissionLoadFailed = $state(false)

    const permissionStateOptions = () => [
        { value: 'granted', label: language.pluginPermissionAllow },
        { value: 'unset', label: language.pluginPermissionAsk },
        { value: 'denied', label: language.pluginPermissionDeny },
    ]

    async function loadPermissionStates(pluginName: string) {
        try {
            const states = await listPluginPermissionStates(pluginName)
            if (openPermissionPlugin !== pluginName) return
            permissionStates = states
            permissionLoadFailed = false
        } catch (error) {
            if (openPermissionPlugin !== pluginName) return
            permissionStates = null
            permissionLoadFailed = true
            notifyError(language.pluginPermissionLoadFailed)
        }
    }

    function closePermissionPanel() {
        openPermissionPlugin = null
        permissionStates = null
        permissionLoadFailed = false
    }

    /** Opens (never closes) — the menu entry is a destination, and the section
     *  carries its own close button. A dropdown item that silently toggles
     *  something off-screen reads as "the menu did nothing". */
    async function openPermissionPanel(pluginName: string) {
        if (openPermissionPlugin === pluginName) return
        openPermissionPlugin = pluginName
        permissionStates = null
        permissionLoadFailed = false
        await loadPermissionStates(pluginName)
    }

    async function changePermissionState(
        pluginName: string,
        desc: PluginPermissionDesc,
        next: PluginPermissionPresetState,
    ) {
        const states = permissionStates
        if (!states) return
        const previous = states[desc]
        if (previous === next) return
        states[desc] = next
        try {
            await setPluginPermissionPreset(pluginName, desc, next)
        } catch (error) {
            if (permissionStates === states) states[desc] = previous
            notifyError(language.pluginPermissionSaveFailed)
        }
    }
</script>

<SettingPage title={language.plugin}>
<span class="text-draculared text-xs mb-4">{language.pluginWarn}</span>

<FolderedList
    folders={DBState.db.pluginFolders ?? []}
    itemFolderIds={(DBState.db.plugins ?? []).map(p => p.folderId)}
    itemSearchTexts={(DBState.db.plugins ?? []).map(p => `${p.displayName ?? ''}\n${p.name}`)}
    storageKey="risu-plugin-folders-collapsed"
    onSelect={toggleParams}
    isExpanded={(index) => hasPanel(DBState.db.plugins[index]) && showParams.includes(DBState.db.plugins[index].name)}
    onItemsChange={applyPlacements}
    onFoldersChange={(next) => { DBState.db.pluginFolders = next; void requestImmediateSave() }}
    onDelete={removePlugin}
>
    {#snippet actions()}
        <ShButton size="sm" onclick={() => importPlugin()}><HardDriveUploadIcon />{language.pluginImport}</ShButton>
        <!-- Hot reload is a background watcher with no other resting-state
             indicator, so the button that starts/stops it carries the state. -->
        <ShButton size="sm" variant={hotReloadRunning ? 'primary' : 'outline'} onclick={openDevTools}
            title={hotReloadRunning ? `${language.pluginDevTools} (Hot reload)` : language.pluginDevTools}><CodeXmlIcon /></ShButton>
    {/snippet}
    {#snippet itemContent(index)}
        {@const plugin = DBState.db.plugins[index]}
        <div class="flex flex-col min-w-0 grow">
            <div class="flex items-center gap-2 min-w-0">
                <span class="text-textcolor truncate">{plugin.displayName ?? plugin.name}</span>
                {#if hotReloading.includes(plugin.name)}
                    <span class="text-xs rounded bg-amber-700 px-2 py-0.5 text-white shrink-0">Hot</span>
                {/if}
                <span class="grow"></span>
                {#if plugin.version === 2 || plugin.version === "2.1"}
                    <button class="no-sort text-yellow-400 cursor-pointer shrink-0" onclick={(e) => { e.stopPropagation(); alertMd(language.pluginV2Warning) }}>
                        <TriangleAlert size={18}/>
                    </button>
                {/if}
                {#if plugin.customLink}
                    {#each plugin.customLink as link}
                        {#if typeof link.link === "string" && (link.link.startsWith("http://") || link.link.startsWith("https://"))}
                            <a href={link.link} target="_blank" rel="nofollow noopener noreferrer"
                                class="no-sort text-textcolor2 hover:text-textcolor cursor-pointer shrink-0"
                                title={link.hoverText} onclick={(e) => e.stopPropagation()}>
                                <LinkIcon size={18}/>
                            </a>
                        {/if}
                    {/each}
                {/if}
                {#if plugin.updateURL}
                    {#await checkPluginUpdate(plugin) then updateInfo}
                        {#if updateInfo}
                            <button class="no-sort text-green-400 cursor-pointer shrink-0" title={language.pluginUpdateFoundInstallIt}
                                onclick={async (e) => {
                                    e.stopPropagation()
                                    if (await alertConfirm(language.pluginUpdateFoundInstallIt)) updatePlugin(plugin)
                                }}>
                                <PlusIcon size={18}/>
                            </button>
                        {/if}
                    {/await}
                {/if}
                <button class="no-sort shrink-0 cursor-pointer {plugin.enabled ? 'text-textcolor' : 'text-textcolor2'} hover:text-primary"
                    onclick={(e) => { e.stopPropagation(); togglePlugin(index) }}>
                    {#if plugin.enabled}<PowerIcon size={18}/>{:else}<PowerOffIcon size={18}/>{/if}
                </button>
            </div>
            {#if plugin.version === 1}
                <span class="text-draculared text-xs">
                    {language.pluginVersionWarn
                        .replace("{{plugin_version}}", "API V1")
                        .replace("{{required_version}}", "API V3")}
                </span>
            {/if}
        </div>
    {/snippet}
    {#snippet itemPanel(index)}
        {@const plugin = DBState.db.plugins[index]}
        {@const showAccess = plugin.version === '3.0' || openPermissionPlugin === plugin.name}
        <div class="flex flex-col bg-dark-900/50 p-3 rounded-md">
            <!-- Access first, plugin options second. Both blocks below are
                 "what may this plugin reach", and the permission section is
                 opened on demand from the row menu — behind a long argument
                 list it would open off-screen and read as a no-op. -->
            {#if plugin.version === '3.0'}
                {@const storageBytes = pluginStorageStore.totalBytes()}
                <div class="flex items-center">
                    <CheckInput bind:check={DBState.db.plugins[index].nodeOnlyFullStorageAccess} name={language.pluginFullStorageAccess} />
                </div>
                <span class="mt-1 text-sm text-textcolor2">
                    {language.pluginFullStorageAccessDesc.replace('{}', storageSizeText(storageBytes))}
                    <a href={fullStorageGuideUrl()} target="_blank" rel="nofollow noopener noreferrer" class="text-blue-400 hover:underline">{language.pluginFullStorageAccessGuide}</a>
                </span>
                {#if storageBytes >= FULL_STORAGE_WARN_BYTES}
                    <span class="mt-1 text-sm text-draculared">{language.pluginFullStorageAccessLarge}</span>
                {/if}
            {/if}
            {#if openPermissionPlugin === plugin.name}
                <!-- Same surface as the storage switch above (no second tinted
                     card): a rule separates the two, matching how the argument
                     dividers below already read. -->
                {#if plugin.version === '3.0'}
                    <div aria-hidden="true" class="w-full border-t border-darkborderc mt-4"></div>
                {/if}
                <div class="flex flex-col mt-4">
                    <div class="flex items-start gap-2">
                        <div class="flex flex-col min-w-0 grow">
                            <span class="font-bold text-sm">{language.pluginPermissionSettings}</span>
                            <span class="mt-1 text-xs text-textcolor2">{language.pluginPermissionSettingsDesc}</span>
                        </div>
                        <button class="no-sort shrink-0 p-1 rounded text-textcolor2 hover:text-textcolor cursor-pointer"
                            aria-label={language.close} title={language.close}
                            onclick={closePermissionPanel}>
                            <XIcon size={16}/>
                        </button>
                    </div>
                    {#if permissionLoadFailed}
                        <span class="mt-3 text-xs text-draculared">{language.pluginPermissionLoadFailed}</span>
                    {:else if !permissionStates}
                        <span class="mt-3 text-xs text-textcolor2">{language.loading}</span>
                    {:else}
                        {#each pluginPermissionDescList as desc}
                            <div class="flex flex-wrap items-center justify-between gap-2 mt-4">
                                <div class="flex flex-col min-w-40 flex-1">
                                    <span class="text-sm">{language.pluginPermissionLabels[desc].name}</span>
                                    <span class="text-xs text-textcolor2">{language.pluginPermissionLabels[desc].desc}</span>
                                </div>
                                <SegmentedControl
                                    size="sm"
                                    className="shrink-0 mb-0!"
                                    options={permissionStateOptions()}
                                    bind:value={
                                        () => permissionStates[desc],
                                        (v) => {
                                            void changePermissionState(plugin.name, desc, String(v) as PluginPermissionPresetState)
                                        }
                                    }
                                />
                            </div>
                        {/each}
                    {/if}
                    <button
                        class="mt-4 self-end text-xs text-textcolor2 hover:text-textcolor cursor-pointer"
                        onclick={async () => {
                            const v = await alertConfirm(
                                language.resetPluginPermissionConfirm.replace("{}", plugin.displayName ?? plugin.name)
                            )
                            if (v) {
                                await resetPluginPermission(plugin.name)
                                notifySuccess(language.resetPluginPermissionDone.replace("{}", plugin.displayName ?? plugin.name))
                                if (openPermissionPlugin === plugin.name) {
                                    await loadPermissionStates(plugin.name)
                                }
                            }
                        }}
                    >
                        {language.resetPluginPermission}
                    </button>
                </div>
            {/if}
            {#if showAccess && hasParams(plugin)}
                <div aria-hidden="true" class="w-full border-t border-darkborderc mt-4"></div>
            {/if}
            {#each Object.keys(plugin.arguments ?? {}) as arg}
                {#if !arg.startsWith("hidden_")}
                    {#if typeof(plugin?.argMeta?.[arg]?.divider) === 'string'}
                        {#if plugin?.argMeta?.[arg]?.divider}
                            <div class="flex items-center mt-6">
                                <div aria-hidden="true" class="w-full border-t border-darkborderc"></div>
                                <div class="relative flex justify-center">
                                    <span class="px-2 text-sm text-textarea text-nowrap">{plugin?.argMeta?.[arg]?.divider}</span>
                                </div>
                                <div aria-hidden="true" class="w-full border-t border-darkborderc"></div>
                            </div>
                        {:else}
                            <div aria-hidden="true" class="w-full border-t border-darkborderc mt-6"></div>
                        {/if}
                    {/if}
                    <span class="mb-2 mt-6">{plugin?.argMeta?.[arg]?.name || arg}</span>
                    {#if plugin?.argMeta?.[arg]?.description}
                        <span class="mb-2 text-sm text-textcolor2">{plugin?.argMeta?.[arg]?.description}</span>
                    {/if}
                    {#if Array.isArray(plugin.arguments[arg])}
                        <SelectInput
                            className="mt-2 mb-4"
                            bind:value={
                                DBState.db.plugins[index].realArg[arg] as string
                            }
                        >
                            {#each plugin.arguments[arg] as a}
                                <OptionInput value={a}>{a}</OptionInput>
                            {/each}
                        </SelectInput>
                    {:else if plugin.arguments[arg] === "string"}

                        {#if plugin?.argMeta?.[arg]?.textarea}
                            <TextAreaInput
                                className="mt-2"
                                bind:value={
                                    DBState.db.plugins[index].realArg[arg] as string
                                }
                                placeholder={plugin?.argMeta?.[arg]?.placeholder}
                            />
                        {:else if plugin?.argMeta?.[arg]?.radio}
                            {#each plugin?.argMeta?.[arg]?.radio?.split(",") as radioOption}
                                <CheckInput
                                    check={DBState.db.plugins[index].realArg[arg] === (radioOption.split('|').at(-1))}
                                    onChange={(e) => {
                                        if(e){
                                            DBState.db.plugins[index].realArg[arg] = (radioOption.split('|').at(-1))
                                        }
                                    }}
                                    margin={false}
                                    name={radioOption.split('|').at(0)}
                                />
                            {/each}
                        {:else}
                            <TextInput
                                className="mt-2"
                                bind:value={
                                    DBState.db.plugins[index].realArg[arg] as string
                                }
                                placeholder={plugin?.argMeta?.[arg]?.placeholder}
                            />
                        {/if}
                    {:else if plugin.arguments[arg] === "int"}
                        {#if plugin?.argMeta?.[arg]?.checkbox}
                            <CheckInput
                                check={DBState.db.plugins[index].realArg[arg] === '1'}
                                onChange={(e) => {
                                    DBState.db.plugins[index].realArg[arg] = e ? '1' : '0'
                                }}
                                margin={false}
                                name={
                                    plugin?.argMeta?.[arg]?.checkbox === '1' ? language.enable : plugin?.argMeta?.[arg]?.checkbox
                                }
                            />
                        {:else if plugin?.argMeta?.[arg]?.radio}
                            {#each plugin?.argMeta?.[arg]?.radio?.split(",") as radioOption}
                                <CheckInput
                                    check={DBState.db.plugins[index].realArg[arg] === parseInt(radioOption.split('|').at(-1))}
                                    onChange={(e) => {
                                        if(e){
                                            DBState.db.plugins[index].realArg[arg] = parseInt(radioOption.split('|').at(-1))
                                        }
                                    }}
                                    margin={false}
                                    name={radioOption.split('|').at(0)}
                                />
                            {/each}
                        {:else}
                            <NumberInput
                                className="mt-2"
                                bind:value={
                                    DBState.db.plugins[index].realArg[arg] as number
                                }
                                placeholder={plugin?.argMeta?.[arg]?.placeholder}
                            />
                        {/if}
                    {/if}
                {/if}
            {/each}
        </div>
    {/snippet}
    {#snippet itemMenu(index)}
        <!-- Distinct icons: two ShieldIcon rows in a row read as one repeated
             entry. The separator keeps these fork actions from merging into the
             folder/move block FolderedList appends after them. -->
        <ShDropdownMenuItem onSelect={() => {
            const name = DBState.db.plugins[index].name
            if (!showParams.includes(name)) showParams = [...showParams, name]
            void openPermissionPanel(name)
        }}><ShieldIcon /><span>{language.pluginPermissionSettings}</span></ShDropdownMenuItem>
        <ShDropdownMenuItem onSelect={() => resetPermission(index)}><RotateCcwIcon /><span>{language.resetPluginPermission}</span></ShDropdownMenuItem>
        <ShDropdownMenuSeparator />
    {/snippet}
</FolderedList>
{#if !DBState.db.plugins || DBState.db.plugins.length === 0}
    <!-- The list still renders its "uncategorized" box when empty (so folders
         stay discoverable); this is the hint under it, not a stray label. -->
    <span class="text-textcolor2 text-sm text-center py-6">{language.noPlugins}</span>
{/if}
</SettingPage>
