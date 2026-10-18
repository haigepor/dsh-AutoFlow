/** Real MCP framing carries safe progress and bounded diagnostic references. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'
import { ArticleService } from '../src/service.js'
import { resolveConfig } from '../src/config.js'
import { hashSnapshot } from '../src/capture-contracts.js'
import { createTools } from '../src/tools.js'
import { failure } from '../src/contracts.js'

const url = 'https://articles.example.test/story'
const cleanups = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

function captured() {
  const snapshot = { schemaVersion: 2, id: randomBytes(16).toString('hex'), title: '公开文章', requestedUrl: url, url,
    language: 'zh', capturedAt: new Date().toISOString(), extractorVersion: 'fixture/1', sourceHash: '0'.repeat(64),
    blocks: [{ id: 'b1', type: 'paragraph', inline: [{ text: '公开文章的完整正文。' }] }], assets: [], quality: { status: 'needs-review', reasons: ['unknown-article-scope'] } }
  snapshot.sourceHash = hashSnapshot(snapshot)
  return { snapshot, assets: [] }
}

async function fixture(capture, limits = {}) {
  const root = await mkdtemp(join(tmpdir(), 'article-progress-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const config = resolveConfig({ dataDir: root })
  Object.assign(config, limits)
  const service = new ArticleService(config, { capture: { capture, async dispose() {} } })
  cleanups.push(() => service.dispose())
  const server = createServer(service), client = new Client({ name: 'progress-test', version: '1.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  cleanups.push(() => server.close())
  cleanups.push(() => client.close())
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, service }
}

describe('MCP capture progress and diagnostics', () => {
  it('preserves transport codes in both the MCP result and terminal diagnostic', async () => {
    const codes = ['article-network', 'article-timeout', 'article-redirect', 'article-url-blocked', 'article-resource-limit']
    let next = 0
    const { client } = await fixture(async () => { throw failure(codes[next++]) })
    const outcomes = []
    for (const code of codes) {
      const response = await client.callTool({ name: 'article_image_capture_source', arguments: { url } })
      const page = JSON.parse((await client.callTool({ name: 'article_image_diagnostics', arguments: { diagnosticId: response._meta.diagnosticId } })).content[0].text)
      outcomes.push({ isError: response.isError, code: response.content[0].text, state: page.state, terminalCode: page.events.at(-1).details.code })
      expect(response.content[0].text).toBe(code)
    }
    expect(outcomes).toMatchInlineSnapshot(`
      [
        {
          "code": "article-network",
          "isError": true,
          "state": "failed",
          "terminalCode": "article-network",
        },
        {
          "code": "article-timeout",
          "isError": true,
          "state": "failed",
          "terminalCode": "article-timeout",
        },
        {
          "code": "article-redirect",
          "isError": true,
          "state": "failed",
          "terminalCode": "article-redirect",
        },
        {
          "code": "article-url-blocked",
          "isError": true,
          "state": "failed",
          "terminalCode": "article-url-blocked",
        },
        {
          "code": "article-resource-limit",
          "isError": true,
          "state": "failed",
          "terminalCode": "article-resource-limit",
        },
      ]
    `)
  })

  it('records the legacy retrieval rung failure and browser recovery without leaking article text', async () => {
    const { client, service } = await fixture(async () => captured())
    service.config.renderMode = 'fallback'
    service.download = async () => 'Links,Category,语言,备注\nhttps://articles.example.test/story,Travel,en,\n'
    service.fetchPage = async () => ({ url, statusCode: 403, truncated: false, body: { kind: 'html', content: '' } })
    service.renderer.render = async () => ({ url, statusCode: 200, truncated: false,
      body: { kind: 'html', content: `<article><h1>Recovered article</h1><p>${'Public article with sufficient editorial text. '.repeat(20)}</p></article>` } })
    await service.importSource({ url: 'https://docs.google.com/spreadsheets/d/progress-fixture/edit' })
    const { items } = await service.list()
    const result = JSON.parse((await client.callTool({ name: 'article_image_fetch', arguments: { ids: [items[0].id] } })).content[0].text)
    expect(result.completed).toBe(1)
    const page = JSON.parse((await client.callTool({ name: 'article_image_diagnostics', arguments: { diagnosticId: result.diagnosticId } })).content[0].text)
    expect(page.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'rung-failed', details: expect.objectContaining({ rung: 'static', code: 'article-access' }) }),
      expect.objectContaining({ event: 'rung-started', details: expect.objectContaining({ rung: 'browser' }) }),
    ]))
    expect(JSON.stringify(page)).not.toContain('sufficient editorial text')
  })

  it('throttles repeated notifications while retaining every diagnostic event across pages', async () => {
    const { client } = await fixture(async (input, options) => {
      for (let index = 0; index < 8; index++) await options.onProgress({ phase: 'rendering', event: 'navigation-start' })
      await options.onProgress({ phase: 'extracting', event: 'source-extracted' })
      return captured()
    }, { progressIntervalMs: 600000, pageSize: 3 })
    const updates = []
    const value = JSON.parse((await client.callTool({ name: 'article_image_capture_source', arguments: { url } }, undefined, { onprogress: event => { updates.push(event) } })).content[0].text)
    expect(updates.map(event => event.message)).toEqual(['queued: started', 'rendering: navigation-start', 'extracting: source-extracted', 'completed: completed'])
    expect(updates.map(({ progress, message }) => ({ progress, message }))).toMatchInlineSnapshot(`
      [
        {
          "message": "queued: started",
          "progress": 1,
        },
        {
          "message": "rendering: navigation-start",
          "progress": 2,
        },
        {
          "message": "extracting: source-extracted",
          "progress": 10,
        },
        {
          "message": "completed: completed",
          "progress": 11,
        },
      ]
    `)
    const events = []
    let offset = 0
    do {
      const page = JSON.parse((await client.callTool({ name: 'article_image_diagnostics', arguments: { diagnosticId: value.diagnosticId, offset } })).content[0].text)
      expect(page.events.length).toBeLessThanOrEqual(3)
      events.push(...page.events)
      offset = page.nextOffset
    } while (offset !== null)
    expect(events.map(event => event.sequence)).toEqual(Array.from({ length: 11 }, (_, index) => index + 1))
  })

  it('keeps capture success when an observer throws and records terminal cancellation safely', async () => {
    const { service } = await fixture(async () => captured())
    const tool = createTools(service).find(value => value.name === 'article_image_capture_source')
    const value = await tool.run({ url }, undefined, () => { throw new Error('Observer offline') })
    expect(service.diagnostics.page({ diagnosticId: value.diagnosticId }).state).toBe('completed')
    const controller = new AbortController()
    service.richCapture.engine.capture = async () => { controller.abort(); controller.signal.throwIfAborted() }
    const error = await tool.run({ url }, controller.signal).catch(error => error)
    expect(error.code).toBe('article-interrupted')
    expect(service.diagnostics.page({ diagnosticId: error.diagnosticId }).state).toBe('cancelled')
  })

  it('reports increasing progress and retains safe phase evidence', async () => {
    const { client } = await fixture(async (input, options) => {
      await options.onProgress?.({ phase: 'rendering', event: 'navigation-start', details: {
        origin: 'https://user:private-password@articles.example.test/path?token=private-token',
        limitMs: 45000, headers: { authorization: 'private-bearer' }, html: '<p>private body</p>',
      } })
      await options.onProgress?.({ phase: 'extracting', event: 'source-extracted', completed: 1, total: 1, details: { blocks: 1, chars: 12 } })
      return captured()
    })
    const updates = []
    const result = await client.callTool({ name: 'article_image_capture_source', arguments: { url } }, undefined, { onprogress: value => { updates.push(value) } })
    const value = JSON.parse(result.content[0].text)
    expect(value.diagnosticId).toMatch(/^[a-f0-9]{32}$/)
    expect(updates.length).toBeGreaterThan(1)
    expect(updates.every((value, index) => index === 0 || value.progress > updates[index - 1].progress)).toBe(true)
    const response = await client.callTool({ name: 'article_image_diagnostics', arguments: { diagnosticId: value.diagnosticId } })
    const page = JSON.parse(response.content[0].text)
    expect(page.state).toBe('completed')
    expect(page.events.some(value => value.event === 'source-extracted')).toBe(true)
    expect(page.events.find(value => value.event === 'navigation-start').details.origin).toBe('https://articles.example.test')
    expect(JSON.stringify([page, updates])).not.toMatch(/private-password|private-token|private-bearer|private body/)
  })

  it('keeps the old error code and supplies diagnostics without exposing an upstream stack', async () => {
    const { client } = await fixture(async (input, options) => {
      await options.onProgress?.({ phase: 'rendering', event: 'waiting-content' })
      throw new Error('private upstream body and Authorization: Bearer private-secret')
    })
    const result = await client.callTool({ name: 'article_image_capture_source', arguments: { url } })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('operation-failed')
    expect(result._meta?.diagnosticId).toMatch(/^[a-f0-9]{32}$/)
    const response = await client.callTool({ name: 'article_image_diagnostics', arguments: { diagnosticId: result._meta.diagnosticId } })
    const page = JSON.parse(response.content[0].text)
    expect(page.state).toBe('failed')
    expect(page.events.at(-1)).toMatchObject({ event: 'failed', details: { code: 'operation-failed' } })
    expect(JSON.stringify([result, page])).not.toMatch(/private|Bearer|Authorization/)
  })

  it('remains usable without a progress token and bounds retained event pages', async () => {
    const { client } = await fixture(async (input, options) => {
      for (let index = 0; index < 15; index++) await options.onProgress?.({ phase: 'rendering', event: 'resource-http-error', details: { statusCode: 404, bytes: index } })
      return captured()
    }, { maxDiagnosticEvents: 4 })
    const result = await client.callTool({ name: 'article_image_capture_source', arguments: { url } })
    expect(result.isError).toBeFalsy()
    const value = JSON.parse(result.content[0].text)
    const response = await client.callTool({ name: 'article_image_diagnostics', arguments: { diagnosticId: value.diagnosticId } })
    const page = JSON.parse(response.content[0].text)
    expect(page.events).toHaveLength(4)
    expect(page.droppedEvents).toBeGreaterThan(0)
    expect(page.events.at(-1).event).toBe('completed')
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16000)
  })

  it('evicts old diagnostic runs without changing capture success', async () => {
    const { client } = await fixture(async () => captured(), { maxDiagnosticRuns: 1 })
    const first = JSON.parse((await client.callTool({ name: 'article_image_capture_source', arguments: { url } })).content[0].text)
    const second = JSON.parse((await client.callTool({ name: 'article_image_capture_source', arguments: { url } })).content[0].text)
    const expired = await client.callTool({ name: 'article_image_diagnostics', arguments: { diagnosticId: first.diagnosticId } })
    expect(expired).toMatchObject({ isError: true, content: [{ type: 'text', text: 'diagnostic-missing' }] })
    const current = await client.callTool({ name: 'article_image_diagnostics', arguments: { diagnosticId: second.diagnosticId } })
    expect(current.isError).toBeFalsy()
  })
})
