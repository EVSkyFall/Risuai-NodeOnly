import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.join(HERE, 'server.cjs')
const utils = createRequire(import.meta.url)('./utils.cjs')

let tmpDir: string
let port: number
let base: string
let child: ChildProcessWithoutNullStreams
let token: string
let stdout = ''
let stderr = ''

function hexKey(key: string) {
    return Buffer.from(key, 'utf-8').toString('hex')
}

function jwt(secret: string) {
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300 })).toString('base64url')
    const sig = crypto.createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest('base64url')
    return `${header}.${payload}.${sig}`
}

function reservePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer()
        srv.once('error', reject)
        srv.listen(0, '127.0.0.1', () => {
            const nextPort = (srv.address() as net.AddressInfo).port
            srv.close(() => resolve(nextPort))
        })
    })
}

async function waitForServer() {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`server exited early\nstdout:\n${stdout}\nstderr:\n${stderr}`)
        }
        try {
            const res = await fetch(`${base}/api/test_auth`)
            if (res.ok) return
        } catch {
            // wait
        }
        await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`server did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`)
}

async function stopServer() {
    if (!child || child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
}

async function startServer() {
    port = await reservePort()
    base = `http://127.0.0.1:${port}`
    stdout = ''
    stderr = ''
    child = spawn(process.execPath, [SERVER_PATH], {
        cwd: tmpDir,
        env: {
            ...process.env,
            PORT: String(port),
            RISU_TUNNEL_DISABLED: 'true',
            RISU_UPDATE_CHECK: 'false',
            POCKETRISU_BACKUP_INTERVAL_MS: String(60 * 60 * 1000),
        },
    })
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    await waitForServer()
    const secret = fs.readFileSync(path.join(tmpDir, 'save', '__jwt_secret'), 'utf-8').trim()
    token = jwt(secret)
}

async function restartServer() {
    await stopServer()
    await startServer()
}

function authHeaders(sessionId = 'client-1'): Record<string, string> {
    return {
        'risu-auth': token,
        'x-session-id': sessionId,
    }
}

async function readClientDb(sessionId: string): Promise<any> {
    const res = await fetch(`${base}/api/read`, {
        method: 'GET',
        headers: {
            ...authHeaders(sessionId),
            'file-path': hexKey('database/database.bin'),
        },
    })
    expect(res.status).toBe(200)
    return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer())))
}

function seedRawDiskDb(dbObj: Record<string, unknown>) {
    const raw = Buffer.from(utils.encodeRisuSaveLegacy(dbObj))
    const sqlite = new Database(path.join(tmpDir, 'save', 'risuai.db'))
    sqlite.pragma('busy_timeout = 5000')
    try {
        sqlite.prepare(
            'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        ).run('database/database.bin', raw, Date.now())
    } finally {
        sqlite.close()
    }
}

describe('ensurePersonaIds & server persona.id persistence (Section 4 & Trap 10)', () => {
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-id-persist-'))
        fs.mkdirSync(path.join(tmpDir, 'save'), { recursive: true })
    })

    afterEach(async () => {
        await stopServer()
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('assigns missing persona.id on decode in utils.cjs and invokes onMintId only when missing', async () => {
        const encoded = utils.encodeRisuSaveLegacy({
            personas: [
                { name: 'Legacy Persona', icon: '', personaPrompt: 'Hello' },
                { id: 'existing-id', name: 'Identified', icon: '', personaPrompt: 'World' },
            ],
            botPresets: [
                { name: 'Legacy Preset', mainPrompt: 'P' },
            ],
            characters: [],
        })
        let mintCount = 0
        const decoded = await utils.decodeRisuSave(encoded, { onMintId: () => { mintCount++ } })
        expect(typeof decoded.personas[0].id).toBe('string')
        expect(decoded.personas[0].id.length).toBeGreaterThan(0)
        expect(decoded.personas[1].id).toBe('existing-id')
        expect(typeof decoded.botPresets[0].id).toBe('string')
        expect(decoded.botPresets[0].id.length).toBeGreaterThan(0)
        expect(mintCount).toBe(2)

        const reEncoded = utils.encodeRisuSaveLegacy(decoded)
        let secondMintCount = 0
        await utils.decodeRisuSave(reEncoded, { onMintId: () => { secondMintCount++ } })
        expect(secondMintCount).toBe(0)
    })

    it('gives a stored persona without an id the exact same id in two clients and persists it across restart', async () => {
        await startServer()
        await stopServer()
        seedRawDiskDb({
            personas: [
                { name: 'Idless Stored Persona', icon: '', personaPrompt: 'Stored prompt' },
                { id: 'fixed-persona', name: 'Fixed', icon: '', personaPrompt: 'Fixed prompt' },
            ],
            selectedPersona: 0,
            botPresets: [
                { name: 'Idless Stored Preset', mainPrompt: 'Preset prompt' },
            ],
            botPresetsId: 0,
            characters: [],
        })
        await startServer()

        const clientA = await readClientDb('tab-A')
        const clientB = await readClientDb('tab-B')

        const mintedPersonaId = clientA.personas[0].id
        const mintedPresetId = clientA.botPresets[0].id
        expect(typeof mintedPersonaId).toBe('string')
        expect(mintedPersonaId.length).toBeGreaterThan(0)
        expect(clientB.personas[0].id).toBe(mintedPersonaId)
        expect(clientB.personas[1].id).toBe('fixed-persona')
        expect(clientB.botPresets[0].id).toBe(mintedPresetId)

        // Restart without any client write — persisted database.bin must still hold the same minted ids!
        await restartServer()
        const clientAfterRestart = await readClientDb('tab-C')
        expect(clientAfterRestart.personas[0].id).toBe(mintedPersonaId)
        expect(clientAfterRestart.botPresets[0].id).toBe(mintedPresetId)
    }, 20_000)
})
