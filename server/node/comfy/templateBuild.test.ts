// @vitest-environment node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  findDanglingReferences,
  transformWan22Flf2vLoopWorkflow,
  transformWanWorkflow,
} from './buildWanTemplate.mjs'

const fixtureUrl = new URL('./fixtures/Wan_workflow_api.json', import.meta.url)
const templateUrl = new URL('./templates/wan-i2v.json', import.meta.url)
const flf2vFixtureUrl = new URL('./fixtures/Wan_workflow_flf2v.json', import.meta.url)
const flf2vTemplateUrl = new URL('./templates/wan22-flf2v-loop.json', import.meta.url)

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex').toUpperCase()
}

function withoutSlotLeaves(workflow: Record<string, any>) {
  const retained = structuredClone(workflow)
  delete retained['6'].inputs.text
  delete retained['52'].inputs.image
  delete retained['335'].inputs.seed
  return retained
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

    const templateBytes = await readFile(fileURLToPath(templateUrl))
    expect(sha256(templateBytes)).toBe('E483AA30B02FA88842CF2FA036C3CA2B848474AEF5BF7632E5FEFE4C214E374D')
    expect(JSON.parse(templateBytes.toString('utf8'))).toEqual(transformed)
  })

  it('builds the pinned FLF2V loop template without changing the proven tuning', async () => {
    const sourceBytes = await readFile(fileURLToPath(flf2vFixtureUrl))
    expect(sha256(sourceBytes)).toBe('D90DC91F7380E80D1C01D3202A58C47FC9CDAF74CDFEED443FC6848641B20AED')

    const source = JSON.parse(sourceBytes.toString('utf8'))
    expect(source['386']).toBeUndefined()

    const transformed = transformWan22Flf2vLoopWorkflow(source)
    const retainedSource = structuredClone(source)
    for (const nodeId of ['355', '385', '387', '388', '419']) {
      delete retainedSource[nodeId]
      expect(transformed[nodeId]).toBeUndefined()
    }

    expect(withoutSlotLeaves(transformed)).toEqual(withoutSlotLeaves(retainedSource))
    expect(transformed['6'].inputs.text).toBe('{{positive}}')
    expect(transformed['52'].inputs.image).toBe('{{input_image}}')
    expect(transformed['335'].inputs.seed).toBe('{{seed}}')
    expect(Object.keys(transformed)).toHaveLength(32)
    expect(findDanglingReferences(transformed)).toEqual([])

    expect(transformed['396'].inputs).toMatchObject({
      length: 81,
      motion_amplitude: 1.1,
      clip_vision_start_image: ['374', 0],
      clip_vision_end_image: ['374', 0],
      start_image: ['382', 0],
      end_image: ['382', 0],
    })
    expect(transformed['400']).toMatchObject({
      class_type: 'ImageFromBatch',
      inputs: { batch_index: 0, length: 80, image: ['8', 0] },
    })
    expect(transformed['325']).toMatchObject({
      class_type: 'ImageUpscaleWithModel',
      inputs: { upscale_model: ['326', 0], image: ['320', 0] },
    })
    expect(transformed['63']).toMatchObject({
      class_type: 'VHS_VideoCombine',
      inputs: { images: ['408', 0] },
    })

    const output = `${JSON.stringify(transformed, null, 2)}\n`
    expect(sha256(output)).toBe('670EE9EEE68033A4F03C154A862ADF26CADDF9AA911016C3F71A04903B0AC8CB')

    const templateBytes = await readFile(fileURLToPath(flf2vTemplateUrl))
    expect(sha256(templateBytes)).toBe('670EE9EEE68033A4F03C154A862ADF26CADDF9AA911016C3F71A04903B0AC8CB')
    expect(JSON.parse(templateBytes.toString('utf8'))).toEqual(transformed)
  })
})
