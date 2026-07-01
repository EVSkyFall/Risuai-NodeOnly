<script lang="ts">
    import { CopyIcon, HardDriveUploadIcon, ImageOffIcon, Share2Icon, Trash2Icon, TrashIcon, UploadIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import { alertConfirm, notifyError, notifySuccess } from "src/ts/alert";
    import {
        changeToPreset,
        copyPreset,
        downloadPreset,
        importPreset,
        saveCurrentPreset,
        withStableActivePreset,
    } from "src/ts/storage/database.svelte";
    import { selectSingleFile } from "src/ts/util";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";

    const activeIndex = $derived(DBState.db.botPresetsId);

    async function uploadIcon() {
        const sel = await selectSingleFile(['png', 'jpg', 'jpeg', 'webp']);
        if (!sel) return;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const img = new Image();
        //@ts-expect-error Uint8Array buffer type (ArrayBufferLike) is incompatible with BlobPart's ArrayBuffer
        const blob = new Blob([sel.data], { type: "image/png" });
        img.src = URL.createObjectURL(blob);
        await img.decode();
        canvas.width = 48;
        canvas.height = 48;
        ctx.drawImage(img, 0, 0, 48, 48);
        const data = canvas.toDataURL('image/jpeg', 0.7);
        DBState.db.botPresets[activeIndex].image = data;
    }

    function removeIcon() {
        DBState.db.botPresets[activeIndex].image = undefined;
    }

    function handleExport() {
        downloadPreset(activeIndex, 'risupreset');
        notifySuccess(language.presetExported);
    }

    function handleDuplicate() {
        const before = DBState.db.botPresets.length;
        copyPreset(activeIndex);
        const after = DBState.db.botPresets.length;
        if (after > before) {
            changeToPreset(after - 1);
            notifySuccess(language.presetDuplicated);
        }
    }

    async function handleImport() {
        const before = DBState.db.botPresets.length;
        await importPreset();
        const after = DBState.db.botPresets.length;
        if (after > before) {
            changeToPreset(after - 1);
            notifySuccess(language.presetImported);
        }
    }

    async function handleDelete() {
        if (DBState.db.botPresets.length <= 1) {
            notifyError(language.errors.onlyOnePreset);
            return;
        }
        const presetName = DBState.db.botPresets[activeIndex]?.name ?? '';
        const ok = await alertConfirm(`${language.presetDeleteConfirm}\n${presetName}`);
        if (!ok) return;

        // Flush in-flight edits into the active preset BEFORE mutating the array
        // (mirrors botpreset.svelte:217-235 deletion handling).
        saveCurrentPreset();
        const removing = activeIndex;
        const removingActive = removing === DBState.db.botPresetsId;
        withStableActivePreset(() => {
            const presets = DBState.db.botPresets;
            presets.splice(removing, 1);
            DBState.db.botPresets = presets;
        });
        if (removingActive) {
            changeToPreset(0, false);
        }
        notifySuccess(language.presetDeleted);
    }
</script>

<div class="flex flex-col gap-4">
    <div class="flex flex-col gap-1">
        <span class="text-textcolor">{language.name}</span>
        <TextInput bind:value={DBState.db.botPresets[activeIndex].name} fullwidth />
    </div>

    <div class="flex flex-col gap-2">
        <span class="text-textcolor">{language.icon}</span>
        <div class="flex items-center gap-3 p-2 rounded-md border border-darkborderc">
            {#if DBState.db.botPresets[activeIndex]?.image}
                <img src={DBState.db.botPresets[activeIndex].image} alt="icon"
                     class="w-12 h-12 rounded-md shrink-0" decoding="async" />
            {:else}
                <div class="w-12 h-12 rounded-md bg-darkbutton flex items-center justify-center text-textcolor2 shrink-0">
                    <ImageOffIcon size={20} />
                </div>
            {/if}
            <div class="flex flex-wrap gap-2 grow justify-end">
                <ShButton variant="default" size="sm" onclick={uploadIcon}>
                    <UploadIcon size={16} />
                    <span class="ml-1">{language.presetImport}</span>
                </ShButton>
                {#if DBState.db.botPresets[activeIndex]?.image}
                    <ShButton variant="destructive" size="sm" onclick={removeIcon}>
                        <TrashIcon size={16} />
                        <span class="ml-1">{language.iconRemove}</span>
                    </ShButton>
                {/if}
            </div>
        </div>
    </div>

    <div class="flex flex-col gap-2">
        <ShButton variant="default" size="default" className="w-full" onclick={handleDuplicate}>
            <CopyIcon size={16} />
            <span class="ml-1">{language.presetDuplicate}</span>
        </ShButton>
        <ShButton variant="default" size="default" className="w-full" onclick={handleExport}>
            <Share2Icon size={16} />
            <span class="ml-1">{language.presetExport}</span>
        </ShButton>
        <ShButton variant="default" size="default" className="w-full" onclick={handleImport}>
            <HardDriveUploadIcon size={16} />
            <span class="ml-1">{language.presetImport}</span>
        </ShButton>
        <ShButton variant="destructive" size="default" className="w-full" onclick={handleDelete}>
            <Trash2Icon size={16} />
            <span class="ml-1">{language.presetDelete}</span>
        </ShButton>
    </div>
</div>
