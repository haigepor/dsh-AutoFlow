/** Live end-to-end run against the sample links; network access is required. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { ArticleService } from '../src/service.js'
import { parseSheet } from '../src/sheets.js'

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1qggSoBOoLrdHOM-Y3YGaMUTQ3BwphWohVeDtOABWRCg/edit#gid=461869238'
const csv = readFileSync(fileURLToPath(new URL('../test/fixtures/sample-sheet.csv', import.meta.url)), 'utf8')
const argv = process.argv.slice(2)
const flag = name => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined }
const limit = Number(argv.find(argument => !argument.startsWith('--') && Number.isFinite(Number(argument))) ?? 28)
// 默认值与运行时一致；需要覆盖时按 CLI 同名参数传入，例如 --render-mode fallback。
const overrides = {
  ...(flag('render-mode') ? { renderMode: flag('render-mode') } : {}),
  ...(flag('timeout-ms') ? { requestTimeoutMs: Number(flag('timeout-ms')) } : {}),
  ...(flag('render-timeout-ms') ? { renderTimeoutMs: Number(flag('render-timeout-ms')) } : {}),
  ...(flag('render-wait-ms') ? { renderWaitMs: Number(flag('render-wait-ms')) } : {}),
  ...(flag('fetch-concurrency') ? { fetchConcurrency: Number(flag('fetch-concurrency')) } : {}),
  ...(flag('fetch-cache') ? { fetchCache: flag('fetch-cache') !== 'false' } : {}),
}

const dir = await mkdtemp(join(tmpdir(), 'article-image-live-'))
const service = new ArticleService(resolveConfig({ dataDir: dir, requestTimeoutMs: 45000, ...overrides }))

// fixture 用真实 CSV 内容，避免依赖 Google Sheets 的当前可访问性。
const parsed = parseSheet(csv, SHEET_URL, resolveConfig({}).mapping, 2000)
await service.store.update(state => {
  for (const record of parsed.items) state.items.push({ ...record, revision: 1, state: 'imported', article: null, plan: null, approval: null, error: null })
  state.source = { url: SHEET_URL, mapping: resolveConfig({}).mapping, importedAt: new Date().toISOString() }
  return null
})

const ids = parsed.items.slice(0, limit).map(item => item.id)
const byId = new Map(parsed.items.map(item => [item.id, item]))
console.log(`Retrieving ${ids.length} articles (concurrency 2)...\n`)
const started = Date.now()
const batch = await service.fetchMany({ ids })
console.log(`completed ${batch.completed}/${batch.total} in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)

const tally = new Map()
for (const result of batch.results) {
  const item = byId.get(result.id)
  const category = item.category.padEnd(34).slice(0, 34)
  if (result.ok) console.log(`OK    ${category} ${String(result.paragraphs).padStart(4)} paras  ${item.url.slice(0, 62)}`)
  else { console.log(`FAIL  ${category} ${result.code.padEnd(22)} ${item.url.slice(0, 62)}`); tally.set(result.code, (tally.get(result.code) ?? 0) + 1) }
}
console.log(`\nFailure codes: ${tally.size ? [...tally].map(([code, count]) => `${code}=${count}`).join(', ') : 'none'}`)
await service.dispose()
await rm(dir, { recursive: true, force: true })
