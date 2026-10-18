/** Anonymous Google Sheets CSV import with bounded, Google-only redirects. */
import Papa from 'papaparse'
import { createHash } from 'node:crypto'
import { failure } from './contracts.js'

/** Parse a Google spreadsheet URL without accepting arbitrary download endpoints. @param {string} value Sheet URL. @returns {object} Sheet identity and export URL. */
export function sheetSource(value) {
  let url
  try { url = new URL(value) } catch { throw failure('sheet-url') }
  const match = /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)\/(?:edit|view|export)?\/?$/.exec(url.pathname)
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.port || url.username || url.password || !match) throw failure('sheet-url')
  const gid = url.searchParams.get('gid') ?? new URLSearchParams(url.hash.slice(1)).get('gid') ?? '0'
  if (!/^\d+$/.test(gid)) throw failure('sheet-url')
  return { key: `${match[1]}:${gid}`, spreadsheetId: match[1], gid, url: value,
    exportUrl: `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}` }
}

/** Preserve business query parameters while rejecting credentialed or non-web links. @param {string} value Link. @returns {string} Normalized URL. */
export function articleUrl(value) {
  const url = new URL(value.trim())
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) throw failure('article-url')
  url.hash = ''
  return url.href
}

/** Convert grouped rows to deduplicated article records and row-local diagnostics. @param {string} csv Source CSV. @param {string} url Sheet URL. @param {object} mapping Header mapping. @param {number} maxRows Row limit. @returns {object} Imported rows and failures. */
export function parseSheet(csv, url, mapping, maxRows = 2000) {
  const source = sheetSource(url)
  if (/^\s*</.test(csv)) throw failure('sheet-auth')
  // 显式指定逗号：Papa 的自动探测在不足 10 行的表格上误报 UndetectableDelimiter（预览计入尾随空行，平均字段数低于 2）。
  const parsed = Papa.parse(csv.replace(/^\uFEFF/, ''), { skipEmptyLines: false, delimiter: ',' })
  if (parsed.errors.length || parsed.data.length > maxRows + 1) throw failure('sheet-csv')
  const headers = (parsed.data.shift() ?? []).map(header => header.trim())
  const column = key => mapping[key] ? headers.indexOf(mapping[key]) : -1
  if (column('link') < 0 || Object.keys(mapping).some(key => mapping[key] && column(key) < 0)) throw failure('sheet-columns')
  if (headers.some((header, index) => header && headers.indexOf(header) !== index)) throw failure('sheet-columns')
  const records = new Map(), rejected = []
  let category = ''
  parsed.data.forEach((row, index) => {
    const at = key => String(row[column(key)] ?? '').trim()
    if (at('category')) category = at('category')
    if (!at('link')) return
    let normalized
    try { normalized = articleUrl(at('link')) } catch { rejected.push({ row: index + 2, code: 'article-url' }); return }
    const existing = records.get(normalized)
    if (existing) { existing.rows.push(index + 2); return }
    records.set(normalized, { id: createHash('sha256').update(`${source.key}\n${normalized}`).digest('hex').slice(0, 32), url: normalized,
      sourceKey: source.key, category, language: at('language'), notes: at('notes'), rows: [index + 2],
      raw: Object.fromEntries(headers.map((header, offset) => [header || `#${offset + 1}`, String(row[offset] ?? '')])),
    })
  })
  return { source, items: [...records.values()], rejected }
}

/** Download CSV without cookies; the redirect chain cannot leave Google's Sheets hosts. @param {string} url Source. @param {object} config Limits. @param {AbortSignal} signal Cancellation. @param {Function} fetchImpl Transport. @returns {Promise<string>} Complete UTF-8 CSV. */
export async function downloadSheet(url, config, signal, fetchImpl = globalThis.fetch) {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)])
  let current = sheetSource(url).exportUrl
  for (let hop = 0; hop <= config.maxRedirects; hop++) {
    timeout.throwIfAborted()
    const response = await fetchImpl(current, { signal: timeout, redirect: 'manual', credentials: 'omit', headers: { accept: 'text/csv' } })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw failure('sheet-redirect')
      const target = new URL(location, current)
      if (target.protocol !== 'https:' || target.port || target.username || target.password
        || !(target.hostname === 'docs.google.com' || /^doc-[a-z0-9-]+-sheets\.googleusercontent\.com$/.test(target.hostname))) throw failure('sheet-redirect')
      current = target.href
      continue
    }
    if (!response.ok || !/^text\/csv(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel(); throw failure('sheet-auth')
    }
    if (!response.body) throw failure('sheet-csv')
    const reader = response.body.getReader(), chunks = []
    let bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > config.maxCsvBytes) throw failure('sheet-size')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  }
  throw failure('sheet-redirect')
}
