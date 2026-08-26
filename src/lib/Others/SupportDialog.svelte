<script lang="ts">
    import { HeartIcon, ExternalLinkIcon, UserPenIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { openURL } from "src/ts/globalApi.svelte";
    import { supportDialogOpen, fetchSupporters, PATREON_URL, UPSTREAM_PATREON_URL, type SupportersData, type Supporter } from "src/ts/support";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import { cn } from "src/lib/utils";

    let data: SupportersData | null = $state(null);
    let loading = $state(false);
    let failed = $state(false);
    let tab: 'members' | 'lifetime' = $state('members');

    async function load() {
        loading = true;
        failed = false;
        try {
            data = await fetchSupporters();
        } catch {
            failed = true;
        } finally {
            loading = false;
        }
    }

    // Fetch on every open — server caches for 60s, so this stays cheap and near-live.
    $effect(() => {
        if ($supportDialogOpen) load();
    });

    const active = $derived((data?.supporters ?? []).filter(s => s.status === 'active'));
    const former = $derived((data?.supporters ?? []).filter(s => s.status === 'former'));

    // Members tab: group active supporters by tier, highest tier first (tiers arrive sorted desc).
    const tierGroups = $derived(
        (data?.tiers ?? [])
            .map(t => ({ tier: t, members: active.filter(s => s.tierId === t.id) }))
            .filter(g => g.members.length > 0)
    );

    function usd(cents: number): string {
        return `$${Math.round(cents / 100)}`;
    }

    function bucketLabel(bucket: number): string | null {
        const b = data?.buckets ?? [];
        return bucket > 0 && b[bucket - 1] != null ? `${usd(b[bucket - 1])}+` : null;
    }

    // Border strength climbs with bucket; only the top bucket gets a primary tint.
    function chipClass(s: Supporter): string {
        const top = (data?.buckets.length ?? 0);
        const bucketClass =
            s.bucket >= top && top > 0 ? 'border-primary bg-primary/10'
            : s.bucket >= 2 ? 'border-borderc'
            : s.bucket >= 1 ? 'border-darkborderc'
            : 'border-darkborderc/60';
        return cn(
            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm',
            bucketClass,
            s.status === 'active' ? 'text-textcolor' : 'text-textcolor2'
        );
    }

    function updatedText(iso: string | null): string {
        if (!iso) return '';
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
    }
</script>

<ShDialog
    bind:open={$supportDialogOpen}
    size="lg"
    tier="base"
    contentClass="max-h-[90vh]"
>
    {#snippet title()}
        <span class="flex items-center gap-2">
            <HeartIcon size={18} class="text-primary" />
            {language.supportTitle}
        </span>
    {/snippet}

    <p class="text-sm text-textcolor2 leading-relaxed whitespace-pre-line">{language.supportDesc}</p>

    <div class="flex flex-col gap-2 rounded-md border border-darkborderc bg-bgcolor/40 p-3">
        <div class="flex flex-wrap gap-2">
            <ShButton variant="primary" className="flex-1" onclick={() => openURL(PATREON_URL)}>
                <HeartIcon size={14} />
                {language.supportButton}
                <ExternalLinkIcon size={12} />
            </ShButton>
            {#if data?.nameUrl}
                <ShButton variant="outline" onclick={() => openURL(data.nameUrl)}>
                    <UserPenIcon size={14} />
                    {language.supportSetName}
                </ShButton>
            {/if}
        </div>
        <span class="text-xs text-textcolor2">{language.supportSetNameDesc}</span>
    </div>

    {#if data?.disabled}
        <span class="text-sm text-textcolor2">{language.supportDisabled}</span>
    {:else if loading && !data}
        <div class="flex flex-wrap gap-2" aria-busy="true">
            {#each Array(8) as _}
                <span class="h-7 w-20 rounded-md bg-selected/40 animate-pulse"></span>
            {/each}
        </div>
    {:else if failed && !data}
        <ShAlert variant="warning">
            <span class="flex items-center justify-between gap-2 w-full">
                {language.supportLoadFailed}
                <ShButton size="sm" variant="outline" onclick={load}>{language.supportRetry}</ShButton>
            </span>
        </ShAlert>
    {:else if data}
        <div class="flex items-center justify-between gap-2 flex-wrap">
            <span class="text-sm text-textcolor2">
                {language.supportCount.replace('{n}', String(data.supporters.length))}
                {#if data.updatedAt}
                    · {updatedText(data.updatedAt)}
                {/if}
            </span>
            <SegmentedControl
                size="sm"
                bind:value={tab}
                options={[
                    { value: 'members', label: language.supportTabMembers },
                    { value: 'lifetime', label: language.supportTabLifetime },
                ]}
            />
        </div>

        {#if data.supporters.length === 0}
            <span class="text-sm text-textcolor2">{language.supportEmpty}</span>
        {:else if tab === 'members'}
            {#each tierGroups as g (g.tier.id)}
                <div class="flex flex-col gap-1.5">
                    <span class="text-xs font-semibold text-textcolor2">
                        {g.tier.title} · {usd(g.tier.amountCents)}/{language.supportPerMonth}
                    </span>
                    <div class="flex flex-wrap gap-1.5">
                        {#each g.members as s}
                            <span class={chipClass(s)}>{s.name}</span>
                        {/each}
                    </div>
                </div>
            {/each}
            {#if tierGroups.length === 0}
                <span class="text-sm text-textcolor2">{language.supportEmpty}</span>
            {/if}
        {:else}
            <div class="flex flex-wrap gap-1.5">
                {#each data.supporters as s}
                    <span class={chipClass(s)}>
                        {s.name}
                        {#if bucketLabel(s.bucket)}
                            <span class="text-[10px] text-textcolor2">{bucketLabel(s.bucket)}</span>
                        {/if}
                    </span>
                {/each}
            </div>
            {#if former.length > 0}
                <span class="text-xs text-textcolor2">{language.supportFormerNote}</span>
            {/if}
        {/if}
    {/if}

    <button
        type="button"
        class="text-xs text-textcolor2 hover:text-textcolor text-left"
        onclick={() => openURL(UPSTREAM_PATREON_URL)}
    >
        {language.supportUpstream} →
    </button>
</ShDialog>
