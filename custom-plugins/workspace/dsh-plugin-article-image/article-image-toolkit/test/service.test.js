/** Service, store and MCP surface behavior against the sample sheet. */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { ArticleService } from '../src/service.js'
import { createTools } from '../src/tools.js'
import { createServer } from '../src/server.js'

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1qggSoBOoLrdHOM-Y3YGaMUTQ3BwphWohVeDtOABWRCg/edit#gid=461869238'
const sampleCsv = readFileSync(fileURLToPath(new URL('./fixtures/sample-sheet.csv', import.meta.url)), 'utf8')
const ARTICLE_HTML = `<html lang="pt-BR"><head><title>Roteiro de 36 horas</title></head><body><article><h1>Roteiro de 36 horas</h1>${
  Array.from({ length: 14 }, (_, index) => `<p>Parágrafo ${index + 1} do roteiro com conteúdo suficiente para passar do limite mínimo de extração configurado.</p>`).join('')
}</article></body></html>`

let dir, service
const setup = async (overrides = {}) => {
  dir = await mkdtemp(join(tmpdir(), 'article-image-'))
  service = new ArticleService(resolveConfig({ dataDir: dir, ...overrides }), {
    download: async () => sampleCsv,
    fetchPage: async (config, url) => ({ url, statusCode: 200, truncated: false, body: { kind: 'html', content: ARTICLE_HTML } }),
  })
  return service
}

beforeEach(() => setup())
afterEach(async () => { await service.dispose(); await rm(dir, { recursive: true, force: true }) })

describe('import and list', () => {
  it('imports the sample sheet and lists every article', async () => {
    const result = await service.importSource({ url: SHEET_URL })
    expect(result).toMatchObject({ added: 28, updated: 0, total: 28 })
    const page = await service.list({})
    expect(page.total).toBe(28)
    expect(page.categories).toContain('Finance')
  })

  it('re-importing the same sheet keeps existing ids without duplicating', async () => {
    await service.importSource({ url: SHEET_URL })
    const second = await service.importSource({ url: SHEET_URL })
    expect(second).toMatchObject({ added: 0, updated: 0, total: 28 })
  })

  it('persists state to disk under the configured data directory', async () => {
    await service.importSource({ url: SHEET_URL })
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    expect(state.items).toHaveLength(28)
    expect(state.source.url).toBe(SHEET_URL)
  })
})

describe('retrieval', () => {
  it('retrieves a batch and reports per-article success', async () => {
    await service.importSource({ url: SHEET_URL })
    const { items } = await service.list({})
    const batch = await service.fetchMany({ ids: items.slice(0, 3).map(item => item.id) })
    expect(batch.completed).toBe(3)
    expect(batch.results.every(result => result.ok)).toBe(true)
    expect(batch.results[0].paragraphs).toBeGreaterThan(3)
  })

  it('reports a gate failure for one id without stopping the others', async () => {
    dir = await mkdtemp(join(tmpdir(), 'article-image-'))
    let call = 0
    service = new ArticleService(resolveConfig({ dataDir: dir }), {
      download: async () => sampleCsv,
      fetchPage: async (config, url) => (++call === 2
        ? { url, statusCode: 403, truncated: false, body: { kind: 'text', content: '' } }
        : { url, statusCode: 200, truncated: false, body: { kind: 'html', content: ARTICLE_HTML } }),
    })
    await service.importSource({ url: SHEET_URL })
    const { items } = await service.list({})
    const batch = await service.fetchMany({ ids: items.slice(0, 3).map(item => item.id) })
    expect(batch.completed).toBe(2)
    expect(batch.results.filter(result => !result.ok)).toHaveLength(1)
    expect(batch.results.find(result => !result.ok).code).toBe('article-access')
  })

  it('pages article paragraphs and ends with a null offset', async () => {
    await service.importSource({ url: SHEET_URL })
    const { items } = await service.list({})
    const fetched = await service.fetchArticle(items[0].id)
    const page = await service.articlePage({ id: items[0].id, sourceHash: fetched.article.hash, offset: 0 })
    expect(page.total).toBe(fetched.article.paragraphs.length)
    expect(page.paragraphs[0].id).toBe(1)
    expect(page.nextOffset).toBeNull()
  })

  it('rejects a stale source hash', async () => {
    await service.importSource({ url: SHEET_URL })
    const { items } = await service.list({})
    await service.fetchArticle(items[0].id)
    await expect(service.articlePage({ id: items[0].id, sourceHash: 'a'.repeat(64), offset: 0 })).rejects.toThrow('stale-source')
  })
})

describe('plans', () => {
  const planFor = hash => ({
    sourceHash: hash,
    brief: { theme: 'Lago de Como', facts: ['Lago'], subjects: ['Viajante'], scenes: ['Vilarejo'] },
    shots: [{ purpose: 'cover', paragraphs: [1], rationale: 'Abertura', subject: 'Viajante', action: 'Caminha', environment: 'Vilarejo', composition: 'Ampla', lighting: 'Manhã', colors: 'Azul', style: 'Editorial', details: 'Detalhe', avoid: 'Texto', prompt: 'A realistic editorial photograph of a traveller in a lakeside village at morning light.', ratio: '16:9' }],
  })

  it('saves a plan and moves the article into review', async () => {
    await service.importSource({ url: SHEET_URL })
    const { items } = await service.list({})
    const fetched = await service.fetchArticle(items[0].id)
    const saved = await service.savePlan({ id: items[0].id, revision: fetched.revision, plan: planFor(fetched.article.hash) })
    expect(saved).toMatchObject({ state: 'review', shots: 1 })
  })

  it('rejects a plan referencing a paragraph that does not exist', async () => {
    await service.importSource({ url: SHEET_URL })
    const { items } = await service.list({})
    const fetched = await service.fetchArticle(items[0].id)
    const plan = planFor(fetched.article.hash)
    plan.shots[0].paragraphs = [9999]
    await expect(service.savePlan({ id: items[0].id, revision: fetched.revision, plan })).rejects.toThrow('paragraph-reference')
  })

  it('rejects a plan whose source hash no longer matches the stored article', async () => {
    await service.importSource({ url: SHEET_URL })
    const { items } = await service.list({})
    const fetched = await service.fetchArticle(items[0].id)
    await expect(service.savePlan({ id: items[0].id, revision: fetched.revision, plan: planFor('b'.repeat(64)) })).rejects.toThrow('stale-source')
  })
})

describe('tool surface', () => {
  it('exposes every documented tool with a JSON-Schema input and a safe failure code', async () => {
    const tools = createTools(service)
    expect(tools.map(tool => tool.name)).toEqual([
      'article_image_status', 'article_image_import', 'article_image_items', 'article_image_fetch',
      'article_image_article', 'article_image_save_plan', 'article_image_report', 'article_image_skip', 'article_image_set_text',
    ])
    await expect(tools[0].run({ unexpected: true })).rejects.toThrow('invalid-request')
  })

  it('reports status without an import', async () => {
    const tools = createTools(service)
    const status = await tools[0].run({})
    expect(status.count).toBe(0)
    expect(status.generation).toEqual({ available: false, reason: 'provider-not-connected' })
  })

  it('round-trips import through the tool layer', async () => {
    const tools = createTools(service)
    const imported = await tools[1].run({ url: SHEET_URL })
    expect(imported).toMatchObject({ added: 28, rejectedCount: 0 })
    const listed = await tools[2].run({})
    expect(listed.total).toBe(28)
  })
})

describe('mcp server', () => {
  it('builds a server that advertises the tool catalogue', async () => {
    const server = createServer(service)
    expect(server).toBeTruthy()
    const tools = createTools(service)
    for (const tool of tools) expect(tool.schema).toBeTruthy()
  })
})
