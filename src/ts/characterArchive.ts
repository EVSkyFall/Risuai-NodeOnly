/**
 * Character archive — shown to users as "deactivate / activate".
 *
 * A deactivated character leaves `db.characters` and is kept as a small stub in
 * `db.nodeOnlyArchivedCharacters`; its full body (chats, asset list) lives on
 * the server in kv `archive/<chaId>/<archivedAt>` (one immutable row per
 * deactivation; the stub names its row). Lists render the stub in place (dimmed)
 * and every other consumer — plugins, scripts, search, dataset export — sees
 * the character as if it had been deleted.
 *
 * Both moves happen here on the client, after the server has written/read the
 * payload, so the change reaches the server through the normal save path
 * (/api/patch) and dbCache, hashes and etag stay in one flow. The server
 * rejects a patch that would leave a chaId in both lists.
 */
import { get } from "svelte/store"
import { language } from "src/lang"
import { alertConfirm, alertError, notifyError, notifySuccess } from "./alert"
import { changeChar, deselectCharacter } from "./characters"
import { checkCharOrder, flushSaves, forageStorage, requestImmediateSave, requiresFullEncoderReload, trackCharacterForSave } from "./globalApi.svelte"
import { DBState, loadingOverlayStore, selectedCharID } from "./stores.svelte"
import { convertStubsToPlaceholders } from "./storage/chatStorage"
import type { ArchivedCharacterStub, character } from "./storage/database.svelte"
import { CharacterArchiveError, type ArchiveBatchResult, type NodeStorage } from "./storage/nodeStorage"
import { v4 } from "uuid"

export { CharacterArchiveError }

function storage(): NodeStorage {
    return forageStorage.realStorage as NodeStorage
}

export function getArchivedStubs(): ArchivedCharacterStub[] {
    return DBState.db.nodeOnlyArchivedCharacters ?? []
}

export function findArchivedStub(chaId: string): ArchivedCharacterStub | undefined {
    return getArchivedStubs().find((s) => s?.chaId === chaId)
}

// The trash takes a character out of characterOrder (checkCharOrder), folder
// included. Remember the folder so restoring can put it back.
function markTrashed(stub: ArchivedCharacterStub, trashedAt: number) {
    stub.trashedAt = trashedAt
    const folder = DBState.db.characterOrder?.find((e) => typeof e !== 'string' && e?.data?.includes(stub.chaId))
    if (folder && typeof folder !== 'string') stub.trashedFromFolder = folder.id
    else delete stub.trashedFromFolder
}

export function isArchivedCharacter(chaId: string): boolean {
    return !!findArchivedStub(chaId)
}

class ArchiveWaitCancelled extends Error {}

function withOverlay<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    loadingOverlayStore.set({ active: true, text: language.loading ?? '', onCancel: () => controller.abort() })
    return fn(controller.signal).finally(() => {
        loadingOverlayStore.set({ active: false, text: '', onCancel: null })
    })
}

function bulletList(names: string[], max = 5): string {
    const lines = names.slice(0, max).map((n) => `• ${n || '—'}`)
    if (names.length > max) lines.push(`• … +${names.length - max}`)
    return lines.join('\n')
}

/**
 * Deactivate the character at `index`. Asks for confirmation, then:
 * server writes + verifies the payload → the character moves from
 * `characters` to the stub list (one save tick) → selection is cleared.
 * Returns true when the character was deactivated.
 */
export async function archiveCharacter(index: number, arg: { skipConfirm?: boolean; trash?: boolean; trashedAt?: number; silent?: boolean } = {}): Promise<boolean> {
    const char = DBState.db.characters[index]
    if (!char?.chaId) return false
    const name = char.name || 'Unnamed'
    // skipConfirm: bulk callers (character manager) confirm once for the whole set.
    // trash: the trash is "deactivated + trashedAt marker" — same server row,
    // the stub just carries the marker (exported as upstream's trashTime).
    if (!arg.skipConfirm && !await alertConfirm(language.deactivateCharacterConfirm(name))) return false

    // acceptLostChats: chats whose body the server no longer has (lost before
    // this build) are stored as the empty chats they already show as. The
    // trash accepts that outright; a deactivation asks first.
    const run = async (acceptLostChats: boolean, signal?: AbortSignal) => {
        // A chat without an id is never uploaded by the save path; give it
        // one so its body reaches the server with the save below.
        let assignedIds = false
        for (const chat of char.chats ?? []) {
            if (chat && !chat._placeholder && !chat.id) {
                chat.id = v4()
                assignedIds = true
            }
        }
        if (assignedIds) trackCharacterForSave(char.chaId)
        // The server builds the payload from its own view: every edit (and
        // every chat body this browser holds) must have reached it first,
        // or the archived copy would silently miss them.
        await waitForArchiveSave(signal)
        const stub = await storage().archiveCharacter(char.chaId, { acceptLostChats })
        // Re-resolve both: a save above may have rebased the database object,
        // and the array may have shifted while the server worked.
        const db = DBState.db
        const idx = db.characters.findIndex((c) => c?.chaId === char.chaId)
        if (idx === -1) return false
        if (!Array.isArray(db.nodeOnlyArchivedCharacters)) db.nodeOnlyArchivedCharacters = []
        if (arg.trash) markTrashed(stub, arg.trashedAt ?? Date.now())
        db.nodeOnlyArchivedCharacters.push(stub)
        const selectedIndex = get(selectedCharID)
        db.characters.splice(idx, 1)
        checkCharOrder()
        requiresFullEncoderReload.state = true
        // Keep whatever else was selected (bulk actions and the boot-time
        // trash migration run while a chat may be open); only the archived
        // character itself loses the selection. Indices after `idx` shift by one.
        if (selectedIndex === idx || selectedIndex < 0) deselectCharacter()
        else if (selectedIndex > idx) selectedCharID.set(selectedIndex - 1)
        // Until this save lands the server still sees the character active.
        // The overlay stays up meanwhile; activation also waits for it.
        if (arg.silent) {
            void requestImmediateSave()
        } else {
            await waitForArchiveSave(signal)
            notifySuccess(arg.trash ? language.trashCharacterDone : language.deactivateCharacterDone)
        }
        return true
    }
    // silent: no overlay, no dialogs — the caller reports (migration logs).
    const attempt = (acceptLostChats: boolean) => arg.silent ? run(acceptLostChats) : withOverlay(signal => run(acceptLostChats, signal))
    const fail = (error: unknown) => {
        if (error instanceof ArchiveWaitCancelled) return isArchivedCharacter(char.chaId)
        alertError(language.deactivateCharacterFailed + (error instanceof Error ? error.message : String(error)))
        return false
    }
    try {
        return await attempt(!!arg.trash)
    } catch (error) {
        if (arg.silent) throw error
        if (!(error instanceof CharacterArchiveError && error.code === 'ARCHIVE_CHATS_UNAVAILABLE')) return fail(error)
        if (!await alertConfirm(language.deactivateCharacterLostChats(name, error.chats.length, bulletList(error.chats)))) return false
        return await attempt(true).catch(fail)
    }
}

const BULK_ARCHIVE_CHUNK = 20
let bulkArchiveQueue: Promise<void> = Promise.resolve()

export interface BulkArchiveOutcome {
    /** Characters moved to the stub list. */
    done: number
    /** Characters left active, with the reason. */
    failed: { chaId: string; name: string; reason: string }[]
    /** Refused because some chats have no content anywhere (only without acceptLostChats). */
    lost: { chaId: string; name: string; chats: string[] }[]
    /** The archive wait was cancelled; completed moves stay in the save queue. */
    stopped: boolean
}


// The chunk's successes, applied in one synchronous step to the database
// current after the request: the characters leave `characters`, their stubs
// join the stub list, the order is normalised once and the selection follows
// its character by id.
function applyArchived(successes: { chaId: string; stub: any }[], trash: boolean): number {
    const db = DBState.db
    const selectedChaId = db.characters[get(selectedCharID)]?.chaId
    if (!Array.isArray(db.nodeOnlyArchivedCharacters)) db.nodeOnlyArchivedCharacters = []
    const moved = new Set<string>()
    const now = Date.now()
    for (const { chaId, stub } of successes) {
        if (!db.characters.some((c) => c?.chaId === chaId)) continue
        if (trash) markTrashed(stub, now)
        if (!db.nodeOnlyArchivedCharacters.some((s) => s?.chaId === chaId)) db.nodeOnlyArchivedCharacters.push(stub)
        moved.add(chaId)
    }
    if (moved.size === 0) return 0
    for (let i = db.characters.length - 1; i >= 0; i--) {
        if (moved.has(db.characters[i]?.chaId)) db.characters.splice(i, 1)
    }
    checkCharOrder()
    requiresFullEncoderReload.state = true
    if (selectedChaId && moved.has(selectedChaId)) {
        deselectCharacter()
    } else if (selectedChaId) {
        const idx = db.characters.findIndex((c) => c?.chaId === selectedChaId)
        if (idx !== get(selectedCharID)) selectedCharID.set(idx)
    }
    return moved.size
}

/**
 * Deactivate (or trash) many characters. Rows are written in chunks by
 * /api/characters/archive-batch, which rewrites database.bin once per chunk
 * instead of once per character; after each chunk its successes are applied
 * and saved before the next one starts, so every character that leaves the
 * list is on the server first. A progress overlay stays up for the whole run.
 */
export function archiveCharacters(chaIds: string[], arg: { trash?: boolean; acceptLostChats?: boolean } = {}): Promise<BulkArchiveOutcome> {
    const targets = [...chaIds]
    const options = { ...arg }
    const run = bulkArchiveQueue.then(() => runArchiveCharacters(targets, options))
    bulkArchiveQueue = run.then(() => {}, () => {})
    return run
}

function waitForArchiveStep<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise
    return new Promise((resolve, reject) => {
        const cancel = () => reject(new ArchiveWaitCancelled())
        if (signal.aborted) cancel()
        else signal.addEventListener('abort', cancel, { once: true })
        const cleanup = () => signal.removeEventListener('abort', cancel)
        promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    })
}

async function waitForArchiveSave(signal?: AbortSignal): Promise<void> {
    for (;;) {
        if (signal?.aborted) throw new ArchiveWaitCancelled()
        try { if (await waitForArchiveStep(flushSaves(signal), signal)) return }
        catch (error) {
            if (error instanceof ArchiveWaitCancelled) throw error
            console.warn('[Archive] Saving pending edits failed; retrying', error)
        }
        await waitForArchiveStep(new Promise<void>(resolve => setTimeout(resolve, 500)), signal)
    }
}

async function requestArchiveChunk(ids: string[], acceptLostChats: boolean, signal: AbortSignal): Promise<ArchiveBatchResult[]> {
    for (;;) {
        if (signal.aborted) throw new ArchiveWaitCancelled()
        try { return await storage().archiveCharacters(ids, { acceptLostChats }) }
        catch (error) {
            const status = error instanceof CharacterArchiveError ? (error.status ?? Number(error.code.match(/^HTTP_(\d+)$/)?.[1])) : 0
            if (!(error instanceof TypeError || status === 408 || status === 425 || status === 429 || status >= 500)) throw error
            console.warn('[Archive] Chunk request failed; retrying', error)
            await waitForArchiveStep(new Promise<void>(resolve => setTimeout(resolve, 500)), signal)
        }
    }
}

async function runArchiveCharacters(chaIds: string[], arg: { trash?: boolean; acceptLostChats?: boolean }): Promise<BulkArchiveOutcome> {
    const outcome: BulkArchiveOutcome = { done: 0, failed: [], lost: [], stopped: false }
    const trash = !!arg.trash
    const controller = new AbortController()
    const signal = controller.signal
    const progress = (done: number, total: number) =>
        loadingOverlayStore.set({ active: true, text: language.bulkArchiveProgress(done, total, trash), onCancel: () => controller.abort() })
    try {
        const names = new Map<string, string>()
        const targets: string[] = []
        for (const chaId of new Set(chaIds)) {
            const char = DBState.db.characters.find((c) => c?.chaId === chaId)
            if (!char) continue
            names.set(chaId, char.name || 'Unnamed')
            targets.push(chaId)
            // Same as a single deactivation: a chat without an id is never
            // uploaded, so it gets one before the first save below.
            let assigned = false
            for (const chat of char.chats ?? []) {
                if (chat && !chat._placeholder && !chat.id) {
                    chat.id = v4()
                    assigned = true
                }
            }
            if (assigned) trackCharacterForSave(chaId)
        }
        if (targets.length === 0) return outcome
        progress(0, targets.length)
        await waitForArchiveSave(signal)
        for (let i = 0; i < targets.length; i += BULK_ARCHIVE_CHUNK) {
            const chunk = targets.slice(i, i + BULK_ARCHIVE_CHUNK)
            const results: ArchiveBatchResult[] = await requestArchiveChunk(chunk, arg.acceptLostChats ?? trash, signal)
            const successes: { chaId: string; stub: any }[] = []
            for (const r of results) {
                const name = names.get(r.chaId) ?? r.chaId
                if (r.ok) {
                    successes.push({ chaId: r.chaId, stub: (r as Extract<ArchiveBatchResult, { ok: true }>).stub })
                    continue
                }
                const f = r as Extract<ArchiveBatchResult, { ok: false }>
                if (f.code === 'ARCHIVE_CHATS_UNAVAILABLE') outcome.lost.push({ chaId: f.chaId, name, chats: f.chats ?? [] })
                else outcome.failed.push({ chaId: f.chaId, name, reason: f.error })
            }
            outcome.done += applyArchived(successes, trash)
            await waitForArchiveSave(signal)
            progress(Math.min(i + chunk.length, targets.length), targets.length)
        }
        return outcome
    } catch (error) {
        if (!(error instanceof ArchiveWaitCancelled)) throw error
        outcome.stopped = true
        return outcome
    } finally {
        loadingOverlayStore.set({ active: false, text: '', onCancel: null })
    }
}

/**
 * Re-activate a deactivated character. Server registers its chats and hands
 * back the client view; the character returns to `characters` and the stub is
 * removed (one save tick). Resolves to the new index, or -1 when there was
 * nothing to activate. Throws CharacterArchiveError on server failure.
 */
export async function activateCharacter(chaId: string, signal?: AbortSignal): Promise<number> {
    const list = DBState.db.nodeOnlyArchivedCharacters ?? []
    const stubIndex = list.findIndex((s) => s?.chaId === chaId)
    const existing = DBState.db.characters.findIndex((c) => c?.chaId === chaId)
    if (existing !== -1) {
        // Already active (e.g. another device activated it): just drop the stub.
        if (stubIndex !== -1) list.splice(stubIndex, 1)
        return existing
    }
    if (stubIndex === -1) return -1

    // Name the exact row this stub was made with (rows are versioned).
    const archivedAt = list[stubIndex]?.archivedAt
    let restored: character
    try {
        restored = await storage().activateCharacter(chaId, archivedAt)
    } catch (error) {
        if (!(error instanceof CharacterArchiveError && error.code === 'ARCHIVE_ALREADY_ACTIVE')) throw error
        // Usually our own deactivation has not reached the server yet: it
        // still lists the character as active. Dropping the stub here used to
        // make the save that followed delete the character outright. Finish
        // saving, then ask again; the stub stays whatever happens.
        await waitForArchiveSave(signal)
        try {
            restored = await storage().activateCharacter(chaId, archivedAt)
        } catch (retryError) {
            if (retryError instanceof CharacterArchiveError && retryError.code === 'ARCHIVE_ALREADY_ACTIVE') {
                throw new CharacterArchiveError(retryError.code, language.activateCharacterAlreadyActive)
            }
            throw retryError
        }
    }
    // Re-read: a save while we waited may have rebased the database object.
    const db = DBState.db
    if (db.characters.some((c) => c?.chaId === chaId)) {
        const stubIdx = (db.nodeOnlyArchivedCharacters ?? []).findIndex((s) => s?.chaId === chaId)
        if (stubIdx !== -1) db.nodeOnlyArchivedCharacters!.splice(stubIdx, 1)
        return db.characters.findIndex((c) => c?.chaId === chaId)
    }
    // The server sends chats as stubs; the client works with placeholders
    // (same conversion bootstrap applies to the whole database).
    restored.chats = convertStubsToPlaceholders(restored.chats ?? [])
    // The trash marker lives on the stub, never on the body (a body archived
    // by the legacy-trash migration may still carry the old flag).
    delete restored.trashTime
    db.characters.push(restored)
    const stubIdxNow = (db.nodeOnlyArchivedCharacters ?? []).findIndex((s) => s?.chaId === chaId)
    if (stubIdxNow !== -1) db.nodeOnlyArchivedCharacters!.splice(stubIdxNow, 1)
    checkCharOrder()
    requiresFullEncoderReload.state = true
    void requestImmediateSave()
    return db.characters.length - 1
}

/** Move an already-deactivated character to the trash (marker only; nothing moves on the server). */
export function trashDeactivatedCharacter(chaId: string): boolean {
    const stub = findArchivedStub(chaId)
    if (!stub || stub.trashedAt) return false
    markTrashed(stub, Date.now())
    checkCharOrder()
    void requestImmediateSave()
    return true
}

/** Take a trashed character out of the trash. It stays deactivated (its previous state) until opened. */
export function restoreTrashedCharacter(chaId: string): boolean {
    const stub = findArchivedStub(chaId)
    if (!stub || !stub.trashedAt) return false
    delete stub.trashedAt
    const folderId = stub.trashedFromFolder
    delete stub.trashedFromFolder
    const folder = folderId && DBState.db.characterOrder?.find((e) => typeof e !== 'string' && e?.id === folderId)
    if (folder && typeof folder !== 'string' && !folder.data.includes(chaId)) folder.data.push(chaId)
    checkCharOrder()
    void requestImmediateSave()
    return true
}

/** Permanently delete a trashed character: server rows first, then the stub. Throws CharacterArchiveError. */
export async function deleteTrashedCharacter(chaId: string): Promise<boolean> {
    const stub = findArchivedStub(chaId)
    if (!stub) return false
    await storage().deleteArchivedCharacter(chaId)
    return removeArchivedStub(chaId)
}

/**
 * Legacy trash (a live character carrying `trashTime`, written by older
 * builds, upstream imports or .bin restores) → deactivated + trashedAt.
 * Best effort at boot: a character that fails to archive stays legacy and is
 * retried next boot. The lists render both shapes.
 */
export async function migrateLegacyTrash(): Promise<void> {
    const db = DBState.db
    const ids = db.characters.filter((c) => c?.chaId && c.trashTime).map((c) => c.chaId)
    for (const chaId of ids) {
        const idx = db.characters.findIndex((c) => c?.chaId === chaId)
        if (idx === -1) continue
        const trashedAt = db.characters[idx].trashTime
        try {
            await archiveCharacter(idx, { skipConfirm: true, trash: true, trashedAt, silent: true })
        } catch (error) {
            console.warn('[Trash] legacy trash migration skipped for', chaId, error)
        }
    }
}

/** Drop a stub whose payload is gone for good (recovery path; nothing else is deleted). */
export function removeArchivedStub(chaId: string): boolean {
    const list = DBState.db.nodeOnlyArchivedCharacters ?? []
    const idx = list.findIndex((s) => s?.chaId === chaId)
    if (idx === -1) return false
    list.splice(idx, 1)
    checkCharOrder()
    requiresFullEncoderReload.state = true
    void requestImmediateSave()
    return true
}

/**
 * List-click entry point: "This character is deactivated. Activate it?" →
 * activate → open it like a normal selection.
 */
export async function promptActivateCharacter(chaId: string, arg: { reseter?: () => any } = {}): Promise<boolean> {
    const stub = findArchivedStub(chaId)
    if (!stub) return false
    if (!await alertConfirm(language.activateCharacterConfirm(stub.name || 'Unnamed'))) return false
    try {
        const index = await withOverlay(signal => activateCharacter(chaId, signal))
        if (index < 0) return false
        changeChar(index, arg)
        return true
    } catch (error) {
        if (error instanceof ArchiveWaitCancelled) return false
        if (error instanceof CharacterArchiveError
            && (error.code === 'ARCHIVE_PAYLOAD_MISSING' || error.code === 'ARCHIVE_PAYLOAD_INVALID')) {
            // Nothing to restore from: offer to drop the stub so the dashboard,
            // orphan sweep and export stop failing closed on it.
            if (await alertConfirm(language.activateCharacterMissing + '\n\n' + language.activateCharacterRemoveStub)) {
                removeArchivedStub(chaId)
            }
        } else {
            alertError(language.activateCharacterFailed + (error instanceof Error ? error.message : String(error)))
        }
        return false
    }
}

/** Every deactivated character as a full record (for the client-assembled partial backup). */
export async function fetchArchivedCharactersInline(): Promise<{ characters: character[]; nodeOnlyArchivedCharacters: ArchivedCharacterStub[]; warnings: string[] }> {
    if (getArchivedStubs().length === 0) return { characters: [], nodeOnlyArchivedCharacters: [], warnings: [] }
    return await storage().fetchArchivedCharactersInline()
}

export function isCharacterSelected(index: number): boolean {
    return get(selectedCharID) === index
}
