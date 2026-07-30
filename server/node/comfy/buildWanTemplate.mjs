import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const WAN_I2V_SPEC = Object.freeze({
  id: 'wan-i2v',
  sourcePath: path.join(scriptDir, 'fixtures', 'Wan_workflow_api.json'),
  sourceHash: '0AA037ADC613F62048A08A27197C7DE289C88B6BC8FE098C6A4911EE3336E599',
  deleteNodeIds: Object.freeze(['355', '385', '386', '387', '388']),
  outputPath: path.join(scriptDir, 'templates', 'wan-i2v.json'),
  outputHash: 'E483AA30B02FA88842CF2FA036C3CA2B848474AEF5BF7632E5FEFE4C214E374D',
})
const WAN22_FLF2V_LOOP_SPEC = Object.freeze({
  id: 'wan22-flf2v-loop',
  sourcePath: path.join(scriptDir, 'fixtures', 'Wan_workflow_flf2v.json'),
  sourceHash: 'D90DC91F7380E80D1C01D3202A58C47FC9CDAF74CDFEED443FC6848641B20AED',
  deleteNodeIds: Object.freeze(['355', '385', '387', '388', '419']),
  outputPath: path.join(scriptDir, 'templates', 'wan22-flf2v-loop.json'),
  outputHash: '670EE9EEE68033A4F03C154A862ADF26CADDF9AA911016C3F71A04903B0AC8CB',
})

export function findDanglingReferences(workflow) {
  const dangling = []

  function scan(value, inputPath) {
    if (Array.isArray(value)) {
      if (
        value.length === 2
        && typeof value[0] === 'string'
        && Number.isInteger(value[1])
      ) {
        if (!Object.hasOwn(workflow, value[0])) {
          dangling.push({ inputPath, targetNodeId: value[0] })
        }
        return
      }
      value.forEach((child, index) => scan(child, `${inputPath}.${index}`))
      return
    }

    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        scan(child, `${inputPath}.${key}`)
      }
    }
  }

  for (const [nodeId, node] of Object.entries(workflow)) {
    scan(node.inputs, `${nodeId}.inputs`)
  }
  return dangling
}

export function transformWorkflow(source, deleteNodeIds) {
  const workflow = structuredClone(source)

  for (const nodeId of deleteNodeIds) {
    delete workflow[nodeId]
  }

  workflow['6'].inputs.text = '{{positive}}'
  workflow['52'].inputs.image = '{{input_image}}'
  workflow['335'].inputs.seed = '{{seed}}'

  const dangling = findDanglingReferences(workflow)
  if (dangling.length > 0) {
    throw new Error(`Workflow contains dangling node references: ${JSON.stringify(dangling)}`)
  }
  return workflow
}

export function transformWanWorkflow(source) {
  return transformWorkflow(source, WAN_I2V_SPEC.deleteNodeIds)
}

export function transformWan22Flf2vLoopWorkflow(source) {
  return transformWorkflow(source, WAN22_FLF2V_LOOP_SPEC.deleteNodeIds)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase()
}

export async function buildWorkflow(spec, options = {}) {
  const sourcePath = options.sourcePath ?? spec.sourcePath
  const outputPath = options.outputPath ?? spec.outputPath

  const sourceBytes = await readFile(sourcePath)
  if (sha256(sourceBytes) !== spec.sourceHash) {
    throw new Error(`${spec.id} workflow fixture hash does not match the reviewed source`)
  }

  const workflow = transformWorkflow(
    JSON.parse(sourceBytes.toString('utf8')),
    spec.deleteNodeIds,
  )
  const output = `${JSON.stringify(workflow, null, 2)}\n`
  if (sha256(output) !== spec.outputHash) {
    throw new Error(`${spec.id} runtime template hash does not match the reviewed transform`)
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, output, 'utf8')
  return { outputPath, sha256: spec.outputHash }
}

export function buildWanWorkflow(options = {}) {
  return buildWorkflow(WAN_I2V_SPEC, options)
}

export function buildWan22Flf2vLoopWorkflow(options = {}) {
  return buildWorkflow(WAN22_FLF2V_LOOP_SPEC, options)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await Promise.all([
    buildWanWorkflow(),
    buildWan22Flf2vLoopWorkflow(),
  ])
  for (const result of results) {
    console.log(`${result.outputPath} ${result.sha256}`)
  }
}
