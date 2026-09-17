<script lang="ts">
    import { DBState } from "src/ts/stores.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { alertConfirm } from "src/ts/alert";

    async function resetFactors() {
        const ok = await alertConfirm('Reset all per-language Claude tokenizer factors to 1.0? The calibrated values cannot be recovered.');
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
    <h3 class="text-base font-semibold mb-2">Claude Tokenizer Correction</h3>
    <p class="text-xs text-textcolor2 mb-3">
        Claude token counts use the bundled claude.json tokenizer, which under-counts Claude 3+/4.x models.
        Each count is multiplied by the factor for the detected language. The factors were calibrated
        against Anthropic's <code>count_tokens</code> API and no longer change. Counting stays local.
    </p>

    <table class="w-full text-sm">
        <thead>
            <tr class="text-left text-textcolor2">
                <th class="font-normal">Language</th>
                <th class="font-normal">Factor</th>
                <th class="font-normal">Calibration samples</th>
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

    <div class="mt-4 flex items-center gap-3 flex-wrap text-sm">
        <Button onclick={resetFactors}>Reset Factors</Button>
    </div>
</div>
