import { expect, test } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEditorialRules, resolveAnalysisConfig } from '../src/host/editorial-rules.js'

test('freezes shared references and validated profile policy with fixed precedence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'article-rules-'))
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'editorial.json')
  await writeFile(path, JSON.stringify({ version: 1, policy: { style: 'Ink illustration', inlineCount: 1 } }), 'utf8')
  const config = resolveAnalysisConfig({ rulesFile: path })
  const first = await loadEditorialRules(config, { ratio: '1:1' })
  expect(first.policy).toMatchObject({ style: 'Ink illustration', inlineCount: 1, ratio: '1:1', coverCount: 1 })
  expect(first.files.some(file => file.id.endsWith('understanding.md'))).toBe(true)
  await writeFile(path, JSON.stringify({ version: 1, policy: { style: 'Watercolor' } }), 'utf8')
  const second = await loadEditorialRules(config)
  expect(second.rulesHash).not.toBe(first.rulesHash)
  expect(first.policy.style).toBe('Ink illustration')
})

test('missing files and unknown policy fields reject before any model work', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'article-rules-invalid-'))
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'editorial.json')
  await expect(loadEditorialRules(resolveAnalysisConfig({ rulesFile: path }))).rejects.toThrow('analysis-rules-unavailable')
  await writeFile(path, JSON.stringify({ version: 1, policy: { approve: true } }), 'utf8')
  await expect(loadEditorialRules(resolveAnalysisConfig({ rulesFile: path }))).rejects.toThrow('analysis-rules-invalid')
})
