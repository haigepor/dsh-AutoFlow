/** Owner-local expected output freezes model-visible prompts and portable user exports. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { analysisInstructions, generationInstructions } from '../src/shared/prompts.ts'
import { compileQuick, exportBundle } from '../src/shared/compose.ts'
import { referenceSchema } from '../src/shared/model.ts'
import { observation, newInput, pixels } from './fixture.ts'
import { en, zh } from '../src/client/locale.ts'
import { readPluginMeta } from '@deepseek-ai/dsh-app-boot'

test('prompts and bilingual exports match the keyless expected output', async () => {
  const input = newInput(), result = compileQuick(observation, input)
  const references = [referenceSchema.parse({ id: 'ref-1', name: 'reference.png', sha256: createHash('sha256').update(pixels).digest('hex'), attachment: { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: pixels.length, width: 1, height: 1 } })]
  const importKeys = ['workbench', 'referenceTab', 'promptTab', 'analysisSettings', 'modelSelected', 'analysisEmpty', 'dimensions', 'dimensionsHint', 'analyze', 'englishDescription', 'medium', 'rendering', 'shape', 'color', 'lighting', 'texture', 'detail', 'depth', 'composition', 'importArea', 'uploadTitle', 'uploadDescription', 'dropReady', 'uploadFormats', 'uploadLimits', 'uploadHint', 'importError.no-files', 'importError.unsupported', 'importError.empty-file', 'importError.count', 'importError.file-size', 'importError.batch-size'] as const
  const display = readPluginMeta('dsh-plugin-style-prompt', import.meta.url)
  const actual = { analysisInstructions, generationInstructions, installedPlugin: { title: display?.title, description: display?.description }, imageImport: Object.fromEntries(importKeys.map(key => [key, { en: en[key], zh: zh[key] }])), export: exportBundle({ analysis: observation, input, result, references }) }
  const path = new URL('./fixtures/contract.expected.json', import.meta.url)
  if (process.env.STYLE_PROMPT_UPDATE_EXPECTED === '1') await writeFile(path, JSON.stringify(actual, null, 2) + '\n', 'utf8')
  assert.deepEqual(actual, JSON.parse(await readFile(path, 'utf8')))
})
