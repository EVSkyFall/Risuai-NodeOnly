// @vitest-environment node

import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnServer, type ServerHandle } from '../../test/compat/helpers/spawnServer.js'
import { createClient } from '../../test/compat/helpers/client.js'

const coreServers: ServerHandle[] = []
const upstreamServers: Server[] = []

afterEach(async () => {
  await Promise.all(coreServers.splice(0).map(server => server.cleanup()))
  await Promise.all(upstreamServers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function within<T>(promise: Promise<T>, timeoutMs = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('GET proxy downstream cancellation', { timeout: 30_000 }, () => {
  it('aborts a header-stalled upstream fetch when the authenticated client disconnects', async () => {
    const upstreamReceived = deferred()
    const upstreamClosed = deferred()
    const upstream = createServer((req, res) => {
      if (req.url === '/stall') {
        upstreamReceived.resolve()
        res.once('close', upstreamClosed.resolve)
        return
      }
      res.statusCode = 200
      res.end('still alive')
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    upstreamServers.push(upstream)
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('upstream did not bind')
    const upstreamUrl = `http://127.0.0.1:${address.port}`

    const core = await spawnServer({
      env: {
        RISU_TUNNEL_DISABLED: 'true',
        RISU_UPDATE_CHECK: 'false',
      },
    })
    coreServers.push(core)
    const client = await createClient(core.port, core.password)

    const controller = new AbortController()
    const stalledRequest = client.fetch('/proxy2', {
      method: 'GET',
      headers: {
        'risu-url': encodeURIComponent(`${upstreamUrl}/stall`),
        'risu-header': encodeURIComponent(JSON.stringify({})),
      },
      signal: controller.signal,
    })
    void stalledRequest.catch(() => {})

    await within(upstreamReceived.promise)
    controller.abort()

    await expect(stalledRequest).rejects.toMatchObject({ name: 'AbortError' })
    await within(upstreamClosed.promise)

    const normal = await client.fetch('/proxy2', {
      method: 'GET',
      headers: {
        'risu-url': encodeURIComponent(`${upstreamUrl}/ok`),
        'risu-header': encodeURIComponent(JSON.stringify({})),
      },
    })
    expect(normal.status).toBe(200)
    await expect(normal.text()).resolves.toBe('still alive')
  })
})
