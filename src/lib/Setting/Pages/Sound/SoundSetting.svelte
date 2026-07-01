<script lang="ts">
    import { language } from 'src/lang';
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte';
    import ShSlider from 'src/lib/UI/GUI/ShSlider.svelte';
    import { DBState } from 'src/ts/stores.svelte';
    import { playSoundPreview } from 'src/ts/notificationSound';
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte';
    import { PlayIcon, Music2Icon } from '@lucide/svelte';
    import SoundRow from './SoundRow.svelte';
    import SoundPickerModal from './SoundPickerModal.svelte';

    interface Props {
        description?: string;
        enabled?: boolean;
        sound?: string;
        volume?: number;
    }

    let {
        description,
        enabled = $bindable(false),
        sound = $bindable(''),
        volume = $bindable(100),
    }: Props = $props();

    let pickerOpen = $state(false);

    const soundName = $derived.by(() => {
        if (!sound || sound === 'default') return language.soundDefault;
        if (sound.startsWith('assets/')) {
            return (DBState.db.customSounds ?? []).find((s) => s.path === sound)?.name ?? language.uploadedSound;
        }
        return sound;
    });
</script>

<div class="divide-y divide-darkborderc">
    <SoundRow label={language.notificationEnable} {description}>
        <ShSwitch checked={enabled} onCheckedChange={(v) => (enabled = v)} />
    </SoundRow>

    <SoundRow label={language.soundEffect} dimmed={!enabled}>
        <div class="flex items-center gap-1 min-w-0">
            <ShButton
                variant="outline"
                size="sm"
                disabled={!enabled}
                onclick={() => (pickerOpen = true)}
                className="max-w-56"
            >
                <Music2Icon size={14} class="shrink-0" />
                <span class="truncate">{soundName}</span>
            </ShButton>
            <ShButton
                variant="ghost"
                size="icon-sm"
                disabled={!enabled}
                onclick={() => playSoundPreview(sound, volume)}
                aria-label={language.preview}
            >
                <PlayIcon size={16} />
            </ShButton>
        </div>
    </SoundRow>

    <SoundRow label={language.soundEffectVolume} dimmed={!enabled}>
        <div class="w-48">
            <ShSlider bind:value={volume} min={0} max={100} step={1} inputWidth="w-14" disabled={!enabled} />
        </div>
    </SoundRow>
</div>

<SoundPickerModal bind:open={pickerOpen} bind:value={sound} {volume} />
