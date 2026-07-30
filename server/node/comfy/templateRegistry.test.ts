// @vitest-environment node

import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import pkg from './templateRegistry.cjs'

const { createTemplateRegistry } = pkg as {
  createTemplateRegistry: (options: { templateDir: string }) => {
    listTemplates: () => Promise<Array<{ id: string; hash: string }>>
    instantiate: (
      templateId: string,
      slots: { positive: string; input_image: string; seed: number },
    ) => Promise<{ prompt: Record<string, any>; templateHash: string; outputNodeId: string; outputKey: string }>
    loadTemplate: (templateId: string) => Promise<any>
  }
}

const templateDir = fileURLToPath(new URL('./templates/', import.meta.url))
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })))
})

describe('Comfy template registry', () => {
  it('lists and instantiates the reviewed WAN template from pristine bytes', async () => {
    const registry = createTemplateRegistry({ templateDir })

    await expect(registry.listTemplates()).resolves.toEqual([
      {
        id: 'wan-i2v',
        hash: 'E483AA30B02FA88842CF2FA036C3CA2B848474AEF5BF7632E5FEFE4C214E374D',
        slots: [
          { name: 'input_image', type: 'imageAsset', required: true },
          { name: 'positive', type: 'string', required: true },
          {
            name: 'seed',
            type: 'integer',
            required: true,
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        ],
      },
      {
        id: 'wan22-flf2v-loop',
        hash: '670EE9EEE68033A4F03C154A862ADF26CADDF9AA911016C3F71A04903B0AC8CB',
        slots: [
          { name: 'input_image', type: 'imageAsset', required: true },
          { name: 'positive', type: 'string', required: true },
          {
            name: 'seed',
            type: 'integer',
            required: true,
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        ],
      },
    ])

    const literal = '"quoted"\n유니코드\\path {{seed}} remains data'
    const result = await registry.instantiate('wan-i2v', {
      positive: literal,
      input_image: 'risu-comfy/input.png',
      seed: 42,
    })

    expect(result.templateHash).toBe('E483AA30B02FA88842CF2FA036C3CA2B848474AEF5BF7632E5FEFE4C214E374D')
    expect(result.prompt['6'].inputs.text).toBe(literal)
    expect(result.prompt['52'].inputs.image).toBe('risu-comfy/input.png')
    expect(result.prompt['335'].inputs.seed).toBe(42)
    expect(result.outputNodeId).toBe('63')
    expect(result.outputKey).toBe('gifs')

    const pristine = await registry.instantiate('wan-i2v', {
      positive: 'second',
      input_image: path.posix.join('risu-comfy', 'other.png'),
      seed: 7,
    })
    expect(pristine.prompt['6'].inputs.text).toBe('second')
    expect(pristine.prompt['335'].inputs.seed).toBe(7)

    const loop = await registry.instantiate('wan22-flf2v-loop', {
      positive: 'loop',
      input_image: 'risu-comfy/keyframe.png',
      seed: 81,
    })
    expect(loop.templateHash).toBe('670EE9EEE68033A4F03C154A862ADF26CADDF9AA911016C3F71A04903B0AC8CB')
    expect(loop.prompt['6'].inputs.text).toBe('loop')
    expect(loop.prompt['52'].inputs.image).toBe('risu-comfy/keyframe.png')
    expect(loop.prompt['335'].inputs.seed).toBe(81)
    expect(loop.prompt['396'].inputs.start_image).toEqual(['382', 0])
    expect(loop.prompt['396'].inputs.end_image).toEqual(['382', 0])
    expect(loop.outputNodeId).toBe('63')
    expect(loop.outputKey).toBe('gifs')
  })

  it('rejects missing, unknown, fractional, negative, and unsafe seed slots', async () => {
    const registry = createTemplateRegistry({ templateDir })
    const valid = { positive: 'x', input_image: 'input.png', seed: 1 }
    for (const seed of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(registry.instantiate('wan-i2v', { ...valid, seed })).rejects.toMatchObject({
        code: 'COMFY_SLOT_INVALID',
      })
    }
    await expect(registry.instantiate('wan-i2v', {
      positive: 'x',
      input_image: 'input.png',
    } as any)).rejects.toMatchObject({ code: 'COMFY_SLOT_MISSING' })
    await expect(registry.instantiate('wan-i2v', {
      ...valid,
      typo: 'silent',
    } as any)).rejects.toMatchObject({ code: 'COMFY_SLOT_UNKNOWN' })
  })

  it('rejects partial placeholders and symlinked template roots', async () => {
    const realDir = await mkdtemp(path.join(tmpdir(), 'comfy-template-real-'))
    const linkedDir = `${realDir}-link`
    tempDirs.push(realDir, linkedDir)
    const source = JSON.parse(await readFile(path.join(templateDir, 'wan-i2v.json'), 'utf8'))
    source['6'].inputs.text = 'prefix {{positive}}'
    await writeFile(path.join(realDir, 'unsafe.json'), JSON.stringify(source))

    const registry = createTemplateRegistry({ templateDir: realDir })
    await expect(registry.loadTemplate('unsafe')).rejects.toMatchObject({
      code: 'COMFY_TEMPLATE_PLACEHOLDER_INVALID',
    })

    await symlink(realDir, linkedDir, 'junction')
    await expect(createTemplateRegistry({ templateDir: linkedDir }).listTemplates()).rejects.toMatchObject({
      code: 'COMFY_TEMPLATE_DIR_INVALID',
    })
    await expect(createTemplateRegistry({ templateDir }).instantiate('../wan-i2v', {
      positive: 'x',
      input_image: 'x.png',
      seed: 1,
    })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_ID_INVALID' })
  })

  it('discovers a unique VHS output by class type and rejects duplicate outputs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-template-hardening-'))
    tempDirs.push(root)
    const source = JSON.parse(await readFile(path.join(templateDir, 'wan-i2v.json'), 'utf8'))
    source['64'] = source['63']
    delete source['63']
    await writeFile(path.join(root, 'shifted.json'), JSON.stringify(source))
    await expect(createTemplateRegistry({ templateDir: root }).instantiate('shifted', {
      positive: 'shifted',
      input_image: 'input.png',
      seed: 1,
    })).resolves.toMatchObject({ outputNodeId: '64', outputKey: 'gifs' })

    source['63'] = structuredClone(source['64'])
    await writeFile(path.join(root, 'duplicate.json'), JSON.stringify(source))
    await expect(createTemplateRegistry({ templateDir: root }).loadTemplate('duplicate')).rejects.toMatchObject({
      code: 'COMFY_TEMPLATE_OUTPUT_INVALID',
    })

    const canonicalPath = path.join(templateDir, 'wan-i2v.json')
    const canonicalBytes = await readFile(canonicalPath)
    const canonicalStat = await stat(canonicalPath)
    const realOpen = fs.promises.open.bind(fs.promises)
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (target: any, flags: any) => {
      if (path.resolve(String(target)) !== path.resolve(canonicalPath)) {
        return await realOpen(target, flags)
      }
      return {
        async stat() {
          return canonicalStat
        },
        async readFile() {
          return Buffer.concat([canonicalBytes, Buffer.from(' ')])
        },
        async close() {},
      } as any
    })
    try {
      await expect(createTemplateRegistry({ templateDir }).loadTemplate('wan-i2v')).rejects.toMatchObject({
        code: 'COMFY_TEMPLATE_CHANGED',
      })
    } finally {
      openSpy.mockRestore()
    }
  })

  it('isolates invalid templates in listings and includes their id in compile failures', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-template-list-'))
    tempDirs.push(root)
    const source = JSON.parse(await readFile(path.join(templateDir, 'wan-i2v.json'), 'utf8'))
    await writeFile(path.join(root, 'valid.json'), JSON.stringify(source))
    source['6'].inputs.text = 'prefix {{positive}}'
    await writeFile(path.join(root, 'broken.json'), JSON.stringify(source))
    const registry = createTemplateRegistry({ templateDir: root })

    await expect(registry.listTemplates()).resolves.toEqual([
      {
        id: 'broken',
        error: {
          code: 'COMFY_TEMPLATE_PLACEHOLDER_INVALID',
          message: expect.stringContaining('broken'),
        },
      },
      {
        id: 'valid',
        hash: expect.any(String),
        slots: expect.any(Array),
      },
    ])
    await expect(registry.loadTemplate('broken')).rejects.toMatchObject({
      code: 'COMFY_TEMPLATE_PLACEHOLDER_INVALID',
      message: expect.stringContaining('broken'),
    })
  })
})
