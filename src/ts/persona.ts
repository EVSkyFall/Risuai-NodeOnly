import { getDatabase, saveImage, setDatabase } from "./storage/database.svelte"
import { applyPersonaToRoot, liveUnitSyncState } from "./storage/presetPersonaUnits"
import { selectSingleFile, sleep } from "./util"
import { alertError, alertStore, notifySuccess, notifyError } from "./alert"
import { AppendableBuffer, downloadFile, readImage } from "./globalApi.svelte"
import { language } from "src/lang"
import { reencodeImage } from "./process/files/inlays"
import { PngChunk } from "./pngChunk"
import { v4 } from "uuid"

export async function selectUserImg() {
    const selected = await selectSingleFile(['png'])
    if (!selected) {
        return
    }
    const img = selected.data
    const before = getDatabase()
    const targetId = before.personas?.[before.selectedPersona]?.id
    const imgp = await saveImage(img)
    // The upload takes a while: a rebase may have replaced the database, and
    // the user may have moved to another persona. Work on the database that
    // is live now and on the persona the image was picked for.
    const db = getDatabase()
    const index = targetId ? db.personas.findIndex((persona) => persona?.id === targetId) : db.selectedPersona
    if (index === -1 || !db.personas[index]) {
        return
    }
    if (index !== db.selectedPersona) {
        db.personas[index].icon = imgp
        liveUnitSyncState.markPersonaDirtyId(db.personas[index].id)
        return
    }
    db.userIcon = imgp
    const nextId = db.personas[index].id ?? v4()
    db.personas[index] = {
        ...db.personas[index],
        name: db.username,
        icon: db.userIcon,
        personaPrompt: db.personaPrompt,
        note: db.userNote,
        id: nextId
    }
    liveUnitSyncState.markPersonaDirtyId(nextId)
    liveUnitSyncState.retakePersonaSnapshot(db)
}

export function saveUserPersona() {
    let db = getDatabase()
    const current = db.personas?.[db.selectedPersona]
    if (!current) {
        return
    }
    if (!liveUnitSyncState.isPersonaDirty(db)) {
        return
    }
    current.name = db.username
    current.icon = db.userIcon
    current.personaPrompt = db.personaPrompt
    current.note = db.userNote
    liveUnitSyncState.markPersonaDirtyId(current.id)
    liveUnitSyncState.retakePersonaSnapshot(db)
}

export function changeUserPersona(id: number, save: 'save' | 'noSave' = 'save') {
    if (save === 'save') {
        saveUserPersona()
    }
    let db = getDatabase()
    const pr = db.personas?.[id]
    if (!pr) {
        return
    }
    applyPersonaToRoot(db, pr)
    db.selectedPersona = id
    liveUnitSyncState.retakePersonaSnapshot(db)
}

interface PersonaCard {
    name: string
    personaPrompt: string
    note?: string
}

export async function exportUserPersona(personaIndex?: number) {
    let db = getDatabase({ snapshot: true })
    const persona = personaIndex === undefined
        ? {
            name: db.username,
            personaPrompt: db.personaPrompt,
            note: db.userNote,
            icon: db.userIcon,
        }
        : db.personas[personaIndex]
    if (!persona || !persona.name || !persona.personaPrompt) {
        notifyError("username or persona prompt is empty")
        return
    }

    let img: Uint8Array
    if (!persona.icon) {
        const canvas = document.createElement('canvas')
        canvas.width = 256
        canvas.height = 256
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = 'rgb(100, 116, 139)'
        ctx.fillRect(0, 0, 256, 256)
        const dataUrl = canvas.toDataURL('image/png')
        const base64 = dataUrl.split(',')[1]
        img = new Uint8Array(Buffer.from(base64, 'base64'))
    } else {
        img = await readImage(persona.icon)
    }

    let card: PersonaCard = safeStructuredClone({
        name: persona.name,
        personaPrompt: persona.personaPrompt,
        note: persona.note,
    })

    alertStore.set({
        type: 'wait',
        msg: 'Loading... (Writing Exif)'
    })

    await sleep(10)

    img = (await PngChunk.write(await reencodeImage(img), {
        "persona": Buffer.from(JSON.stringify(card)).toString('base64')
    })) as Uint8Array

    alertStore.set({
        type: 'wait',
        msg: 'Loading... (Writing)'
    })

    await sleep(10)
    await downloadFile(`${persona.name.replace(/[<>:"/\\|?*\.\,]/g, "")}_export.png`, img)

    notifySuccess(language.successExport)
}

export async function importUserPersona() {
    try {
        const v = await selectSingleFile(['png'])
        if (!v) {
            return
        }
        const readGenerator = PngChunk.readGenerator(v.data)
        let decoded: string | undefined;

        for await (const chunk of readGenerator) {
            if (chunk && !(chunk instanceof AppendableBuffer) && chunk.key === 'persona') {
                decoded = chunk.value
                break
            }
        }

        if (!decoded) {
            alertError(language.errors.noData)
            return
        }
        const data: PersonaCard = JSON.parse(Buffer.from(decoded, 'base64').toString('utf-8'))
        if (data.name && data.personaPrompt) {
            let db = getDatabase()
            db.personas.push({
                name: data.name,
                icon: await saveImage(await reencodeImage(v.data)),
                personaPrompt: data.personaPrompt,
                note: data.note,
                id: v4()
            })
            notifySuccess(language.successImport)
        } else {
            alertError(language.errors.noData)
        }
    } catch (error) {
        alertError(error)
        return
    }
}
