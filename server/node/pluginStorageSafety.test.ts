import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import pkg from './pluginStorageSafety.cjs'

const { preparePluginStorageImport, writePluginStorageRescue } = pkg as {
    preparePluginStorageImport: (options: {
        storageKey: string
        pluginWipeDone: boolean
        dumpPluginStorageRescue: () => Promise<unknown>
        kvDelPrefix: (prefix: string) => void
    }) => Promise<boolean>
    writePluginStorageRescue: (options: {
        backupsDir: string
        kvList: (prefix: string) => string[]
        kvGet: (key: string) => Buffer | null
        now?: Date
        log?: (message: string) => void
    }) => Promise<string>
}

const tempDirs: string[] = []

async function freshTempDir() {
    const dir = await mkdtemp(path.join(tmpdir(), 'risu-plugin-rescue-'))
    tempDirs.push(dir)
    return dir
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('writePluginStorageRescue', () => {
    it('streams both plugin namespaces as raw-byte base64 NDJSON', async () => {
        const backupsDir = await freshTempDir()
        const values = new Map<string, Buffer>([
            ['plugin-custom-storage/YQ.json', Buffer.from('{"value":1}')],
            ['plugin-blob-storage/Yg.json', Buffer.from([0, 1, 2, 255])],
            ['assets/ignored', Buffer.from('ignored')],
        ])
        const logs: string[] = []

        const rescuePath = await writePluginStorageRescue({
            backupsDir,
            kvList: (prefix) => [...values.keys()].filter((key) => key.startsWith(prefix)),
            kvGet: (key) => values.get(key) ?? null,
            now: new Date('2026-07-12T01:02:03.456Z'),
            log: (message) => logs.push(message),
        })

        expect(path.basename(rescuePath)).toBe('plugin-rescue-2026-07-12T01-02-03.456Z.ndjson.gz')
        const lines = gunzipSync(await readFile(rescuePath))
            .toString('utf-8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        expect(lines).toEqual([
            { key: 'plugin-blob-storage/Yg.json', b64: Buffer.from([0, 1, 2, 255]).toString('base64') },
            { key: 'plugin-custom-storage/YQ.json', b64: Buffer.from('{"value":1}').toString('base64') },
        ])
        expect(logs).toHaveLength(1)
        expect(logs[0]).toContain('(2 rows, 15 bytes)')
    })

    it('keeps only the three newest completed rescue files', async () => {
        const backupsDir = await freshTempDir()
        const oldFiles = [
            'plugin-rescue-2026-07-12T01-00-00.000Z.ndjson.gz',
            'plugin-rescue-2026-07-12T02-00-00.000Z.ndjson.gz',
            'plugin-rescue-2026-07-12T03-00-00.000Z.ndjson.gz',
        ]
        await Promise.all(oldFiles.map((name) => writeFile(path.join(backupsDir, name), 'old')))

        await writePluginStorageRescue({
            backupsDir,
            kvList: () => [],
            kvGet: () => null,
            now: new Date('2026-07-12T04:00:00.000Z'),
            log: () => {},
        })

        const files = (await readdir(backupsDir)).sort()
        expect(files).toEqual([
            'plugin-rescue-2026-07-12T02-00-00.000Z.ndjson.gz',
            'plugin-rescue-2026-07-12T03-00-00.000Z.ndjson.gz',
            'plugin-rescue-2026-07-12T04-00-00.000Z.ndjson.gz',
        ])
    })

    it('rejects and removes temporary output when a listed row cannot be read', async () => {
        const backupsDir = await freshTempDir()

        await expect(writePluginStorageRescue({
            backupsDir,
            kvList: (prefix) => prefix === 'plugin-custom-storage/' ? [`${prefix}missing.json`] : [],
            kvGet: () => null,
            log: () => {},
        })).rejects.toThrow('could not read KV key')

        expect(await readdir(backupsDir)).toEqual([])
    })
})

describe('preparePluginStorageImport', () => {
    it('does nothing for archives without plugin entries', async () => {
        const calls: string[] = []
        const done = await preparePluginStorageImport({
            storageKey: 'assets/image.png',
            pluginWipeDone: false,
            dumpPluginStorageRescue: async () => { calls.push('dump') },
            kvDelPrefix: (prefix) => calls.push(prefix),
        })

        expect(done).toBe(false)
        expect(calls).toEqual([])
    })

    it('dumps and wipes both namespaces only before the first plugin entry', async () => {
        const calls: string[] = []
        const options = {
            dumpPluginStorageRescue: async () => { calls.push('dump') },
            kvDelPrefix: (prefix: string) => calls.push(`delete:${prefix}`),
        }

        let done = await preparePluginStorageImport({
            ...options,
            storageKey: 'plugin-custom-storage/first.json',
            pluginWipeDone: false,
        })
        done = await preparePluginStorageImport({
            ...options,
            storageKey: 'plugin-blob-storage/second.json',
            pluginWipeDone: done,
        })

        expect(done).toBe(true)
        expect(calls).toEqual([
            'dump',
            'delete:plugin-custom-storage/',
            'delete:plugin-blob-storage/',
        ])
    })

    it('never deletes when the rescue dump fails', async () => {
        const deleted: string[] = []

        await expect(preparePluginStorageImport({
            storageKey: 'plugin-blob-storage/value.json',
            pluginWipeDone: false,
            dumpPluginStorageRescue: async () => { throw new Error('disk full') },
            kvDelPrefix: (prefix) => deleted.push(prefix),
        })).rejects.toThrow('disk full')

        expect(deleted).toEqual([])
    })
})
