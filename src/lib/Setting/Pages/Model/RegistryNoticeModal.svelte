<script lang="ts">
    import { language } from "src/lang";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import type { RegistryNotice } from "src/ts/preset/registry/notice";

    interface Props {
        open: boolean;
        notice: RegistryNotice;
        // Called when the user closes via OK. `dismiss` reflects the
        // "don't show this again" checkbox — the parent acknowledges (updates
        // the seen-map) only when dismiss is true.
        onConfirm: (dismiss: boolean) => void;
    }

    let { open = $bindable(), notice, onConfirm }: Props = $props();

    let dismiss = $state(false);

    function fmtDate(ms?: number): string {
        // Strip the ko-locale trailing period ("2026. 6. 3." -> "2026. 6. 3").
        return ms ? new Date(ms).toLocaleDateString().replace(/\.\s*$/, '') : '';
    }

    function confirm() {
        onConfirm(dismiss);
        dismiss = false;
        open = false;
    }
</script>

<ShDialog bind:open size="default" tier="alert" closable={true} closeOnOutsideClick={true}>
    {#snippet title()}{language.registryNoticeTitle}{/snippet}
    {#snippet children()}
        <div class="flex flex-col gap-4">
            {#if notice.newProfiles.length > 0}
                <div class="flex flex-col gap-1">
                    <span class="text-sm font-semibold text-textcolor">{language.registryNoticeNewSection} ({notice.newProfiles.length})</span>
                    {#each notice.newProfiles as p (p.id)}
                        <div class="flex items-center justify-between gap-2 text-sm pl-2">
                            <span class="text-textcolor2 truncate flex items-center gap-2">
                                <span class="text-textcolor2/60 shrink-0">•</span>
                                <span class="truncate">{p.displayName}</span>
                            </span>
                            <span class="text-xs text-textcolor2 shrink-0">{fmtDate(p.updatedAt)}</span>
                        </div>
                    {/each}
                </div>
            {/if}
            {#if notice.updatedProfiles.length > 0}
                <div class="flex flex-col gap-1">
                    <span class="text-sm font-semibold text-textcolor">{language.registryNoticeUpdatedSection} ({notice.updatedProfiles.length})</span>
                    {#each notice.updatedProfiles as p (p.id)}
                        <div class="flex items-center justify-between gap-2 text-sm pl-2">
                            <span class="text-textcolor2 truncate flex items-center gap-2">
                                <span class="text-textcolor2/60 shrink-0">•</span>
                                <span class="truncate">{p.displayName}</span>
                            </span>
                            <span class="text-xs text-textcolor2 shrink-0">{fmtDate(p.updatedAt)}</span>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>
    {/snippet}
    {#snippet footer()}
        <CheckInput bind:check={dismiss} name={language.registryNoticeDismiss} className="mr-auto text-sm" />
        <ShButton variant="default" size="sm" onclick={confirm}>{language.registryNoticeConfirm}</ShButton>
    {/snippet}
</ShDialog>
