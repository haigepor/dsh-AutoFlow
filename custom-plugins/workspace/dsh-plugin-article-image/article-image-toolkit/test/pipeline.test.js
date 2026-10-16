/** Sheet parsing and article extraction behavior. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sheetSource, articleUrl, parseSheet } from '../src/sheets.js'
import { extractArticle, articleRecord } from '../src/articles.js'
import { resolveConfig } from '../src/config.js'

const config = resolveConfig({})
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1qggSoBOoLrdHOM-Y3YGaMUTQ3BwphWohVeDtOABWRCg/edit#gid=461869238'
const sampleCsv = readFileSync(fileURLToPath(new URL('./fixtures/sample-sheet.csv', import.meta.url)), 'utf8')

describe('sheetSource', () => {
  it('accepts a Google Sheets edit URL and derives the CSV export URL', () => {
    const source = sheetSource(SHEET_URL)
    expect(source.spreadsheetId).toBe('1qggSoBOoLrdHOM-Y3YGaMUTQ3BwphWohVeDtOABWRCg')
    expect(source.gid).toBe('461869238')
    expect(source.exportUrl).toBe('https://docs.google.com/spreadsheets/d/1qggSoBOoLrdHOM-Y3YGaMUTQ3BwphWohVeDtOABWRCg/export?format=csv&gid=461869238')
  })

  it('rejects non-Google hosts and credentialed URLs', () => {
    expect(() => sheetSource('https://evil.example.com/spreadsheets/d/abc/edit')).toThrow()
    expect(() => sheetSource('https://user:pass@docs.google.com/spreadsheets/d/abc/edit')).toThrow()
    expect(() => sheetSource('https://docs.google.com/spreadsheets/d/abc/edit/extra')).toThrow()
    expect(() => sheetSource('https://docs.google.com/spreadsheets/d/abc/edit#gid=not-a-number')).toThrow()
  })
})

describe('articleUrl', () => {
  it('keeps business query parameters and strips the fragment', () => {
    expect(articleUrl('https://example.com/post?id=1#section')).toBe('https://example.com/post?id=1')
  })

  it('rejects credentialed links', () => {
    expect(() => articleUrl('https://user:pass@example.com/post')).toThrow()
  })
})

describe('parseSheet', () => {
  it('imports all 28 sample links with categories, deduplicating and rejecting nothing', () => {
    const parsed = parseSheet(sampleCsv, SHEET_URL, config.mapping, config.maxRows)
    expect(parsed.items).toHaveLength(28)
    expect(parsed.rejected).toEqual([])
    expect(new Set(parsed.items.map(item => item.id)).size).toBe(28)
    expect(parsed.items[0].category).toBe('Travel')
    expect(parsed.items.at(-1).category).toBe('Finance')
    expect(parsed.items.every(item => /^[a-f0-9]{32}$/.test(item.id))).toBe(true)
  })

  it('assigns the preceding category to rows that leave it blank', () => {
    const parsed = parseSheet(sampleCsv, SHEET_URL, config.mapping, config.maxRows)
    const finance = parsed.items.filter(item => item.category === 'Finance')
    expect(finance).toHaveLength(6)
  })

  it('reports row-local rejections without failing the import', () => {
    const csv = 'Links,Category\nhttps://example.com/ok,News\nnot-a-url,News\n'
    const mapping = { link: 'Links', category: 'Category', language: '', notes: '' }
    const parsed = parseSheet(csv, SHEET_URL, mapping, config.maxRows)
    expect(parsed.items).toHaveLength(1)
    expect(parsed.rejected).toEqual([{ row: 3, code: 'article-url' }])
  })

  it('requires every column named by the configured mapping', () => {
    expect(() => parseSheet('Links,Category\nhttps://example.com,News\n', SHEET_URL, config.mapping, config.maxRows)).toThrow('sheet-columns')
  })

  it('rejects a sheet missing the configured link column', () => {
    expect(() => parseSheet('Url,Category\nhttps://example.com,News\n', SHEET_URL, config.mapping, config.maxRows)).toThrow('sheet-columns')
  })

  it('rejects an HTML sign-in page served instead of CSV', () => {
    expect(() => parseSheet('<!DOCTYPE html><html><body>Sign in</body></html>', SHEET_URL, config.mapping, config.maxRows)).toThrow('sheet-auth')
  })
})

describe('articleRecord', () => {
  it('splits paragraphs and numbers them from one', () => {
    const text = `${'Primeiro parágrafo com conteúdo suficiente para o limite. '.repeat(6).trim()}\n\n${'Segundo parágrafo com conteúdo suficiente para o limite. '.repeat(6).trim()}`
    const record = articleRecord({ title: 'T', text, url: 'https://example.com/a', basis: 'web' }, config)
    expect(record.paragraphs.map(paragraph => paragraph.id)).toEqual([1, 2])
    expect(record.paragraphs[1].text.startsWith('Segundo parágrafo')).toBe(true)
    expect(record.hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects text below the minimum length', () => {
    expect(() => articleRecord({ title: 'T', text: 'too short', url: 'https://example.com/a', basis: 'web' }, config)).toThrow('article-short')
  })
})

describe('extractArticle', () => {
  const page = html => ({ url: 'https://example.com/a', statusCode: 200, truncated: false, body: { kind: 'html', content: html } })

  it('extracts readable text from an article page', () => {
    const body = Array.from({ length: 12 }, (_, index) => `<p>Paragraph number ${index + 1} with enough words to clear the extraction threshold comfortably.</p>`).join('')
    const article = extractArticle(page(`<html lang="pt-BR"><head><title>Reportagem</title></head><body><article><h1>Reportagem</h1>${body}</article></body></html>`), { url: 'https://example.com/a', language: '' }, config)
    expect(article.title).toBe('Reportagem')
    expect(article.language).toBe('pt-BR')
    expect(article.paragraphs.length).toBeGreaterThan(3)
  })

  it('detects a Cloudflare challenge page instead of storing it as an article', () => {
    const challenge = '<html><head><title>Just a moment...</title></head><body><form id="challenge-form">Verifique se você é humano</form><div class="cf-turnstile"></div></body></html>'
    expect(() => extractArticle(page(challenge), { url: 'https://example.com/a', language: '' }, config)).toThrow('article-challenge')
  })

  it('maps transport status codes to owned error codes', () => {
    expect(() => extractArticle({ url: 'https://example.com/a', statusCode: 404, truncated: false, body: { kind: 'text', content: '' } }, { url: 'https://example.com/a', language: '' }, config)).toThrow('article-not-found')
    expect(() => extractArticle({ url: 'https://example.com/a', statusCode: 429, truncated: false, body: { kind: 'text', content: '' } }, { url: 'https://example.com/a', language: '' }, config)).toThrow('article-rate-limit')
  })
})
