import type { IllustrationLockManager } from '../locks'

export class InMemoryLockManager implements IllustrationLockManager {
    private readonly tails = new Map<string, Promise<void>>()

    async request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
        const previous = this.tails.get(name) ?? Promise.resolve()
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const tail = previous.catch(() => undefined).then(async () => await gate)
        this.tails.set(name, tail)

        await previous.catch(() => undefined)
        try {
            return await callback()
        } finally {
            release()
            if (this.tails.get(name) === tail) this.tails.delete(name)
        }
    }
}
