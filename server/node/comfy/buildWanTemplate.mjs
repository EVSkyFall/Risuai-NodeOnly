import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_HASH = '0AA037ADC613F62048A08A27197C7DE289C88B6BC8FE098C6A4911EE3336E599'
const OUTPUT_HASH = 'E483AA30B02FA88842CF2FA036C3CA2B848474AEF5BF7632E5FEFE4C214E374D'

export function transformWanWorkflow(source) {
  const workflow = structuredClone(source)

  for (const nodeId of ['355', '385', '386', '387', '388']) {
    delete workflow[nodeId]
  }

  workflow['6'].inputs.text = '{{positive}}'
  workflow['52'].inputs.image = '{{input_image}}'
  workflow['335'].inputs.seed = '{{seed}}'
  return workflow
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase()
}

export async function buildWanWorkflow(options = {}) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const sourcePath = options.sourcePath
    ?? path.join(scriptDir, 'fixtures', 'Wan_workflow_api.json')
  const outputPath = options.outputPath
    ?? path.join(scriptDir, 'templates', 'wan-i2v.json')

  const sourceBytes = await readFile(sourcePath)
  if (sha256(sourceBytes) !== SOURCE_HASH) {
    throw new Error('WAN workflow fixture hash does not match the reviewed source')
  }

  const workflow = transformWanWorkflow(JSON.parse(sourceBytes.toString('utf8')))
  const output = `${JSON.stringify(workflow, null, 2)}\n`
  if (sha256(output) !== OUTPUT_HASH) {
    throw new Error('WAN runtime template hash does not match the reviewed transform')
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, output, 'utf8')
  return { outputPath, sha256: OUTPUT_HASH }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildWanWorkflow()
  console.log(`${result.outputPath} ${result.sha256}`)
}
