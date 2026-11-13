/** Official image edits use the chosen key and retain one durable result per operation. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import type { ImageGenerationId, ImageGenerationRequest } from '@deepseek-ai/dsh-llm'
import { storageFixture } from './helpers/storage-fixture.ts'
import { resolveCurrentConfig } from '../src/host/config.ts'
import { openOfficialImageProvider } from '../src/host/official-image-provider.ts'

test('official edit sends the selected key, saves the returned image, and does not dispatch the same operation twice', async () => {
  const fixture = await storageFixture()
  const attachments = new LocalAttachmentStore(new Context(), { dshHome: fixture.root })
  const pixels = await sharp({ create: { width: 96, height: 160, channels: 4, background: '#ca5a79' } }).png().toBuffer()
  const reference = await attachments.saveImage({ data: pixels, mediaType: 'image/png' })
  const config = resolveCurrentConfig({ imageSources: { apiKeys: [{ id: 'key-one', label: 'Personal key', credentialRef: 'VISUAL_CURATOR_IMAGE_ONE' }] } })
  let requests = 0, modelRequests = 0
  const opened = await openOfficialImageProvider({ storage: fixture.facility, domainName: 'official_image_test', attachments, credentials: { resolve: async () => ({ value: 'test-secret', source: 'fixture' }) }, config: () => config, report: error => { throw error }, fetch: async (url, init) => {
    if (String(url).endsWith('/models')) { modelRequests++; return Response.json({ data: [{ id: 'gpt-image-2.5-sunburst' }, { id: 'gpt-image-2' }, { id: 'gpt-4.1' }] }) }
    requests++
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-secret')
    const form = init?.body
    assert.ok(form instanceof FormData)
    assert.equal(form.get('model'), 'gpt-image-2.5-sunburst')
    assert.equal(form.get('size'), '1872x3328')
    assert.equal(form.getAll('image[]').length, 1)
    return Response.json({ data: [{ b64_json: pixels.toString('base64') }] })
  } })
  try {
    assert.deepEqual((await opened.provider.listModels()).map(model => model.id), ['gpt-image-2', 'gpt-image-2.5-sunburst'])
    assert.deepEqual((await opened.provider.listSources!()).map(source => source.models?.map(model => model.id)), [['gpt-image-2', 'gpt-image-2.5-sunburst']])
    assert.equal(modelRequests, 1)
    const request: ImageGenerationRequest = { id: brandString<ImageGenerationId>('official-once'), provider: 'visual-curator-openai', sourceId: 'key-one', model: 'gpt-image-2.5-sunburst', prompt: 'Extend the background', references: [reference], size: '1872x3328', quality: 'high', signal: new AbortController().signal }
    const accepted = await opened.provider.start!(request)
    const completed = await opened.provider.get!(accepted, { waitMs: 5000 })
    assert.equal(completed.state, 'succeeded')
    assert.equal(completed.images.length, 1)
    assert.deepEqual(await opened.provider.start!(request), completed)
    assert.equal(requests, 1)
    await assert.rejects(opened.provider.start!({ ...request, sourceId: 'missing', id: brandString<ImageGenerationId>('missing-key') }), { code: 'UNSUPPORTED_OPTION' })
    assert.equal(requests, 1)
  } finally { await opened.close(); await fixture.cleanup() }
})

test('each official key exposes only its own image models', async () => {
  const fixture = await storageFixture()
  const attachments = new LocalAttachmentStore(new Context(), { dshHome: fixture.root })
  const config = resolveCurrentConfig({ imageSources: { apiKeys: [
    { id: 'key-one', label: 'First key', credentialRef: 'VISUAL_CURATOR_IMAGE_ONE' },
    { id: 'key-two', label: 'Second key', credentialRef: 'VISUAL_CURATOR_IMAGE_TWO' },
  ] } })
  let requests = 0
  const opened = await openOfficialImageProvider({ storage: fixture.facility, domainName: 'official_image_catalog_test', attachments, credentials: { resolve: async ref => ({ value: String(ref).endsWith('ONE') ? 'first-secret' : 'second-secret', source: 'fixture' }) }, config: () => config, report: error => { throw error }, fetch: async (_url, init) => {
    requests++
    const token = (init?.headers as Record<string, string>).Authorization
    return Response.json({ data: [{ id: token === 'Bearer first-secret' ? 'gpt-image-2' : 'gpt-image-2.5-sunburst' }, { id: 'gpt-4.1' }] })
  } })
  try {
    const sources = await opened.provider.listSources!()
    assert.deepEqual(sources.map(source => [source.id, source.models?.map(model => model.id)]), [['key-one', ['gpt-image-2']], ['key-two', ['gpt-image-2.5-sunburst']]])
    assert.deepEqual((await opened.provider.listModels()).map(model => model.id), ['gpt-image-2', 'gpt-image-2.5-sunburst'])
    assert.equal(requests, 2)
  } finally { await opened.close(); await fixture.cleanup() }
})

test('an interrupted official request retains an unknown outcome and is never resent on recovery', async () => {
  const fixture = await storageFixture()
  const attachments = new LocalAttachmentStore(new Context(), { dshHome: fixture.root })
  const pixels = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#ae793c' } }).png().toBuffer()
  const reference = await attachments.saveImage({ data: pixels, mediaType: 'image/png' })
  const config = resolveCurrentConfig({ imageSources: { apiKeys: [{ id: 'key-one', label: 'Personal key', credentialRef: 'VISUAL_CURATOR_IMAGE_ONE' }] } })
  let requests = 0
  const options = { storage: fixture.facility, domainName: 'official_image_recovery_test', attachments, credentials: { resolve: async () => ({ value: 'test-secret', source: 'fixture' }) }, config: () => config, report: (error: Error) => { throw error } }
  const opened = await openOfficialImageProvider({ ...options, fetch: async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'gpt-image-2.5-sunburst' }] })
    requests++
    return await new Promise<never>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
  } })
  const request: ImageGenerationRequest = { id: brandString<ImageGenerationId>('official-interrupted'), provider: 'visual-curator-openai', sourceId: 'key-one', model: 'gpt-image-2.5-sunburst', prompt: 'Extend the background', references: [reference], size: '1872x3328', quality: 'high', signal: new AbortController().signal }
  try {
    const accepted = await opened.provider.start!(request)
    while (requests === 0) await new Promise<void>(resolve => setImmediate(resolve))
    await opened.close()
    const recovered = await openOfficialImageProvider({ ...options, fetch: async () => { requests++; throw new Error('Unexpected resend') } })
    try {
      const result = await recovered.provider.get!(accepted)
      assert.equal(result.state, 'outcome-unknown')
      assert.equal((await recovered.provider.start!(request)).state, 'outcome-unknown')
      assert.equal(requests, 1)
    } finally { await recovered.close() }
  } finally { await fixture.cleanup() }
})
