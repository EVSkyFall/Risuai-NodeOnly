<script lang="ts">
    // System → Plugin Storage tab. Built-in replacement for the community
    // "plugin-storage-viewer" plugin. Plugin data is stored in a single global
    // namespace (not per-plugin), so this is a flat key/value manager over the
    // three backends a plugin can write to:
    //   - save:  pluginCustomKv / plugin-custom-storage (normal pluginStorage)
    //   - local: localStorage `safe_plugin_*`  (device-local, strings only)
    //   - idb:   SafeLocalPluginStorage  (IndexedDB, device-local, JSON)
    // Origin plugin is best-effort: new V3 writes are tagged into a sidecar
    // meta store (pluginStorageMeta), but legacy/V2 keys have no record and show
    // as unknown. Edit/delete are allowed directly, guarded by confirm.
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShInput from 'src/lib/UI/GUI/ShInput.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import ShBadge from 'src/lib/UI/GUI/ShBadge.svelte'
    import ShToggle from 'src/lib/UI/GUI/ShToggle.svelte'
    import {
        RefreshCwIcon,
        Trash2Icon,
        PencilIcon,
        AlignLeftIcon,
        SaveIcon,
    } from '@lucide/svelte'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import { SafeLocalStorage, SafeLocalPluginStorage } from 'src/ts/plugins/pluginSafeClass'
    import { getOwners, removeOwner } from 'src/ts/plugins/pluginStorageMeta'
    import * as pluginStorageStore from 'src/ts/plugins/pluginStorageStore'
    import {
        PLUGIN_STORAGE_PREVIEW_CHARS,
        canCommitDetailMutation,
        canMutateDetail,
        createBoundedValuePreview,
        createPluginStorageBackendAdapter,
        isCurrentStorageOperation,
        matchesBoundedValue,
        type PluginStorageDetailGuard,
        type PluginStorageViewerBackend,
        type PluginStorageValuePreview,
    } from 'src/ts/plugins/pluginStorageViewer'
    import { language } from 'src/lang'

    type BackendId = PluginStorageViewerBackend

    // Sentinel filter value for entries with no recorded origin plugin.
    const UNKNOWN = '__risu_unknown__'

    interface Entry {
        key: string
        size: number | null
        type: string
        owner?: string
    }

    interface DetailState extends PluginStorageDetailGuard, PluginStorageValuePreview {}

    const BACKENDS: { id: BackendId; label: () => string; desc: () => string }[] = [
        { id: 'save', label: () => language.pluginStorageBackendSave, desc: () => language.pluginStorageBackendSaveDesc },
        { id: 'local', label: () => language.pluginStorageBackendLocal, desc: () => language.pluginStorageBackendLocalDesc },
        { id: 'idb', label: () => language.pluginStorageBackendIdb, desc: () => language.pluginStorageBackendIdbDesc },
    ]

    const safeLocal = new SafeLocalStorage()
    const idb = new SafeLocalPluginStorage()
    const storage = createPluginStorageBackendAdapter({
        custom: pluginStorageStore,
        local: safeLocal,
        idb,
        removeOwner,
    })

    let backendIndex = $state(0)
    const backend = $derived(BACKENDS[backendIndex].id)
    let entries = $state<Entry[]>([])
    let loading = $state(false)
    let loadError = $state<string | null>(null)
    let loadProgress = $state(0)
    let loadTotal = $state(0)
    // Monotonic token: a newer load() invalidates any in-flight older one
    // (e.g. when the user switches backend tabs mid-load).
    let loadToken = 0
    let searchKey = $state('')
    let searchVal = $state('')
    let valueSearchMatches = $state<Set<string> | null>(null)
    let valueSearching = $state(false)
    let valueSearchProgress = $state(0)
    let valueSearchTotal = $state(0)
    let valueSearchError = $state<string | null>(null)
    let valueSearchToken = 0
    let valueSearchTimer: ReturnType<typeof setTimeout> | null = null
    let ownerFilter = $state('')   // '' = all; UNKNOWN = no recorded origin; else plugin name

    let detailOpen = $state(false)
    let selected = $state<Entry | null>(null)
    let detailState = $state<DetailState | null>(null)
    let detailText = $state('')
    let detailLoading = $state(false)
    let detailError = $state<string | null>(null)
    let detailToken = 0
    let editing = $state(false)
    let editText = $state('')
    let saving = $state(false)
    let saveToken = 0

    const filtered = $derived.by(() => {
        const k = searchKey.trim().toLowerCase()
        const v = searchVal.trim()
        const f = ownerFilter
        return entries.filter((e) => {
            const keyMatch = !k || e.key.toLowerCase().includes(k)
            const valMatch = !v || valueSearchMatches?.has(e.key) === true
            const ownerMatch =
                !f || (f === UNKNOWN ? !e.owner : e.owner === f)
            return keyMatch && valMatch && ownerMatch
        })
    })

    // True when any search/owner filter narrows the list — drives the bulk
    // button label (delete-shown vs clear-all).
    const isFiltered = $derived(
        searchKey.trim() !== '' || searchVal.trim() !== '' || ownerFilter !== '',
    )

    // Distinct origin plugins present in the current backend, for the filter.
    const ownerOptions = $derived.by(() => {
        const set = new Set<string>()
        for (const e of entries) if (e.owner) set.add(e.owner)
        return [...set].sort((a, b) => a.localeCompare(b))
    })
    const hasUnknown = $derived(entries.some((e) => !e.owner))
    const detailCanMutate = $derived.by(() => {
        if (!selected || !detailState) return false
        return canMutateDetail(detailState, {
            backend,
            key: selected.key,
            generation: detailToken,
        })
    })

    // ── helpers ────────────────────────────────────────────────────────────
    function formatSize(bytes: number | null): string {
        if (bytes === null) return '—'
        if (bytes < 1024) return bytes + ' B'
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function detailSize(): string {
        if (!detailState) return '—'
        if (detailState.totalCharsExact) return formatSize(detailState.totalChars * 2)
        return `${formatSize(PLUGIN_STORAGE_PREVIEW_CHARS * 2)}+`
    }

    function clearDetailState() {
        detailToken++
        saveToken++
        selected = null
        detailState = null
        detailText = ''
        editText = ''
        detailLoading = false
        detailError = null
        editing = false
        saving = false
    }

    function closeDetail() {
        detailOpen = false
        clearDetailState()
    }

    function onDetailOpenChange(open: boolean) {
        detailOpen = open
        if (!open) clearDetailState()
    }

    function cancelValueSearch() {
        valueSearchToken++
        if (valueSearchTimer !== null) {
            clearTimeout(valueSearchTimer)
            valueSearchTimer = null
        }
        valueSearching = false
        valueSearchProgress = 0
        valueSearchTotal = 0
        valueSearchMatches = null
        valueSearchError = null
    }

    // ── actions ────────────────────────────────────────────────────────────
    async function load() {
        const token = ++loadToken
        const requestedBackend = backend
        cancelValueSearch()
        closeDetail()
        loading = true
        loadError = null
        loadProgress = 0
        loadTotal = 0
        entries = []
        try {
            if (requestedBackend === 'save') await pluginStorageStore.refreshIndex()
            const keys = await storage.keys(requestedBackend)
            if (!isCurrentStorageOperation(token, loadToken, requestedBackend, backend)) return
            loadTotal = keys.length

            // Best-effort origin map (key → plugin name). Empty for legacy/V2
            // keys written before tagging existed.
            const owners = await getOwners(requestedBackend)
            if (!isCurrentStorageOperation(token, loadToken, requestedBackend, backend)) return

            const list: Entry[] = []
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i]
                const summary = storage.summary(requestedBackend, key)
                list.push({ key, ...summary, owner: owners[key] })
                loadProgress = i + 1
                if ((i & 63) === 63) {
                    await new Promise((r) => setTimeout(r))
                    if (!isCurrentStorageOperation(token, loadToken, requestedBackend, backend)) return
                }
            }
            if (!isCurrentStorageOperation(token, loadToken, requestedBackend, backend)) return
            list.sort((a, b) => a.key.localeCompare(b.key))
            entries = list
        } catch (e) {
            if (!isCurrentStorageOperation(token, loadToken, requestedBackend, backend)) return
            loadError = e instanceof Error ? e.message : String(e)
            entries = []
        } finally {
            if (isCurrentStorageOperation(token, loadToken, requestedBackend, backend)) loading = false
        }
    }

    async function openDetail(entry: Entry) {
        const requestedBackend = backend
        const token = ++detailToken
        selected = entry
        detailState = null
        detailText = ''
        editText = ''
        detailError = null
        detailLoading = true
        editing = false
        detailOpen = true
        try {
            const raw = await storage.read(requestedBackend, entry.key)
            if (
                !isCurrentStorageOperation(token, detailToken, requestedBackend, backend)
                || !detailOpen
                || selected?.key !== entry.key
            ) return
            const preview = createBoundedValuePreview(raw)
            detailState = {
                ...preview,
                backend: requestedBackend,
                key: entry.key,
                generation: token,
            }
            detailText = preview.text
        } catch (e) {
            if (!isCurrentStorageOperation(token, detailToken, requestedBackend, backend)) return
            detailError = e instanceof Error ? e.message : String(e)
        } finally {
            if (isCurrentStorageOperation(token, detailToken, requestedBackend, backend)) detailLoading = false
        }
    }

    function startEdit() {
        if (!selected || !detailState || !detailCanMutate) return
        editText = detailText
        editing = true
    }

    function formatJson() {
        try {
            editText = JSON.stringify(JSON.parse(editText), null, 2)
        } catch (e) {
            notifyError(language.pluginStorageJsonError(e instanceof Error ? e.message : String(e)))
        }
    }

    async function saveEdit() {
        if (!selected || !detailState || !detailCanMutate) return
        const context = { ...detailState }
        const savedKey = context.key
        const savedBackend = context.backend
        const token = ++saveToken
        saving = true
        try {
            let saveValue: unknown
            if (savedBackend === 'local') {
                // localStorage holds strings; normalize valid JSON, keep raw otherwise.
                saveValue = editText
                try {
                    saveValue = JSON.stringify(JSON.parse(editText))
                } catch {}
            } else {
                // save/idb keep parsed JSON when possible, raw string otherwise.
                try {
                    saveValue = JSON.parse(editText)
                } catch {
                    saveValue = editText
                }
            }
            if (!canCommitDetailMutation(token, saveToken, context, {
                backend,
                key: selected.key,
                generation: detailToken,
            })) return
            await storage.write(savedBackend, savedKey, saveValue)
            if (!canCommitDetailMutation(token, saveToken, context, {
                backend,
                key: selected?.key ?? '',
                generation: detailToken,
            })) return
            saving = false
            await load()
            if (savedBackend !== backend) return
            const refreshed = entries.find((e) => e.key === savedKey)
            if (refreshed) await openDetail(refreshed)
            notifySuccess(language.pluginStorageSaved(savedKey))
        } catch (e) {
            if (token === saveToken) notifyError(e instanceof Error ? e.message : String(e))
        } finally {
            if (token === saveToken) saving = false
        }
    }

    async function removeEntry(entry: Entry) {
        if (loading || valueSearching) return
        const requestedBackend = backend
        const ok = await alertConfirm(language.pluginStorageDeleteConfirm(entry.key))
        if (!ok) return
        cancelValueSearch()
        if (selected?.key === entry.key) closeDetail()
        try {
            await storage.remove(requestedBackend, entry.key)
            if (requestedBackend === backend) await load()
            notifySuccess(language.pluginStorageDeleted)
        } catch (e) {
            notifyError(e instanceof Error ? e.message : String(e))
        }
    }

    // Bulk-delete every entry currently shown (i.e. matching the active search /
    // owner filter). With no filter this is the whole backend, so one button
    // serves both partial and full clears. The label reflects which it is.
    async function removeFiltered() {
        if (loading || valueSearching) return
        const requestedBackend = backend
        // Snapshot before load() swaps `entries` out from under `filtered`.
        const targets = filtered.slice()
        if (targets.length === 0) return

        const isAll = targets.length === entries.length
        const backendLabel = BACKENDS[backendIndex].label()
        const msg = isAll
            ? language.pluginStorageBulkDeleteAllConfirm(backendLabel, targets.length)
            : language.pluginStorageBulkDeleteConfirm(backendLabel, targets.length)
        const ok = await alertConfirm(msg)
        if (!ok) return

        cancelValueSearch()
        closeDetail()
        try {
            await storage.removeMany(requestedBackend, targets.map((entry) => entry.key))
            if (requestedBackend === backend) await load()
            notifySuccess(language.pluginStorageBulkDeleted(targets.length))
        } catch (e) {
            notifyError(e instanceof Error ? e.message : String(e))
            // Re-sync the UI to whatever actually got removed on partial failure.
            if (requestedBackend === backend) await load()
        }
    }

    async function runValueSearch(
        token: number,
        requestedBackend: BackendId,
        query: string,
        candidates: Entry[],
    ) {
        const matches = new Set<string>()
        try {
            for (let i = 0; i < candidates.length; i++) {
                const entry = candidates[i]
                const raw = await storage.read(requestedBackend, entry.key)
                if (!isCurrentStorageOperation(token, valueSearchToken, requestedBackend, backend)) return
                if (matchesBoundedValue(raw, query)) matches.add(entry.key)
                valueSearchProgress = i + 1
                if ((i & 7) === 7) {
                    await new Promise((resolve) => setTimeout(resolve))
                    if (!isCurrentStorageOperation(token, valueSearchToken, requestedBackend, backend)) return
                }
            }
            if (!isCurrentStorageOperation(token, valueSearchToken, requestedBackend, backend)) return
            valueSearchMatches = matches
        } catch (e) {
            if (!isCurrentStorageOperation(token, valueSearchToken, requestedBackend, backend)) return
            valueSearchMatches = new Set()
            valueSearchError = e instanceof Error ? e.message : String(e)
        } finally {
            if (isCurrentStorageOperation(token, valueSearchToken, requestedBackend, backend)) {
                valueSearching = false
            }
        }
    }

    // Debounced, capped value search. Matches stay private until the complete
    // current scan finishes so bulk delete can never act on partial results.
    $effect(() => {
        const query = searchVal.trim().toLocaleLowerCase()
        const requestedBackend = backend
        const currentEntries = entries
        const keyFilter = searchKey.trim().toLocaleLowerCase()
        const currentOwner = ownerFilter
        const waitingForLoad = loading
        const token = ++valueSearchToken

        if (valueSearchTimer !== null) clearTimeout(valueSearchTimer)
        valueSearchTimer = null
        valueSearchMatches = null
        valueSearchProgress = 0
        valueSearchTotal = 0
        valueSearchError = null
        valueSearching = false

        if (!query || requestedBackend === 'idb' || waitingForLoad) return

        const candidates = currentEntries.filter((entry) => {
            const keyMatch = !keyFilter || entry.key.toLocaleLowerCase().includes(keyFilter)
            const ownerMatch =
                !currentOwner
                || (currentOwner === UNKNOWN ? !entry.owner : entry.owner === currentOwner)
            return keyMatch && ownerMatch
        })
        valueSearching = true
        valueSearchTotal = candidates.length
        valueSearchTimer = setTimeout(() => {
            valueSearchTimer = null
            void runValueSearch(token, requestedBackend, query, candidates)
        }, 250)

        return () => {
            if (valueSearchTimer !== null) {
                clearTimeout(valueSearchTimer)
                valueSearchTimer = null
            }
        }
    })

    // Load on mount and whenever the backend tab changes; reset search per tab.
    let loadedIndex = -1
    $effect(() => {
        const idx = backendIndex
        if (idx === loadedIndex) return
        loadedIndex = idx
        searchKey = ''
        searchVal = ''
        ownerFilter = ''
        cancelValueSearch()
        closeDetail()
        void load()
    })
</script>

<p class="text-textcolor2 text-sm mb-4">{language.pluginStorageDesc}</p>

<!-- Backend selector (single-select ShToggle group). The active toggle is
     disabled so it can't be toggled off; opacity is restored so it still
     reads as the selected one. -->
<div class="flex flex-wrap gap-1 mb-2">
    {#each BACKENDS as b, i (b.id)}
        <ShToggle
            size="sm"
            pressed={backendIndex === i}
            disabled={backendIndex === i}
            onPressedChange={() => (backendIndex = i)}
            className="disabled:opacity-100"
        >
            {b.label()}
        </ShToggle>
    {/each}
</div>
<p class="text-textcolor2 text-xs mb-4 opacity-70">{BACKENDS[backendIndex].desc()}</p>

<!-- Search -->
<div class="flex flex-col sm:flex-row gap-2 mb-3">
    <ShInput bind:value={searchKey} placeholder={language.pluginStorageSearchKey} disabled={loading} />
    <ShInput
        bind:value={searchVal}
        placeholder={language.pluginStorageSearchValue}
        disabled={loading || backend === 'idb'}
    />
</div>
{#if backend === 'idb'}
    <p class="text-textcolor2 text-xs mb-3 opacity-70">{language.pluginStorageValueSearchDisabled}</p>
{:else}
    <p class="text-textcolor2 text-xs mb-3 opacity-70">{language.pluginStorageValueSearchLimited(formatSize(PLUGIN_STORAGE_PREVIEW_CHARS * 2))}</p>
{/if}
{#if valueSearchError}
    <p class="text-red-400 text-xs mb-3">{language.pluginStorageValueSearchError}: {valueSearchError}</p>
{/if}

<!-- Origin filter: System-Logs-style toggle chips. No chip selected = all.
     Clicking the active chip clears back to all (keeps pressed in sync with
     ownerFilter, so no toggle desync). -->
{#if ownerOptions.length > 0 || hasUnknown}
    <div class="flex items-start gap-2 mb-3">
        <span class="text-textcolor2 text-xs shrink-0 pt-1.5">{language.pluginStorageOwner}</span>
        <div class="flex flex-wrap gap-1">
            {#each ownerOptions as p (p)}
                <ShToggle size="xs" pressed={ownerFilter === p} onPressedChange={(on) => (ownerFilter = on ? p : '')}>
                    {p}
                </ShToggle>
            {/each}
            {#if hasUnknown}
                <ShToggle size="xs" pressed={ownerFilter === UNKNOWN} onPressedChange={(on) => (ownerFilter = on ? UNKNOWN : '')}>
                    {language.pluginStorageOwnerUnknown}
                </ShToggle>
            {/if}
        </div>
    </div>
{/if}

<!-- Count + bulk delete + refresh -->
<div class="flex items-center justify-between mb-2">
    <span class="text-textcolor2 text-xs">
        <ShBadge variant="secondary">{filtered.length}</ShBadge> / {entries.length} keys
    </span>
    <div class="flex items-center gap-1">
        <ShButton
            variant="destructive"
            size="sm"
            onclick={removeFiltered}
            disabled={loading || valueSearching || filtered.length === 0}
        >
            <Trash2Icon size={14} />
            {isFiltered
                ? language.pluginStorageBulkDeleteShown(filtered.length)
                : language.pluginStorageBulkDeleteAll(filtered.length)}
        </ShButton>
        <ShButton variant="ghost" size="sm" onclick={load} disabled={loading || valueSearching}>
            <RefreshCwIcon size={14} class={loading || valueSearching ? 'animate-spin' : ''} />
            {language.pluginStorageRefresh}
        </ShButton>
    </div>
</div>

<!-- List -->
<div class="flex flex-col gap-1 max-h-[60vh] overflow-y-auto rounded-md border border-darkborderc/50 p-1">
    {#if loading || valueSearching}
        <div class="flex flex-col items-center gap-3 text-textcolor2 text-sm py-12">
            <RefreshCwIcon size={20} class="animate-spin" />
            <span class="tabular-nums">
                {(loading ? loadTotal : valueSearchTotal) > 0
                    ? `${loading ? loadProgress : valueSearchProgress} / ${loading ? loadTotal : valueSearchTotal}`
                    : language.systemLogsLoading}
            </span>
            {#if (loading ? loadTotal : valueSearchTotal) > 0}
                <div class="w-48 h-1 rounded-full bg-darkborderc/50 overflow-hidden">
                    <div
                        class="h-full bg-primary transition-[width] duration-150"
                        style="width: {Math.round(((loading ? loadProgress : valueSearchProgress) / (loading ? loadTotal : valueSearchTotal)) * 100)}%"
                    ></div>
                </div>
            {/if}
        </div>
    {:else if loadError}
        <div class="text-textcolor2 text-sm text-center py-12">
            {language.pluginStorageLoadError}<br />
            <span class="text-xs opacity-60">{loadError}</span>
        </div>
    {:else if filtered.length === 0}
        <div class="text-textcolor2 text-sm text-center py-12">{language.pluginStorageEmpty}</div>
    {:else}
        {#each filtered as entry (entry.key)}
            <div
                class="group flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-selected cursor-pointer"
                role="button"
                tabindex="0"
                onclick={() => openDetail(entry)}
                onkeydown={(e) => { if (e.key === 'Enter') openDetail(entry) }}
            >
                <span class="font-mono text-sm text-textcolor truncate flex-1 min-w-0" title={entry.key}>{entry.key}</span>
                {#if entry.owner}
                    <ShBadge variant="secondary" className="max-w-[35%] overflow-hidden">{entry.owner}</ShBadge>
                {/if}
                <!-- The index-backed backends report no type without reading the
                     value, so a column of identical "UNKNOWN" labels carries no
                     information — the real type is resolved in the detail dialog. -->
                {#if entry.type && entry.type !== 'unknown'}
                    <span class="text-textcolor2 text-[10px] uppercase tracking-wide shrink-0 opacity-70">{entry.type}</span>
                {/if}
                <span class="text-textcolor2 text-xs shrink-0 tabular-nums"
                    title={entry.size === null ? language.pluginStorageSizeUnknown : undefined}>{formatSize(entry.size)}</span>
                <button
                    class="shrink-0 text-textcolor2 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer p-1"
                    aria-label={language.remove}
                    disabled={loading || valueSearching}
                    onclick={(e) => { e.stopPropagation(); removeEntry(entry) }}
                >
                    <Trash2Icon size={15} />
                </button>
            </div>
        {/each}
    {/if}
</div>

<!-- Detail / edit dialog. tier="base" (z-40) so the delete confirm popup
     (alert tier, z-50) renders above this management dialog. -->
<ShDialog bind:open={detailOpen} onOpenChange={onDetailOpenChange} size="xl" tier="base">
    {#snippet title()}
        <span class="font-mono break-all">{selected?.key ?? ''}</span>
    {/snippet}
    {#if selected}
        <div class="flex flex-wrap gap-x-6 gap-y-1 text-xs mb-3">
            <span class="text-textcolor2">{language.pluginStorageMetaType}: <span class="text-textcolor font-mono">{detailState?.type ?? selected.type}</span></span>
            <span class="text-textcolor2">{language.pluginStorageMetaSize}: <span class="text-textcolor font-mono">{detailState ? detailSize() : formatSize(selected.size)}</span></span>
            <span class="text-textcolor2">
                {language.pluginStorageMetaChars}:
                <span class="text-textcolor font-mono">
                    {detailState
                        ? `${detailState.totalCharsExact ? '' : '≥ '}${detailState.totalChars.toLocaleString()}`
                        : '—'}
                </span>
            </span>
            <span class="text-textcolor2">{language.pluginStorageOwner}: <span class="text-textcolor font-mono">{selected.owner ?? language.pluginStorageOwnerUnknown}</span></span>
        </div>

        {#if detailLoading}
            <div class="flex h-[50vh] items-center justify-center gap-2 text-textcolor2 text-sm">
                <RefreshCwIcon size={18} class="animate-spin" />
                {language.systemLogsLoading}
            </div>
        {:else if detailError}
            <div class="flex h-[50vh] items-center justify-center text-red-400 text-sm">{detailError}</div>
        {:else if editing}
            <textarea
                bind:value={editText}
                class="w-full h-[50vh] resize-none rounded-md border border-darkborderc bg-black/40 p-3 font-mono text-xs leading-relaxed text-textcolor outline-none focus-visible:border-borderc whitespace-pre"
                spellcheck="false"
            ></textarea>
        {:else}
            <pre class="w-full h-[50vh] overflow-auto rounded-md border border-darkborderc bg-black/40 p-3 font-mono text-xs leading-relaxed text-textcolor2 whitespace-pre-wrap break-all">{detailText}</pre>
            {#if detailState?.truncated}
                <p class="mt-2 text-amber-300 text-xs">
                    {detailState.totalCharsExact
                        ? language.pluginStoragePreviewTruncatedExact(
                            formatSize(PLUGIN_STORAGE_PREVIEW_CHARS * 2),
                            formatSize(detailState.totalChars * 2),
                        )
                        : language.pluginStoragePreviewTruncatedUnknown(formatSize(PLUGIN_STORAGE_PREVIEW_CHARS * 2))}
                </p>
            {/if}
        {/if}
    {/if}
    {#snippet footer()}
        <div class="flex justify-end gap-2">
            {#if editing}
                <ShButton variant="outline" onclick={formatJson} disabled={saving || !detailCanMutate}>
                    <AlignLeftIcon size={14} />
                    {language.pluginStorageFormatJson}
                </ShButton>
                <ShButton variant="outline" onclick={() => { editing = false; editText = detailText }} disabled={saving}>
                    {language.cancel}
                </ShButton>
                <ShButton variant="primary" onclick={saveEdit} disabled={saving || !detailCanMutate}>
                    <SaveIcon size={14} />
                    {language.pluginStorageSave}
                </ShButton>
            {:else}
                <ShButton variant="destructive" onclick={() => selected && removeEntry(selected)} disabled={saving || loading || valueSearching}>
                    <Trash2Icon size={14} />
                    {language.remove}
                </ShButton>
                <ShButton variant="outline" onclick={closeDetail}>
                    {language.close}
                </ShButton>
                <ShButton variant="primary" onclick={startEdit} disabled={!detailCanMutate}>
                    <PencilIcon size={14} />
                    {language.edit}
                </ShButton>
            {/if}
        </div>
    {/snippet}
</ShDialog>
