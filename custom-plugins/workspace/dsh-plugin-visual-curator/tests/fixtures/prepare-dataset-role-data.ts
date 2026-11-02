/** Isolated, immutable package data for native role-selection and sample-pagination acceptance. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { serviceFixture } from '../helpers/service-fixture.ts'
import { datasetListSchema, datasetDetailSchema } from '../../src/shared/datasets.ts'
import { profileSaveReceiptSchema } from '../../src/shared/profile-selection.ts'

const output = resolve(process.argv[2] ?? '.playwright-mcp/dataset-role-fixture'), f = await serviceFixture(undefined, { pageSize: 3 })
try {
  await f.service.initialize()
  const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'role-ui-style', name: '正反例数据集验收' }))
  for (const role of ['positive', 'negative'] as const) {
    const files = await Promise.all(Array.from({ length: 4 }, async (_, index) => ({ name: `${role}-${index}.png`, mime: 'image/png', base64: (await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: role === 'positive' ? 40 + index * 10 : 160 + index * 10, g: 110, b: 75 } } }).png().toBuffer()).toString('base64'), role, intent: 'overall', dimensions: [] })))
    await f.action('reference-import', { operationId: `role-ui-${role}`, styleId: style.id, expectedRevision: f.domain.require('style', style.id).revision, files })
    await f.action('reference-analyze', { operationId: `role-ui-analysis-${role}`, styleId: style.id, buildDataset: true }); await f.jobs.drain()
    const profile = f.repository.list('modelProfile').filter(item => item.styleId === style.id).sort((a, b) => b.revision - a.revision)[0]!
    await f.action('export-start', { operationId: `role-ui-package-${role}`, kind: 'style', purpose: 'reference', releaseId: profile.id }); await f.jobs.drain()
    if (role === 'negative') {
      const current = profileSaveReceiptSchema.parse(await f.action('profile-save', { operationId: 'role-ui-current', styleId: style.id, analysisRunId: profile.analysisRunId, expectedProfileId: profile.id, changes: [{ ruleId: profile.options[0]!.rule.ruleId, enabled: true, statement: 'Prefer muted greens with visible texture.' }] }))
      await f.action('export-start', { operationId: 'role-ui-negative-observations', kind: 'style', purpose: 'reference', releaseId: current.id, sampleScope: 'negative' }); await f.jobs.drain()
    }
  }
  const snapshot = z.object({ styles: z.array(z.object({ styleId: z.string() }).passthrough()) }).passthrough().parse(await f.action('snapshot'))
  const list = datasetListSchema.parse(await f.action('datasets-list', { styleId: style.id }))
  const samplePages: Record<string, Record<string, Record<string, unknown>>> = {}
  for (const entry of list.entries) {
    samplePages[entry.id] = {}
    for (const sampleRole of ['all', 'positive', 'negative'] as const) {
      const pages: Record<string, unknown> = {}; let pageToken: string | undefined
      do {
        const page = datasetDetailSchema.parse(await f.action('dataset-get', { id: entry.id, sampleRole, ...(pageToken ? { pageToken } : {}) }))
        pages[pageToken ?? 'first'] = page; pageToken = page.nextSamplePageToken
      } while (pageToken)
      samplePages[entry.id]![sampleRole] = pages
    }
  }
  const detail = samplePages[list.entries[0]!.id]!['all']!['first']
  await mkdir(output, { recursive: true })
  await writeFile(resolve(output, 'data.js'), `window.datasetFixtureData=${JSON.stringify({ style: snapshot.styles.find(item => item.styleId === style.id), snapshot, list, detail, samplePages })};\n`, 'utf8')
  console.log(`Isolated role fixture: ${output}`)
} finally { await f.cleanup() }
