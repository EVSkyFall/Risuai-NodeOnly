// @vitest-environment node

import ts from 'typescript'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Comfy capability declaration compatibility', () => {
  it('keeps numeric legacy capabilities while exposing structured readiness', async () => {
    const declaration = await readFile(
      path.resolve('src/ts/plugins/apiV3/risuai.d.ts'),
      'utf8',
    )
    const match = declaration.match(/getCapabilities\(\): Promise<([^\r\n]+)>;/)
    expect(match?.[1]).toBe(
      'Record<string, number> & { pluginPrimitiveSuiteV1?: { epoch: number; ready: boolean } }',
    )

    const filename = 'consumer.ts'
    const source = `
      type PropertyKey = string | number | symbol
      type Record<K extends PropertyKey, V> = { [P in K]: V }
      interface Promise<T> {}
      type Unwrap<T> = T extends Promise<infer U> ? U : never
      type ReturnType<T> = T extends (...args: never[]) => infer R ? R : never
      declare function getCapabilities(): Promise<${match?.[1]}>
      type Capabilities = Unwrap<ReturnType<typeof getCapabilities>>
      declare const caps: Capabilities
      const legacy: boolean = caps.pluginAtomicV1 >= 1
      const ready: boolean | undefined = caps.pluginPrimitiveSuiteV1?.ready
      void legacy
      void ready
    `
    const options = { noEmit: true, noLib: true, strict: true, types: [] as string[] }
    const host = ts.createCompilerHost(options)
    host.getSourceFile = requested => (
      requested === filename
        ? ts.createSourceFile(filename, source, ts.ScriptTarget.ESNext, true)
        : undefined
    )
    host.fileExists = requested => requested === filename
    host.readFile = requested => requested === filename ? source : undefined
    const program = ts.createProgram([filename], {
      ...options,
      target: ts.ScriptTarget.ESNext,
    }, host)
    const diagnostics = ts.getPreEmitDiagnostics(program)
      .filter(diagnostic => diagnostic.code !== 2318)
      .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    expect(diagnostics).toEqual([])
  })
})
