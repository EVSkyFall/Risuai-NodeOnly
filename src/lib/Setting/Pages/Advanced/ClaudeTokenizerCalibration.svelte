<script lang="ts">
    import { DBState } from "src/ts/stores.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import { alertConfirm } from "src/ts/alert";
    import { clearClaudeTokenizerPersistentCache, getClaudeTokenizerPersistentCacheSize } from "src/ts/tokenizer";

    let cacheSize = $state(0);
    let refreshTick = $state(0);

    $effect(() => {
        refreshTick;
        cacheSize = getClaudeTokenizerPersistentCacheSize();
    });

    function refresh() {
        refreshTick++;
    }

    async function clearCache() {
        const ok = await alertConfirm('Clear Claude tokenizer persistent cache? Next chat will be slow as it re-fetches counts.');
        if (!ok) return;
        await clearClaudeTokenizerPersistentCache();
        refresh();
    }

    async function resetFactors() {
        const ok = await alertConfirm('Reset all per-language tokenizer factors to 1.0?');
        if (!ok) return;
        DBState.db.claudeTokenizerFactorKO = 1.0;
        DBState.db.claudeTokenizerFactorEN = 1.0;
        DBState.db.claudeTokenizerFactorJP = 1.0;
        DBState.db.claudeTokenizerFactorSamplesKO = 0;
        DBState.db.claudeTokenizerFactorSamplesEN = 0;
        DBState.db.claudeTokenizerFactorSamplesJP = 0;
    }
</script>

<div class="mt-6 border border-darkborderc rounded-md p-4">
    <h3 class="text-base font-semibold mb-2">Claude Tokenizer (API-backed)</h3>
    <p class="text-xs text-textcolor2 mb-3">
        Bundled claude.json (2022) is inaccurate for Claude 3+/4.x. When enabled, RisuAI calls
        Anthropic's <code>count_tokens</code> API for accurate counts (cached persistently).
        On rate-limit (HTTP 429) or network failure, falls back to local tokenizer scaled by
        per-language factor (auto-learned from API observations).
    </p>

    <Check bind:check={DBState.db.claudeTokenizerAPIEnabled} name="Use Anthropic count_tokens API" />

    {#if DBState.db.claudeTokenizerAPIEnabled}
        <div class="mt-3 flex flex-col gap-2">
            <label class="text-sm">
                Anthropic API Key
                <input
                    type="password"
                    class="w-full mt-1 px-2 py-1 bg-darkbg2 border border-darkborderc rounded text-sm"
                    bind:value={DBState.db.claudeTokenizerAPIKey}
                    placeholder="sk-ant-..."
                />
            </label>
            <label class="text-sm">
                Model (for tokenization only)
                <input
                    type="text"
                    class="w-full mt-1 px-2 py-1 bg-darkbg2 border border-darkborderc rounded text-sm"
                    bind:value={DBState.db.claudeTokenizerAPIModel}
                    placeholder="claude-opus-4-7"
                />
            </label>
        </div>

        <div class="mt-4">
            <h4 class="text-sm font-semibold mb-2">Per-language fallback factors (learned via EMA)</h4>
            <table class="w-full text-sm">
                <thead>
                    <tr class="text-left text-textcolor2">
                        <th class="font-normal">Language</th>
                        <th class="font-normal">Factor</th>
                        <th class="font-normal">Samples</th>
                    </tr>
                </thead>
                <tbody class="font-mono">
                    <tr>
                        <td>Korean</td>
                        <td>{(DBState.db.claudeTokenizerFactorKO ?? 1.0).toFixed(4)}</td>
                        <td>{DBState.db.claudeTokenizerFactorSamplesKO ?? 0}</td>
                    </tr>
                    <tr>
                        <td>English</td>
                        <td>{(DBState.db.claudeTokenizerFactorEN ?? 1.0).toFixed(4)}</td>
                        <td>{DBState.db.claudeTokenizerFactorSamplesEN ?? 0}</td>
                    </tr>
                    <tr>
                        <td>Japanese</td>
                        <td>{(DBState.db.claudeTokenizerFactorJP ?? 1.0).toFixed(4)}</td>
                        <td>{DBState.db.claudeTokenizerFactorSamplesJP ?? 0}</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div class="mt-4 flex items-center gap-3 flex-wrap text-sm">
            <span>Cache: <strong>{cacheSize}</strong> entries</span>
            <Button onclick={refresh}>Refresh</Button>
            <Button onclick={clearCache}>Clear Cache</Button>
            <Button onclick={resetFactors}>Reset Factors</Button>
        </div>

        <p class="text-xs text-textcolor2 mt-3">
            Cache is persisted in IndexedDB and survives reloads. First chat after enabling /
            cache clear may be slow (cold start). 100 RPM rate limit.
        </p>
    {/if}
</div>
