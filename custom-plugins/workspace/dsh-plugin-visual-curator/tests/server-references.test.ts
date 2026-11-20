/** The real workbench data and resource routes consume an isolated rating service. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { z } from 'zod'
import type { HttpClient } from '../src/media/network.ts'
import type { Json } from '../src/shared/model.ts'
import { groupServerReferences, serverReferenceCatalogSchema, serverReferenceCredential, serverReferenceReceiptSchema } from '../src/shared/server-references.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

const bucket = 'https://shengbo-xjp.oss-ap-southeast-1.aliyuncs.com'
const host = 'https://workbench.example.test'
const token = 'fixture-feedback-token'
const row = (id: string, grade: string | null, score: string) => ({ item_id: id, type_name: 'Fixture', img_url: bucket + '/' + id + '.png', grade, avg_score: score })
const reply = (value: unknown) => ({ status: 200, headers: {}, bytes: Buffer.from(JSON.stringify(value)) })

async function fixture() {
  const rows = [
    row('selected', 'S', '9.5'), row('broken', 'A', '7.1'), row('unrated', null, ''),
    ...Array.from({ length: 197 }, (_, index) => row('catalog-' + index, 'A', '8.6')),
    row('selected', 'S', '9.5'), { ...row('unsafe', 'A', '2.5'), img_url: 'https://unapproved.example.test/image.png' },
    row('higher-score', 'S', '10.25'),
  ]
  const pages: number[] = [], reads: string[] = []
  let movedWindow = false, image = Buffer.alloc(0)
  const http: HttpClient = { async request(raw, request) {
    const url = new URL(raw)
    assert.equal(request.method, 'GET')
    assert.equal(request.body, undefined)
    assert.equal(request.maxRedirects, 0)
    if (url.origin === bucket) {
      assert.equal(url.search, '')
      reads.push(url.pathname)
      return { status: 200, headers: { 'content-type': 'application/octet-stream' }, bytes: url.pathname === '/broken.png' ? Buffer.from('Not an image') : image }
    }
    assert.equal(url.origin, 'https://api.palmmobi.com')
    assert.equal(url.pathname, '/Customerfeedback/index.html')
    assert.equal(url.searchParams.get('token'), token)
    assert.equal(url.searchParams.get('language'), 'en')
    assert.equal(url.searchParams.get('pageSize'), '200')
    const page = Number(url.searchParams.get('page'))
    pages.push(page)
    return reply({ code: 200, data: {
      page, pageSize: 200, total: rows.length, language: 'en', start_time: '2026-10-21',
      end_time: movedWindow && page === 2 ? '2026-11-20' : '2026-11-19', rows: rows.slice((page - 1) * 200, page * 200),
    } })
  } }
  const f = await serviceFixture(undefined, {}, { serverReferenceHttp: http })
  await f.service.initialize()
  image = Buffer.from(f.referenceImage)
  const data = (operation: string, args: Record<string, Json> = {}) => f.service.data(new Request(host + '/api/visual-curator/data', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, args }),
  }))
  const authorize = () => { f.host.credentials.resolve = async ref => ref === serverReferenceCredential ? { value: token, source: 'fixture' } : undefined }
  return { ...f, data, pages, reads, authorize, moveWindow: () => { movedWindow = true } }
}

test('rating groups cover all pages and only selected approved-host bytes become references', async () => {
  const f = await fixture()
  try {
    const denied = await f.data('server-reference-list')
    assert.equal(z.object({ error: z.object({ code: z.string() }) }).parse(await denied.json()).error.code, 'configuration-required')
    assert.deepEqual(f.pages, [])
    f.authorize()
    const catalogResponse = z.object({ ok: z.literal(true), value: serverReferenceCatalogSchema }).parse(await (await f.data('server-reference-list')).json())
    const catalog = catalogResponse.value
    assert.deepEqual(f.pages, [1, 2])
    assert.deepEqual(f.reads, [])
    assert.equal(catalog.ignored, 1)
    assert.equal(catalog.items.length, 201)
    assert.deepEqual(groupServerReferences(catalog.items).map(group => [group.grade, group.items.length]), [['S', 2], ['A', 198], [null, 1]])
    assert.deepEqual(groupServerReferences(catalog.items).find(group => group.grade === 'S')?.items.map(image => image.score), [10.25, 9.5])
    assert.doesNotMatch(JSON.stringify(catalog), /fixture-feedback-token|aliyuncs|unapproved/)

    const good = catalog.items.find(item => item.itemId === 'selected'), broken = catalog.items.find(item => item.itemId === 'broken')
    assert.ok(good && broken)
    const preview = await f.service.resource(new Request(host + good.previewPath))
    assert.equal(preview.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), f.referenceImage)
    const unknown = await f.service.resource(new Request(host + good.previewPath.replace(good.key, '0'.repeat(64))))
    assert.equal(unknown.status, 404)
    assert.deepEqual(f.reads, ['/selected.png'])

    const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'rated-collection', name: 'Rated collection' }))
    const args = { styleId: style.id, expectedRevision: 1, snapshotId: catalog.snapshotId, keys: [good.key, broken.key], role: 'negative', operationId: randomUUID() }
    const parseReceipt = z.object({ ok: z.literal(true), value: serverReferenceReceiptSchema })
    const added = parseReceipt.parse(await (await f.data('server-reference-import', args)).json())
    assert.deepEqual(added.value.results.map(result => result.status), ['added', 'failed'])
    assert.deepEqual(f.reads, ['/selected.png', '/selected.png', '/broken.png'])
    assert.equal(f.repository.list('asset')[0]?.exportPermission, 'references-only')
    assert.equal(f.repository.list('reference')[0]?.role, 'negative')
    assert.equal(f.repository.list('run').length, 0)

    const revisit = { ...args, keys: [good.key], expectedRevision: f.domain.require('style', style.id).revision }
    const retry = parseReceipt.parse(await (await f.data('server-reference-import', { ...revisit, operationId: randomUUID() })).json())
    assert.equal(retry.value.results[0]?.status, 'skipped')
    const changedRole = parseReceipt.parse(await (await f.data('server-reference-import', { ...revisit, role: 'positive', operationId: randomUUID() })).json())
    assert.deepEqual(changedRole.value.results[0], { key: good.key, status: 'failed', code: 'constraint-conflict' })
    assert.equal(f.repository.list('reference').length, 1)
    assert.equal(f.reads.length, 3)
  } finally { await f.cleanup() }
})

test('a changed pagination window cannot produce misleading grade counts', async () => {
  const f = await fixture()
  try {
    f.authorize()
    f.moveWindow()
    const response = await f.data('server-reference-list')
    assert.equal(z.object({ error: z.object({ code: z.string() }) }).parse(await response.json()).error.code, 'source-protocol-error')
    assert.deepEqual(f.pages, [1, 2])
    assert.deepEqual(f.reads, [])
  } finally { await f.cleanup() }
})
