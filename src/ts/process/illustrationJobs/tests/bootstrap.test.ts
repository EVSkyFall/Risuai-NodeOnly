import { describe, expect, test, vi } from 'vitest'

vi.mock('../featureFlag', () => ({
    isIllustrationFeatureEnabled: vi.fn(async () => false),
}))

const { bootstrapIllustrationJobs } = await import('../bootstrap')

describe('illustration bootstrap', () => {
    test('does not load recovery or executor while the feature is OFF', async () => {
        const loadRecovery = vi.fn()
        const loadExecutor = vi.fn()

        await bootstrapIllustrationJobs({
            isFeatureEnabled: vi.fn(async () => false),
            loadRecovery,
            loadExecutor,
        })

        expect(loadRecovery).not.toHaveBeenCalled()
        expect(loadExecutor).not.toHaveBeenCalled()
    })

    test('waits for recovery to finish before loading and starting the executor', async () => {
        const order: string[] = []
        let finishRecovery!: () => void
        const recoveryFinished = new Promise<void>((resolve) => {
            finishRecovery = resolve
        })
        const startIllustrationExecutor = vi.fn(async () => {
            order.push('executor:start')
        })
        const loadExecutor = vi.fn(async () => {
            order.push('executor:load')
            return { startIllustrationExecutor }
        })

        const boot = bootstrapIllustrationJobs({
            isFeatureEnabled: vi.fn(async () => {
                order.push('flag')
                return true
            }),
            loadRecovery: vi.fn(async () => {
                order.push('recovery:load')
                return {
                    runIllustrationRecovery: async () => {
                        order.push('recovery:start')
                        await recoveryFinished
                        order.push('recovery:end')
                        return { turnsExamined: 0, jobsExamined: 0 }
                    },
                }
            }),
            loadExecutor,
        })

        await vi.waitFor(() => expect(order).toEqual([
            'flag',
            'recovery:load',
            'recovery:start',
        ]))
        expect(loadExecutor).not.toHaveBeenCalled()

        finishRecovery()
        await boot

        expect(order).toEqual([
            'flag',
            'recovery:load',
            'recovery:start',
            'recovery:end',
            'executor:load',
            'executor:start',
        ])
        expect(startIllustrationExecutor).toHaveBeenCalledTimes(1)
    })
})
