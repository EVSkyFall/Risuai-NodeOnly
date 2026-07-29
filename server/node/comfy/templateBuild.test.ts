// @vitest-environment node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { transformWanWorkflow } from './buildWanTemplate.mjs'

const fixtureUrl = new URL('./fixtures/Wan_workflow_api.json', import.meta.url)

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex').toUpperCase()
}

describe('WAN I2V template build', () => {
  it('builds the pinned runtime template without changing the retained workflow', async () => {
    const sourceBytes = await readFile(fileURLToPath(fixtureUrl))
    expect(sha256(sourceBytes)).toBe('0AA037ADC613F62048A08A27197C7DE289C88B6BC8FE098C6A4911EE3336E599')

    const source = JSON.parse(sourceBytes.toString('utf8'))
    const transformed = transformWanWorkflow(source)
    const expected = structuredClone(source)

    for (const nodeId of ['355', '385', '386', '387', '388']) {
      delete expected[nodeId]
    }
    expected['6'].inputs.text = '{{positive}}'
    expected['52'].inputs.image = '{{input_image}}'
    expected['335'].inputs.seed = '{{seed}}'

    expect(transformed).toEqual(expected)
    expect(Object.keys(transformed)).toHaveLength(30)

    const output = `${JSON.stringify(transformed, null, 2)}\n`
    expect(sha256(output)).toBe('E483AA30B02FA88842CF2FA036C3CA2B848474AEF5BF7632E5FEFE4C214E374D')
  })
})
