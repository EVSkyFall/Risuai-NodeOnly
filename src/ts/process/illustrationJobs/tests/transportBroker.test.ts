import { describe, expect, test } from 'vitest'
import { ProviderConcurrencyBroker, type BrokerQueuePolicy } from '../transportBroker'

const interactiveFirst: BrokerQueuePolicy = { maxConcurrency: 1, priorityPolicy: 'interactive-first' }

function flush(): Promise<void> {
    // Drain the microtask queue so already-resolvable acquire() promises settle.
    return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('provider-wide concurrency broker (request §8)', () => {
    test('honors maxConcurrency and admits waiters as slots free', async () => {
        const broker = new ProviderConcurrencyBroker()
        const policy: BrokerQueuePolicy = { maxConcurrency: 2, priorityPolicy: 'fifo' }
        const r1 = await broker.acquire('k', policy, 'background')
        const r2 = await broker.acquire('k', policy, 'background')
        expect(broker.activeCount('k')).toBe(2)

        let thirdAdmitted = false
        const third = broker.acquire('k', policy, 'background').then((rel) => {
            thirdAdmitted = true
            return rel
        })
        await flush()
        expect(thirdAdmitted).toBe(false)
        expect(broker.waitingCount('k')).toBe(1)

        r1()
        const r3 = await third
        expect(thirdAdmitted).toBe(true)
        r2()
        r3()
        expect(broker.activeCount('k')).toBe(0)
    })

    test('distinct concurrency keys never serialize against each other', async () => {
        const broker = new ProviderConcurrencyBroker()
        const policy: BrokerQueuePolicy = { maxConcurrency: 1, priorityPolicy: 'fifo' }
        const a = await broker.acquire('key-a', policy, 'background')
        // A different key is immediately admitted despite key-a being saturated.
        const b = await broker.acquire('key-b', policy, 'background')
        expect(broker.activeCount('key-a')).toBe(1)
        expect(broker.activeCount('key-b')).toBe(1)
        a()
        b()
    })

    test('15 background jobs never starve an interactive request (interactive-first)', async () => {
        const broker = new ProviderConcurrencyBroker()
        // Saturate the single slot with one running background job...
        const running = await broker.acquire('nai', interactiveFirst, 'background')
        const order: string[] = []
        // ...then queue 15 background jobs...
        const backgrounds = Array.from({ length: 15 }, (_, i) =>
            broker.acquire('nai', interactiveFirst, 'background').then((rel) => {
                order.push(`bg-${i}`)
                rel()
            }))
        await flush()
        // ...and finally an interactive request arrives LAST.
        const interactive = broker.acquire('nai', interactiveFirst, 'interactive').then((rel) => {
            order.push('interactive')
            rel()
        })
        await flush()
        expect(broker.waitingCount('nai')).toBe(16)

        // Release the running job; the queue drains one at a time.
        running()
        await interactive
        await Promise.all(backgrounds)

        // The interactive request was served BEFORE any of the 15 queued background
        // jobs, even though it arrived last.
        expect(order[0]).toBe('interactive')
        expect(order.slice(1).sort()).toEqual(
            Array.from({ length: 15 }, (_, i) => `bg-${i}`).sort(),
        )
    })

    test('fifo policy preserves arrival order regardless of priority', async () => {
        const broker = new ProviderConcurrencyBroker()
        const policy: BrokerQueuePolicy = { maxConcurrency: 1, priorityPolicy: 'fifo' }
        const running = await broker.acquire('k', policy, 'background')
        const order: string[] = []
        const first = broker.acquire('k', policy, 'background').then((rel) => { order.push('first'); rel() })
        await flush()
        const second = broker.acquire('k', policy, 'interactive').then((rel) => { order.push('second'); rel() })
        await flush()
        running()
        await Promise.all([first, second])
        expect(order).toEqual(['first', 'second'])
    })

    test('the current policy for a key wins (queue tuning is mutable, request §4)', async () => {
        const broker = new ProviderConcurrencyBroker()
        const r1 = await broker.acquire('k', { maxConcurrency: 1, priorityPolicy: 'fifo' }, 'background')
        // A later acquire raises maxConcurrency for the key -> immediately admitted.
        const r2 = await broker.acquire('k', { maxConcurrency: 2, priorityPolicy: 'fifo' }, 'background')
        expect(broker.activeCount('k')).toBe(2)
        r1()
        r2()
    })

    test('raising maxConcurrency immediately pumps already-queued waiters in priority order', async () => {
        const broker = new ProviderConcurrencyBroker()
        // A background holder saturates the single slot.
        const running = await broker.acquire('webui', interactiveFirst, 'background')
        const order: string[] = []
        // Two interactive requests queue behind it (arrived earlier than the raise).
        const w1 = broker.acquire('webui', interactiveFirst, 'interactive').then((rel) => { order.push('w1'); return rel })
        const w2 = broker.acquire('webui', interactiveFirst, 'interactive').then((rel) => { order.push('w2'); return rel })
        await flush()
        expect(broker.activeCount('webui')).toBe(1)
        expect(broker.waitingCount('webui')).toBe(2)

        // A LATER background request raises maxConcurrency 1 -> 3. The raise must hand
        // the two freed slots to the earlier interactive waiters, and queue this new
        // background caller behind them (no capacity underuse, no priority inversion).
        const raised: BrokerQueuePolicy = { maxConcurrency: 3, priorityPolicy: 'interactive-first' }
        const c = broker.acquire('webui', raised, 'background').then((rel) => { order.push('c'); return rel })
        await flush()

        const relW1 = await w1
        const relW2 = await w2
        // Both earlier interactive waiters were admitted by the raise; C is still queued.
        expect(order).toEqual(['w1', 'w2'])
        expect(broker.activeCount('webui')).toBe(3)
        expect(broker.waitingCount('webui')).toBe(1)

        // Freeing one slot now admits the queued background C.
        relW1()
        const relC = await c
        expect(order).toEqual(['w1', 'w2', 'c'])

        relW2()
        relC()
        running()
        expect(broker.activeCount('webui')).toBe(0)
    })

    test('a double release is idempotent and never over-frees a slot', async () => {
        const broker = new ProviderConcurrencyBroker()
        const policy: BrokerQueuePolicy = { maxConcurrency: 1, priorityPolicy: 'fifo' }
        const rel = await broker.acquire('k', policy, 'background')
        rel()
        rel()
        expect(broker.activeCount('k')).toBe(0)
        // A fresh acquire after the double release still works and is single-slot.
        const rel2 = await broker.acquire('k', policy, 'background')
        expect(broker.activeCount('k')).toBe(1)
        rel2()
    })
})
