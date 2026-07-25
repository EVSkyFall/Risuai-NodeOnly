import { beforeEach, describe, expect, it } from 'vitest'

import {
    recordDirectFetchFailure,
    recordDirectFetchSuccess,
    resetDirectFetchPolicyForTests,
    shouldSkipDirectFetch,
} from './directFetchPolicy'

const NOW = 1_000_000
const TTL_MS = 5 * 60_000

beforeEach(() => {
    resetDirectFetchPolicyForTests()
})

describe('directFetchPolicy', () => {
    it('skips only the origin with a recorded failure', () => {
        recordDirectFetchFailure('https://failed.example/history', NOW)

        expect(shouldSkipDirectFetch('https://failed.example/history', NOW)).toBe(true)
        expect(shouldSkipDirectFetch('https://other.example/history', NOW)).toBe(false)
    })

    it('shares a failure across paths on the same origin', () => {
        recordDirectFetchFailure('https://failed.example/history', NOW)

        expect(shouldSkipDirectFetch('https://failed.example/view?id=1', NOW)).toBe(true)
    })

    it('expires and drops a failure at the TTL boundary', () => {
        recordDirectFetchFailure('https://failed.example/history', NOW)

        expect(shouldSkipDirectFetch('https://failed.example/history', NOW + TTL_MS - 1)).toBe(true)
        expect(shouldSkipDirectFetch('https://failed.example/history', NOW + TTL_MS)).toBe(false)
        expect(shouldSkipDirectFetch('https://failed.example/history', NOW)).toBe(false)
    })

    it('clears a recorded failure after a success', () => {
        const url = 'https://recovered.example/history'
        recordDirectFetchFailure(url, NOW)

        recordDirectFetchSuccess(url)

        expect(shouldSkipDirectFetch(url, NOW)).toBe(false)
    })

    it('ignores unparseable URLs without throwing', () => {
        expect(() => recordDirectFetchFailure('not a url', NOW)).not.toThrow()
        expect(() => recordDirectFetchSuccess('not a url')).not.toThrow()
        expect(shouldSkipDirectFetch('not a url', NOW)).toBe(false)
    })

    it('never records or skips same-origin URLs', () => {
        const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'https://app.example' },
        })

        try {
            const url = 'https://app.example/history'
            recordDirectFetchFailure(url, NOW)

            expect(shouldSkipDirectFetch(url, NOW)).toBe(false)
        }
        finally {
            if (originalLocation) {
                Object.defineProperty(globalThis, 'location', originalLocation)
            }
            else {
                Reflect.deleteProperty(globalThis, 'location')
            }
        }
    })

    it('evicts the oldest failure when the map reaches its bound', () => {
        for (let index = 0; index < 65; index++) {
            recordDirectFetchFailure(`https://origin-${index}.example/history`, NOW + index)
        }

        expect(shouldSkipDirectFetch('https://origin-0.example/view', NOW + 65)).toBe(false)
        expect(shouldSkipDirectFetch('https://origin-1.example/view', NOW + 65)).toBe(true)
        expect(shouldSkipDirectFetch('https://origin-64.example/view', NOW + 65)).toBe(true)
    })
})
