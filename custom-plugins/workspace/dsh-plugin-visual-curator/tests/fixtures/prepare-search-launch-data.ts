/** Prepare real Host projections for the isolated native-component browser fixture. */
import { writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { serviceFixture } from '../helpers/service-fixture.ts'

const output = process.argv[2]
if (!output) throw new Error('A fixture output path is required')
const fixture = await serviceFixture()
try {
  await fixture.service.initialize()
  const { id: styleId } = z.object({ id: z.string() }).parse(await fixture.action('style-create', { operationId: 'browser-style', name: '测试训练' }))
  await fixture.action('reference-import', { operationId: 'browser-reference', styleId, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: fixture.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
  await fixture.action('reference-analyze', { operationId: 'browser-analysis', styleId, buildDataset: true }); await fixture.jobs.drain()
  await fixture.action('usage-create', { operationId: 'browser-usage', name: '横图', output: { aspectP: 2, aspectQ: 1, targetWidth: 400, targetHeight: 200, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] })
  const snapshot = z.object({ styles: z.array(z.unknown()) }).passthrough().parse(await fixture.action('snapshot'))
  if (!snapshot.styles[0]) throw new Error('The fixture profile is unavailable')
  const page = z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), output: z.object({ targetWidth: z.number(), targetHeight: z.number() }) })) }).parse(await fixture.action('usage-list'))
  const usageOptions = page.items.map(item => ({ usageRevisionId: item.id, name: item.name, targetWidth: item.output.targetWidth, targetHeight: item.output.targetHeight }))
  await writeFile(output, `window.datasetFixtureData=${JSON.stringify({ snapshot, style: snapshot.styles[0], usageOptions })};\n`, 'utf8')
} finally { await fixture.cleanup() }
