import { test, expect, vi } from 'vitest'
import { JSDOM, VirtualConsole } from 'jsdom'
import { articleRecord, extractArticle } from '../src/host/articles.js'
import { articleSchema } from '../src/shared/contracts.js'
import { resolveConfig } from '../config-schema.js'

const url = 'https://example.com/turismo/viagem'
const introduction = 'Famílias podem conhecer os vilarejos do lago durante uma viagem tranquila. O roteiro combina passeios de barco, visitas às praças e refeições em restaurantes locais, com pausas para apreciar a paisagem e respeitar o ritmo das crianças.'
const conclusion = 'A reportagem recomenda organizar os deslocamentos com antecedência e consultar os horários locais. Os visitantes encontram caminhos para caminhar à beira da água e podem escolher atividades compatíveis com o tempo disponível, sem tentar visitar todos os destinos no mesmo dia.'
function extract(body, { title = 'Um roteiro para conhecer o lago', head = '', config = {} } = {}) {
  return extractArticle({ url, statusCode: 200, truncated: false, body: { kind: 'html',
    content: `<!doctype html><html lang="pt-BR"><head><title>${title}</title>${head}</head><body>${body}</body></html>` } },
  { url, language: '' }, { ...resolveConfig({}), maxArticleElements: 50000, ...config })
}

test('reads Portuguese article text and language without running embedded scripts', () => {
  const article = extract(`<article><h1>Um roteiro para conhecer o lago</h1><p>${introduction}</p><p>${conclusion}</p></article>
    <script>document.title = 'Script executado'; document.querySelector('article').textContent = 'Texto substituído';</script>`)
  expect(article).toMatchObject({ title: 'Um roteiro para conhecer o lago', language: 'pt-BR', url, basis: 'web' })
  expect(article.paragraphs.map(paragraph => paragraph.text)).toEqual([introduction, conclusion])
})

test('keeps malformed stylesheet diagnostics and page data out of the Host console', () => {
  const css = 'p { color: red; article-image-css-source }'
  const diagnostics = [], virtualConsole = new VirtualConsole().on('jsdomError', error => diagnostics.push(error))
  const fixture = new JSDOM(`<style>${css}</style>`, { virtualConsole })
  try { expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'css-parsing', sheetText: css })])) }
  finally { fixture.window.close() }
  const hostErrors = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const article = extract(`<article><p>${introduction}</p><p>${conclusion}</p></article>`, { head: `<style>${css}</style>` })
    expect(article.paragraphs.map(paragraph => paragraph.text)).toEqual([introduction, conclusion])
    expect(hostErrors).not.toHaveBeenCalled()
  } finally { hostErrors.mockRestore() }
})

test('consumes nested list text once in reading order, including text beside child paragraphs', () => {
  const article = extract(`<article><p>${introduction}</p><ul><li>Primeira parada.<p>Uma praça recebe os visitantes.</p>
    <ul><li>Uma ilha oferece passeios de barco.</li></ul>Retorno ao vilarejo.</li><li>Segunda parada.</li></ul><p>${conclusion}</p></article>`)
  expect(article.paragraphs.map(paragraph => paragraph.text)).toEqual([
    introduction, 'Primeira parada.', 'Uma praça recebe os visitantes.', 'Uma ilha oferece passeios de barco.',
    'Retorno ao vilarejo.', 'Segunda parada.', conclusion,
  ])
  expect(article.paragraphs.map(paragraph => paragraph.id)).toEqual([1, 2, 3, 4, 5, 6, 7])
})

test('preserves intentionally repeated paragraphs', () => {
  const repeated = 'A viagem deve respeitar o ritmo das crianças.'
  const article = extract(`<article><p>${introduction}</p><p>${repeated}</p><p>${conclusion}</p><p>${repeated}</p></article>`)
  expect(article.paragraphs.map(paragraph => paragraph.text)).toEqual([introduction, repeated, conclusion, repeated])
})

test('rejects an HTTP 200 login gate with an account form', () => {
  expect(() => extract(`<main><h1>Entre na sua conta</h1><form><input type="email"><input type="password">
    <p>${'Entre na sua conta para continuar lendo esta reportagem. '.repeat(6)}</p></form></main>`,
  { title: 'Entrar para continuar' })).toThrow('article-login')
})

test('rejects a login-only page with an explicit reading directive even without a password field', () => {
  expect(() => extract(`<main><h1>Entre na sua conta</h1><p>${'Para continuar lendo esta notícia, entre na sua conta ou assine. '.repeat(6)}</p></main>`,
    { title: 'Entrar para continuar' })).toThrow('article-login')
})

test('keeps a normal article when a separate account form is present', () => {
  const article = extract(`<header><form><label>Entrar<input type="password"></label></form></header>
    <article><h1>Um roteiro para conhecer o lago</h1><p>${introduction}</p><p>${conclusion}</p></article>`)
  expect(article.paragraphs.map(paragraph => paragraph.text)).toEqual([introduction, conclusion])
})

test('keeps a normal article beside a login dialog with its own heading', () => {
  const article = extract(`<aside role="dialog"><h1>Entre na sua conta</h1><form><input type="password"></form></aside>
    <main><article><h1>Um roteiro para conhecer o lago</h1><p>${introduction}</p><p>${conclusion}</p></article></main>`)
  expect(article.paragraphs.map(paragraph => paragraph.text)).toEqual([introduction, conclusion])
})

test('rejects an HTTP 200 browser challenge with a challenge form', () => {
  expect(() => extract(`<main><form id="challenge-form"><h1>Verifique se você é humano</h1>
    <p>${'Verifique seu navegador antes de continuar. '.repeat(8)}</p></form></main>`,
  { title: 'Just a moment...' })).toThrow('article-challenge')
})

test('rejects a human-verification page with an explicit CAPTCHA widget', () => {
  expect(() => extract(`<main><h1>Verifique se você é humano</h1><div class="g-recaptcha" data-sitekey="public-key"></div>
    <p>${'Confirme que você não é um robô para continuar. '.repeat(8)}</p></main>`,
  { title: 'Verifique se você é humano' })).toThrow('article-challenge')
})

test('rejects an explicit browser challenge form without relying on its page title', () => {
  expect(() => extract(`<main><form id="challenge-form"><p>${'Verifique seu navegador antes de continuar. '.repeat(8)}</p></form></main>`,
    { title: 'Verificação' })).toThrow('article-challenge')
})

test('keeps an article beside a CAPTCHA dialog with its own heading', () => {
  const article = extract(`<aside role="dialog"><h1>Verifique se você é humano</h1><div class="g-recaptcha"></div></aside>
    <main><article><h1>Um roteiro para conhecer o lago</h1><p>${introduction}</p><p>${conclusion}</p></article></main>`)
  expect(article.paragraphs.map(paragraph => paragraph.text)).toEqual([introduction, conclusion])
})

test('does not reject reporting that discusses login, CAPTCHA and subscriptions', () => {
  const discussion = 'A pesquisa analisa páginas de login e testes CAPTCHA. A frase “Assine para continuar lendo” aparece como exemplo de uma mensagem de assinatura; ela não limita o acesso a esta reportagem.'
  const article = extract(`<article><h1>Como funcionam o login e os testes CAPTCHA</h1><p>${discussion}</p><p>${introduction}</p><p>${conclusion}</p></article>`,
    { title: 'Como funcionam o login e os testes CAPTCHA' })
  expect(article.paragraphs.map(paragraph => paragraph.text)).toEqual([discussion, introduction, conclusion])
})

test('rejects a marked subscription gate when the article contains only its advertised teaser', () => {
  expect(() => extract(`<article><h1>Um roteiro para conhecer o lago</h1><p>${introduction}</p>
    <div class="paywall"><p>Este conteúdo é exclusivo para assinantes. Assine para continuar lendo a reportagem.</p></div></article>`,
  { head: `<meta name="description" content="${introduction}">` })).toThrow('article-restricted')
})

test('rejects a short teaser whose subscription notice would otherwise satisfy the text minimum', () => {
  expect(() => extract(`<article><p>Famílias podem conhecer os vilarejos do lago.</p><div data-paywall="true">
    <p>${'Este conteúdo é exclusivo para assinantes. Assine para continuar lendo. '.repeat(6)}</p></div></article>`)).toThrow('article-restricted')
})

test('keeps substantive article text beside a subscription notice and restricted metadata', () => {
  const article = extract(`<article><h1>Um roteiro para conhecer o lago</h1><p>${introduction}</p><p>${conclusion}</p>
    <div class="paywall"><p>Assine para continuar lendo outras reportagens.</p></div></article>`,
  { head: `<meta name="description" content="${introduction}"><script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","isAccessibleForFree":false}</script>` })
  expect(article.paragraphs.map(paragraph => paragraph.text)).toEqual([introduction, conclusion])
})

test('rejects HTML that exceeds the configured DOM element budget', () => {
  expect(() => extract(`<article><p>${introduction}</p><p>${conclusion}</p>${'<span>viagem</span>'.repeat(1001)}</article>`,
    { config: { maxArticleElements: 1000 } })).toThrow('article-extraction')
})

test.each([[401, 'article-access'], [403, 'article-access'], [404, 'article-not-found'], [429, 'article-rate-limit'], [502, 'article-server']])(
  'reports HTTP %i as %s without reading the response as an article', (statusCode, code) => {
    expect(() => extractArticle({ url, statusCode, truncated: false, body: { kind: 'text', content: introduction } },
      { url, language: 'pt' }, resolveConfig({}))).toThrow(code)
  },
)

test.each([
  ['emoji', '😀'.repeat(1500)],
  ['mixed CJK and supplementary characters', '旅'.repeat(1499) + '😀' + '景'.repeat(1499) + '𠮷尾'],
])('preserves %s across bounded UTF-16 paragraphs and stable source hashes', (_label, text) => {
  const input = { title: 'Viagem', text, url, language: 'pt-BR', basis: 'manual' }
  const article = articleRecord(input, resolveConfig({}))
  expect(article.paragraphs.every(paragraph => paragraph.text.length <= 1500)).toBe(true)
  expect(article.paragraphs.map(paragraph => paragraph.text).join('')).toBe(text)
  for (const paragraph of article.paragraphs) expect(paragraph.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
  expect(articleSchema.parse(article)).toEqual(article)
  expect(articleRecord(input, resolveConfig({})).hash).toBe(article.hash)
})
