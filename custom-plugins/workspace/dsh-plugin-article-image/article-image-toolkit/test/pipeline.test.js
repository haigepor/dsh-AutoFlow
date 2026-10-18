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

  it('imports a small sheet whose delimiter auto-detection cannot read', () => {
    const csv = 'Links,Notes\nhttps://example.com/one,first\nhttps://example.com/two,second\n'
    const mapping = { link: 'Links', category: '', language: '', notes: 'Notes' }
    const parsed = parseSheet(csv, SHEET_URL, mapping, config.maxRows)
    expect(parsed.items.map(item => item.url)).toEqual(['https://example.com/one', 'https://example.com/two'])
    expect(parsed.items.map(item => item.notes)).toEqual(['first', 'second'])
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
  it('keeps a declared subscriber teaser out of the text ladder even above the minimum length', () => {
    const html = `<title>Subscriber story</title><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":"False"}</script><article><p>${'Public teaser. '.repeat(60)}</p><div class="metering__paywall-container"></div></article>`
    expect(() => extractArticle(page(html), { url: 'https://example.com/a', language: '' }, config)).toThrow('article-restricted')
  })

  const page = html => ({ url: 'https://example.com/a', statusCode: 200, truncated: false, body: { kind: 'html', content: html } })

  it('extracts readable text from an article page', () => {
    const body = Array.from({ length: 12 }, (_, index) => `<p>Paragraph number ${index + 1} with enough words to clear the extraction threshold comfortably.</p>`).join('')
    const article = extractArticle(page(`<html lang="pt-BR"><head><title>Reportagem</title></head><body><article><h1>Reportagem</h1>${body}</article></body></html>`), { url: 'https://example.com/a', language: '' }, config)
    expect(article.title).toBe('Reportagem')
    expect(article.language).toBe('pt-BR')
    expect(article.paragraphs.length).toBeGreaterThan(3)
  })

  it('removes cookie consent banners so they cannot become the article', () => {
    const body = Array.from({ length: 12 }, (_, index) => `<p>Paragraph number ${index + 1} with enough words to clear the extraction threshold comfortably.</p>`).join('')
    const banner = '<div class="cookie-consent"><p>We use cookies to improve your experience and personalise services.</p></div>'
    const article = extractArticle(page(`<html lang="pt-BR"><head><title>Reportagem</title></head><body>${banner}<article><h1>Reportagem</h1>${body}</article></body></html>`), { url: 'https://example.com/a', language: '' }, config)
    expect(article.paragraphs.some(paragraph => /cookies/i.test(paragraph.text))).toBe(false)
    expect(article.paragraphs.length).toBeGreaterThan(3)
  })

  it('drops accessibility skip links from the extracted paragraphs', () => {
    const body = Array.from({ length: 8 }, (_, index) => `<p>Trecho ${index + 1} da nota com conteúdo suficiente para passar do limite mínimo de extração de artigo.</p>`).join('')
    const skip = '<p><a href="#inicioConteudo">Ir para o conteúdo 1</a></p><p><a href="#inicioMenu">Ir para o menu 2</a></p><p><a href="#inicioRodape">Ir para o rodapé 3</a></p>'
    const article = extractArticle(page(`<html lang="pt-BR"><body><main>${skip}<h1>Nota do banco</h1>${body}</main></body></html>`), { url: 'https://example.com/a', language: '' }, config)
    expect(article.paragraphs.length).toBeGreaterThan(3)
    expect(article.paragraphs.some(paragraph => /Ir para/i.test(paragraph.text))).toBe(false)
  })

  it('drops landmark regions around the article', () => {
    const body = Array.from({ length: 8 }, (_, index) => `<p>Trecho ${index + 1} da reportagem com conteúdo suficiente para passar do limite mínimo de extração.</p>`).join('')
    const landmarks = '<nav><p>Notícias</p></nav><aside><p>Leia também outra matéria</p></aside><footer><p>Política de privacidade</p></footer>'
    const article = extractArticle(page(`<html lang="pt-BR"><body><main>${landmarks}<h1>Reportagem</h1>${body}</main></body></html>`), { url: 'https://example.com/a', language: '' }, config)
    expect(article.paragraphs.length).toBeGreaterThan(3)
    expect(article.paragraphs.some(paragraph => /Notícias|Leia também|Política de privacidade/.test(paragraph.text))).toBe(false)
  })

  it('detects a Cloudflare challenge page instead of storing it as an article', () => {
    const challenge = '<html><head><title>Just a moment...</title></head><body><form id="challenge-form">Verifique se você é humano</form><div class="cf-turnstile"></div></body></html>'
    expect(() => extractArticle(page(challenge), { url: 'https://example.com/a', language: '' }, config)).toThrow('article-challenge')
  })

  it('maps transport status codes to owned error codes', () => {
    expect(() => extractArticle({ url: 'https://example.com/a', statusCode: 404, truncated: false, body: { kind: 'text', content: '' } }, { url: 'https://example.com/a', language: '' }, config)).toThrow('article-not-found')
    expect(() => extractArticle({ url: 'https://example.com/a', statusCode: 429, truncated: false, body: { kind: 'text', content: '' } }, { url: 'https://example.com/a', language: '' }, config)).toThrow('article-rate-limit')
  })

  it('reads a body hidden with visibility until scripts reveal it', () => {
    const body = Array.from({ length: 40 }, (_, index) => `<p>Trecho ${index + 1} da reportagem com conteúdo suficiente para a extração completa.</p>`).join('')
    const html = `<html lang="pt-BR"><head><title>Reportagem</title></head><body><article><h1>Reportagem</h1><div class="container j-paywall" data-paywall-box style="visibility: hidden">${body}</div></article></body></html>`
    const article = extractArticle(page(html), { url: 'https://example.com/a', language: '' }, config)
    expect(article.paragraphs.length).toBeGreaterThan(20)
  })

  it('accepts a full body that ends with an in-container subscription notice', () => {
    const body = Array.from({ length: 40 }, (_, index) => `<p>Trecho ${index + 1} da reportagem com conteúdo suficiente para a extração completa.</p>`).join('')
    const notice = '<p>Assine o jornal para continuar lendo esta reportagem exclusiva. Faça seu login.</p>'
    const html = `<html lang="pt-BR"><head><title>Reportagem</title></head><body><article><h1>Reportagem</h1><div class="container j-paywall" data-paywall-box>${body}${notice}</div></article></body></html>`
    const article = extractArticle(page(html), { url: 'https://example.com/a', language: '' }, config)
    expect(article.paragraphs.length).toBeGreaterThan(20)
    expect(article.paragraphs.some(paragraph => /Assine o jornal/.test(paragraph.text))).toBe(false)
  })

  it('narrows a page-level result to the main region', () => {
    const body = Array.from({ length: 10 }, (_, index) => `<p>Trecho ${index + 1} da nota com conteúdo suficiente para passar do limite mínimo de extração.</p>`).join('')
    const chrome = '<div class="busca-mobile"><p>Filtrar por:</p><p>Tudo Notícias Publicações Normativos</p></div>'
    const html = `<html lang="pt-BR"><head><title>Nota do banco</title></head><body><div class="page"><header><p>Menu</p></header>${chrome}<main><div class="corpo"><h1>Nota do banco</h1>${body}</div></main></div></body></html>`
    const article = extractArticle(page(html), { url: 'https://example.com/a', language: '' }, config)
    expect(article.paragraphs[0].text).not.toContain('Filtrar por')
    expect(article.paragraphs.some(paragraph => /Trecho 1 da nota/.test(paragraph.text))).toBe(true)
  })

  it('keeps the page-level result when main holds little text', () => {
    const body = Array.from({ length: 10 }, (_, index) => `<p>Trecho ${index + 1} da reportagem com conteúdo suficiente para passar do limite mínimo.</p>`).join('')
    const html = `<html lang="pt-BR"><head><title>Reportagem</title></head><body><div class="page"><main><p>Publicado hoje</p></main><article><h1>Reportagem</h1>${body}</article></div></body></html>`
    const article = extractArticle(page(html), { url: 'https://example.com/a', language: '' }, config)
    expect(article.paragraphs.length).toBeGreaterThan(5)
    expect(article.paragraphs.some(paragraph => /Trecho 1 da reportagem/.test(paragraph.text))).toBe(true)
  })

  it('trims a multi-block byline and photo credit from the body start', () => {
    const body = Array.from({ length: 10 }, (_, index) => `<p>Paragraph ${index + 1} carries the reporting with enough words to clear the extraction threshold.</p>`).join('')
    const head = '<p>By</p><p>Kerry Breen</p><p>News Editor</p><p>Kerry Breen is a news editor at Example News and a graduate of Example University.</p><p>Read Full Bio</p>'
      + '<p>Updated on: October 16, 2026 / 6:55 PM EDT / Example News</p>'
      + '<p>Traders work on the floor of the exchange during morning trading on Oct. 14, 2026 in New York City.</p><p>Michael M. Santiago | Getty Images</p>'
    const html = `<html lang="en"><head><title>Report</title></head><body><article><h1>Report</h1>${head}${body}</article></body></html>`
    const article = extractArticle(page(html), { url: 'https://example.com/a', language: '' }, config)
    expect(article.paragraphs[0].text).toMatch(/^Paragraph 1 /)
    expect(article.paragraphs.some(paragraph => /Read Full Bio|News Editor|Getty Images|Updated on/.test(paragraph.text))).toBe(false)
  })

  it('keeps a lede that follows a short opening line', () => {
    const body = Array.from({ length: 10 }, (_, index) => `<p>Paragraph ${index + 1} carries the reporting with enough words to clear the extraction threshold.</p>`).join('')
    const html = `<html lang="en"><head><title>Report</title></head><body><article><h1>Report</h1><p>PARIS — The crowds gathered early.</p>${body}</article></body></html>`
    const article = extractArticle(page(html), { url: 'https://example.com/a', language: '' }, config)
    expect(article.paragraphs[0].text).toContain('PARIS')
  })

  it('reports article-restricted when a gate notice is the whole body', () => {
    const notice = '<p>Assine a Folha para continuar lendo esta reportagem. Conteúdo exclusivo para assinantes.</p>'
    const html = `<html lang="pt-BR"><head><title>Reportagem</title></head><body><article><h1>Reportagem</h1><div class="container j-paywall" data-paywall-box>${notice}${notice}${notice}${notice}${notice}${notice}${notice}${notice}${notice}${notice}${notice}${notice}</div></article></body></html>`
    expect(() => extractArticle(page(html), { url: 'https://example.com/a', language: '' }, config)).toThrow('article-restricted')
  })

  it('trims the same leading noise from a plain-text projection', () => {
    // 渲染后的可见文本没有块标记，头部噪声按行出现；清理规则必须与 HTML 路径一致。
    const body = Array.from({ length: 10 }, (_, index) => `Parágrafo ${index + 1} traz a reportagem com palavras suficientes para passar do limite.`).join('\n')
    const notice = page('')
    const text = `detalhenoticia\nBC divulga Estatísticas Monetárias\nPublicado 29/09/2026 às 08:31\nAtualizado 29/09 às 10:20\nCompartilhe:\nprint Imprimir\n${body}`
    const article = extractArticle({ ...notice, declaredTitle: 'BC divulga Estatísticas Monetárias', body: { kind: 'text', content: text } }, { url: 'https://example.com/a', language: 'pt-BR' }, config)
    expect(article.paragraphs[0].text).toMatch(/^Parágrafo 1 /)
    expect(article.paragraphs.some(paragraph => /detalhenoticia|Publicado|Compartilhe|print Imprimir/.test(paragraph.text))).toBe(false)
  })

  it('keeps a plain-text projection too short to be an article as article-short', () => {
    const text = 'detalhenoticia\nBC divulga Relatório de Poupança\nPublicado 09/10/2026 às 09:00\nCompartilhe:\nprint Imprimir\nClique para acessar o Relatório de Poupança de setembro de 2026.'
    expect(() => extractArticle({ url: 'https://example.com/a', statusCode: 200, truncated: false, body: { kind: 'text', content: text } }, { url: 'https://example.com/a', language: 'pt-BR' }, config)).toThrow('article-short')
  })
})
