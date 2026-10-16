/** Full closed loop against a live article: import, retrieve, read paragraphs, save a plan. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { ArticleService } from '../src/service.js'
import { parseSheet } from '../src/sheets.js'
import { createTools } from '../src/tools.js'

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1qggSoBOoLrdHOM-Y3YGaMUTQ3BwphWohVeDtOABWRCg/edit#gid=461869238'
const csv = readFileSync(fileURLToPath(new URL('../test/fixtures/sample-sheet.csv', import.meta.url)), 'utf8')
const dir = await mkdtemp(join(tmpdir(), 'article-image-loop-'))
const config = resolveConfig({ dataDir: dir, requestTimeoutMs: 90000 })
const service = new ArticleService(config)
const tools = createTools(service)
const byName = new Map(tools.map(tool => [tool.name, tool]))

// 跳过 Google Sheets 网络依赖，直接写入 fixture 记录。
const parsed = parseSheet(csv, SHEET_URL, config.mapping, 2000)
await service.store.update(state => {
  for (const record of parsed.items) state.items.push({ ...record, revision: 1, state: 'imported', article: null, plan: null, approval: null, error: null })
  state.source = { url: SHEET_URL, mapping: config.mapping, importedAt: new Date().toISOString() }
  return null
})

const target = parsed.items[0]
console.log(`Target: ${target.category} — ${target.url}\n`)

const status = await byName.get('article_image_status').run({})
console.log(`1. status           -> ${status.count} articles, generation available=${status.generation.available}`)

const fetched = await byName.get('article_image_fetch').run({ ids: [target.id] })
console.log(`2. fetch            -> completed ${fetched.completed}/${fetched.total}, "${fetched.results[0].title?.slice(0, 50)}", ${fetched.results[0].paragraphs} paragraphs`)
if (!fetched.completed) { console.log('   fetch failed:', fetched.results[0].code); process.exit(1) }

const report = await byName.get('article_image_report').run({ id: target.id })
console.log(`3. report           -> revision ${report.revision}, state ${report.state}, sourceHash ${report.sourceHash.slice(0, 12)}…`)

const page = await byName.get('article_image_article').run({ id: target.id, sourceHash: report.sourceHash, offset: 0 })
console.log(`4. article          -> ${page.paragraphs.length} paragraphs this page, nextOffset ${page.nextOffset}`)
console.log(`   first paragraph:  "${page.paragraphs[0].text.slice(0, 90)}…"`)
console.log(`   last id on page:  ${page.paragraphs.at(-1).id}`)

const cited = page.paragraphs.slice(0, 3).map(paragraph => paragraph.id)
const plan = {
  sourceHash: report.sourceHash,
  brief: { theme: 'Roteiro de 36 horas no Lago de Como', facts: ['Lago de Como', 'Vilarejos'], subjects: ['Viajante'], scenes: ['Vilarejo à beira do lago'] },
  shots: [
    { purpose: 'cover', paragraphs: cited, rationale: 'Abrir a matéria com o cenário central do roteiro.',
      subject: 'Um viajante', action: 'Caminha por uma rua estreita de pedra', environment: 'Vilarejo histórico à beira do Lago de Como',
      composition: 'Plano médio amplo, rua guiando o olhar ao lago', lighting: 'Luz da manhã, sombras suaves', colors: 'Azuis do lago, ocre das fachadas',
      style: 'Fotografia editorial realista', details: 'Fachadas com persianas de madeira, barcos ao fundo', avoid: 'Texto, logotipos, rostos identificáveis',
      prompt: 'A realistic editorial travel photograph of a traveller walking a narrow stone street in a historic lakeside village on Lake Como in soft morning light, wooden shutters and boats in the distance, natural color, 35mm perspective.',
      ratio: '16:9' },
  ],
}
const saved = await byName.get('article_image_save_plan').run({ id: target.id, revision: report.revision, plan })
console.log(`5. save_plan        -> state ${saved.state}, revision ${saved.revision}, ${saved.shots} shot(s), cites paragraphs [${cited}]`)

const after = await byName.get('article_image_report').run({ id: target.id })
console.log(`6. report (after)   -> state ${after.state}, theme "${after.plan.theme}"`)

// 陈旧 revision 必须被拒绝，证明乐观并发真的生效。
try { await byName.get('article_image_save_plan').run({ id: target.id, revision: report.revision, plan }) ; console.log('7. stale revision   -> NOT REJECTED (defect)') }
catch (error) { console.log(`7. stale revision   -> rejected with "${error.message}" (expected stale-revision)` ) }

await service.dispose()
await rm(dir, { recursive: true, force: true })
console.log('\nCLOSED LOOP: OK')
