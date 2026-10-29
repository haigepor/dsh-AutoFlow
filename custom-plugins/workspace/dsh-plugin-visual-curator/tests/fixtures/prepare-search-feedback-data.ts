/** Keyless production search supplies the browser fixture's counts and categories. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { serviceFixture } from '../helpers/service-fixture.ts'

const output = process.argv[2]
if (!output) throw new Error('A fixture output directory is required')
const f = await serviceFixture()
try {
  await f.service.initialize()
  const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'style', name: '测试训练' }))
  await f.action('reference-import', { operationId: 'reference', styleId, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
  await f.action('reference-analyze', { operationId: 'analyze', styleId, buildDataset: true }); await f.jobs.drain()
  const original = f.http.request.bind(f.http)
  f.http.request = async (url, request) => url.startsWith('https://source.example.test')
    ? { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ items: [{ id: 'source-unavailable', previewUrl: 'https://images.example.test/preview' }, { id: 'source-ready', previewUrl: 'https://images.example.test/preview', originalUrl: 'https://images.example.test/original' }], nextCursor: null })) }
    : original(url, request)
  const profile = f.repository.list('modelProfile')[0]!
  const prepared = z.object({ normalizedInput: z.record(z.string(), z.json()), preparationDigest: z.string() }).parse(await f.action('task-prepare', { kind: 'search', releaseId: profile.id, output: { kind: 'original' }, taskBrief: '寻找符合当前风格画像的图片', queries: ['forest'], targetCount: 10 }))
  const started = z.object({ runId: z.string() }).parse(await f.action('search-start', { ...prepared.normalizedInput, operationId: 'search', preparationDigest: prepared.preparationDigest }))
  await f.jobs.drain()
  const run = await f.action('run-get', { runId: started.runId }), snapshot = await f.action('snapshot')
  await writeFile(join(output, 'data.js'), `window.feedbackFixtureData=${JSON.stringify({ run, snapshot })};\n`, 'utf8')
  await writeFile(join(output, 'preview.png'), f.http.image)
} finally { await f.cleanup() }
