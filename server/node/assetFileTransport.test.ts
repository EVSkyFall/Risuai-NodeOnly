import { describe, expect, it } from 'vitest'
import { EventEmitter, once } from 'node:events'
import { Writable } from 'node:stream'
import transport from './assetFileTransport.cjs'

describe('asset transport backpressure', () => {
    it('accepts writes without waiting for an optional write callback', async () => {
        const destination = Object.assign(new EventEmitter(), { destroyed: false, write: () => true })
        await transport.writeChunk(destination, Buffer.from('bytes'))
        expect(destination.eventNames()).toEqual([])
    })

    it('waits for drain and removes listeners from the emitter a response wrapper actually uses', async () => {
        const compressed = new EventEmitter()
        const destination = Object.assign(new EventEmitter(), { destroyed: false, write: () => false })
        const on = destination.on
        destination.on = function (event, listener) {
            return event === 'drain' ? compressed.on(event, listener) : on.call(this, event, listener)
        }
        for (let i = 0; i < 24; i++) {
            let settled = false
            const writing = transport.writeChunk(destination, Buffer.from('chunk')).then(() => { settled = true })
            await Promise.resolve()
            expect(settled).toBe(false)
            expect(compressed.listenerCount('drain')).toBe(1)
            compressed.emit('drain')
            await writing
            expect(compressed.eventNames()).toEqual([])
            expect(destination.eventNames()).toEqual([])
        }
    })

    it.each(['close', 'error', 'throw', 'destroyed'])('rejects %s without leaving listeners behind', async reason => {
        const destination = Object.assign(new EventEmitter(), {
            destroyed: reason === 'destroyed',
            write: () => { if (reason === 'throw') throw new Error('write failed'); return false },
        })
        const writing = transport.writeChunk(destination, Buffer.from('bytes'))
        const assertion = expect(writing).rejects.toThrow(reason === 'error' || reason === 'throw' ? 'write failed' : 'Stream destination closed')
        if (reason === 'close') destination.emit('close')
        if (reason === 'error') destination.emit('error', new Error('write failed'))
        await assertion
        expect(destination.eventNames()).toEqual([])
    })

    it('preserves byte ordering through a real Writable with backpressure', async () => {
        const chunks: Buffer[] = []
        const destination = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
            setImmediate(() => { chunks.push(Buffer.from(chunk)); callback() })
        } })
        for (let i = 0; i < 24; i++) await transport.writeChunk(destination, Buffer.alloc(1024, i))
        const finished = once(destination, 'finish')
        destination.end()
        await finished
        expect(Buffer.concat(chunks)).toEqual(Buffer.concat(Array.from({ length: 24 }, (_, i) => Buffer.alloc(1024, i))))
    })
})
