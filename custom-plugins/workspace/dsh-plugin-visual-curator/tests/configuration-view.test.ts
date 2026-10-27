import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceFixture } from './helpers/service-fixture.ts'
import { z } from 'zod'

test('configuration reads and unchanged saves never build image projections or edit the profile', async () => {
  const fixture = await serviceFixture()
  try {
    await fixture.service.initialize()
    fixture.domain.snapshot = () => { throw new Error('A configuration operation must not project the image library') }
    fixture.host.configEditor.entries = () => { throw new Error('An unchanged save must not acquire the editor') }
    const config = await fixture.action('config-read')
    assert.ok(config && typeof config === 'object' && !Array.isArray(config) && typeof config.revision === 'string')
    const saved = await fixture.action('config-save', { revision: config.revision, vision: {}, source: {}, limits: {} })
    assert.ok(saved && typeof saved === 'object' && !Array.isArray(saved))
    assert.equal(saved.changed, false)
    assert.deepEqual(saved.configuration, config)
    assert.equal(fixture.jobs.hooks.length, 0)
    assert.equal(fixture.http.operations.length, 0)
  } finally { await fixture.cleanup() }
})

test('reading one collection keeps its saved view without projecting the image library', async () => {
  const fixture = await serviceFixture()
  try {
    await fixture.service.initialize()
    const created = await fixture.action('style-create', { operationId: 'light-style-create', name: 'One collection' })
    assert.ok(created && typeof created === 'object' && !Array.isArray(created) && typeof created.id === 'string')
    const full = await fixture.action('snapshot')
    assert.ok(full && typeof full === 'object' && !Array.isArray(full) && Array.isArray(full.styles))
    const originalList = fixture.repository.list.bind(fixture.repository)
    fixture.repository.list = kind => {
      if (kind === 'imageVersion') throw new Error('A style read must not project the image library')
      return originalList(kind)
    }
    const view = await fixture.action('style-get', { styleId: created.id })
    assert.deepEqual(view, full.styles.find(style => style && typeof style === 'object' && !Array.isArray(style) && style.styleId === created.id))
    assert.equal(fixture.http.operations.length, 0)
  } finally { await fixture.cleanup() }
})

test('snapshot pagination projects feedback only for its visible cards and preserves the next page', async () => {
  const fixture = await serviceFixture()
  try {
    await fixture.service.initialize()
    const style = z.object({ id: z.string() }).parse(await fixture.action('style-create', { operationId: 'paged-style', name: 'Paged' }))
    await fixture.action('reference-import', { operationId: 'paged-images', styleId: style.id, expectedRevision: 1, files: ['one.png', 'two.png'].map(name => ({ name, mime: 'image/png', base64: fixture.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] })) })
    const schema = z.object({ images: z.array(z.object({ imageVersionId: z.string(), name: z.string() })), nextPageToken: z.string().optional() })
    const all = schema.parse(await fixture.action('snapshot', { pageSize: 100 }))
    assert.equal(all.images.length, 2)
    const originalList = fixture.repository.list.bind(fixture.repository)
    let cardFeedbackReads = 0
    fixture.repository.list = kind => {
      if (kind === 'feedback') cardFeedbackReads++
      return originalList(kind)
    }
    const first = schema.parse(await fixture.action('snapshot', { pageSize: 1 }))
    assert.equal(cardFeedbackReads, 1, 'Unseen cards must not rebuild their feedback views')
    assert.deepEqual(first.images, all.images.slice(0, 1))
    assert.ok(first.nextPageToken)
    cardFeedbackReads = 0
    const second = schema.parse(await fixture.action('snapshot', { pageSize: 1, pageToken: first.nextPageToken }))
    assert.equal(cardFeedbackReads, 1)
    assert.deepEqual(second.images, all.images.slice(1))
    assert.equal(second.nextPageToken, undefined)
    assert.equal(fixture.http.operations.length, 0)
  } finally { await fixture.cleanup() }
})
