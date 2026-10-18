/** Installed article workflow through real capture, dedicated sessions, authenticated routes and Client. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { requireBuilt, ZH_BROWSER_LOCALE } from './support.ts'

const PACKAGE = 'dsh-plugin-article-image'
interface Coverage { blockIds: string[]; assetIds: string[] }
interface SourceSnapshot {
  id: string
  sourceHash: string
  blocks: { id: string; type: string; alt?: string; inline?: { text: string; href?: string }[] }[]
  assets: { id: string }[]
  quality: { status: string; reasons: string[]; checks: string[] }
}
interface Capture { capture(url: string, options?: object): Promise<{ snapshot: SourceSnapshot }>; dispose(): Promise<void> }
interface ArticleDetail {
  id: string
  revision: number
  state: string
  snapshot: SourceSnapshot
  error: string | null
  plan: {
    inputHash: string
    brief: { theme: string }
    shots: { subject: string; prompt: string; sceneHash: string; promptSceneHash: string }[]
  }
  run: {
    id: string
    stage: string
    status: string
    events: { at: string; event: string; details: { downloadMs?: number; decodeMs?: number } }[]
  }
  approval: object | null
  analysis: { checkpoints: { sessionId: string; submissionSeq: number }[]; input: { images: object[] } }
}
interface ArticleHarness {
  config: { analysis: { enabled: boolean; provider: string; model: string }; capture: object }
  capture: Capture
  download: () => Promise<string>
  importSource(input: { url: string }): Promise<unknown>
  list(input: object): Promise<{ items: { id: string }[] }>
  detail(id: string): Promise<ArticleDetail>
  status(): Promise<{ generation: { available: boolean }; analysis: { available: boolean } }>
}

function originalPng(): Buffer {
  const crc = (bytes: Buffer): number => {
    let value = 0xffffffff
    for (const byte of bytes) {
      value ^= byte
      for (let index = 0; index < 8; index++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const value = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4)
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(value))
    return Buffer.concat([length, value, checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(48, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((64 * 3 + 1) * 48))), chunk('IEND', Buffer.alloc(0))])
}

function understood(expected: Coverage) {
  return { articleType: 'guide', audience: 'families', purpose: 'help plan travel', language: 'en', theme: '家庭旅行',
    sections: [{ title: 'Planning activities and breaks', summary: 'Families plan outdoor activities and regular rest breaks.', blockIds: expected.blockIds }], entities: ['families'],
    facts: [{ id: 'f1', claim: 'Families plan outdoor activities and rest breaks.', kind: 'source', evidence: { blockIds: expected.blockIds, assetIds: [] } }],
    limitations: ['This is planning guidance, not a record of an actual trip.'], questions: [],
    images: expected.assetIds.map(assetId => ({ assetId, observations: 'A black rectangular test image.', relationship: 'The fixture original is retained for inspection.', blockIds: expected.blockIds })), coverage: expected }
}

function planned(expected: Coverage) {
  return { brief: { theme: '家庭旅行', facts: ['安排活动与休息'], subjects: ['家庭'], scenes: ['户外活动'] },
    shots: [{ purpose: 'cover', paragraphs: expected.blockIds.map(id => Number(id.slice(1))), rationale: '表达家庭出游规划', subject: 'A family', action: 'walking together', environment: 'a public park', composition: 'wide shot', lighting: 'daylight', colors: 'natural', style: 'editorial photography', details: 'Natural expressions', avoid: 'No logos or text', prompt: 'A family walking together in a park in daylight, wide editorial photograph.', ratio: '16:9', blockIds: expected.blockIds, assetIds: expected.assetIds, afterBlockId: expected.blockIds.at(-1), informationGoal: '家庭共同活动', visualMode: 'conceptual' }],
    shortfall: { requested: 3, actual: 1, reason: '当前内容只能支持一个有区别的场景' } }
}

it('captures rich content, runs isolated analysis, preserves edits and ends at human prompt review', async () => {
  const screenshots = await mkdtemp(join(tmpdir(), 'article-image-ui-evidence-'))
  console.log(`Article workbench browser evidence: ${screenshots}`)
  const image = originalPng(), requested: string[] = []
  const source = createServer((request, response) => {
    requested.push(request.url ?? '')
    if (request.url === '/captions.vtt') { response.writeHead(200, { 'content-type': 'text/vtt' }); response.end('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nPublished advice: allow time for breaks.\n'); return }
    if (request.url === '/original.png' || request.url === '/poster.png') { response.writeHead(200, { 'content-type': 'image/png' }); response.end(image); return }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    const markup = '<html lang="en"><head><title>Family travel guide</title></head><body><nav>Fixture navigation</nav><article id="story"><h1>Family travel guide</h1><p>Families plan <strong>outdoor activities</strong> and regular rest breaks. <a href="https://example.com/evidence">Evidence link</a> <a href="javascript:alert(1)">Unsafe link</a></p><h2>Planning details</h2><ul><li>Choose activities<ul><li>Allow time to rest</li></ul></li></ul><blockquote>Plan for a relaxed pace.</blockquote><table><tr><th>Activity</th><th>Breaks</th></tr><tr><td>Walking</td><td>Regular</td></tr></table><figure><img src="/original.png" alt="Fixture original"><figcaption>Original illustration <span class="credit">Fixture editor</span></figcaption></figure><div id="tail" aria-busy="true"></div><aside>Fixture recommendations</aside></article><footer>Fixture footer</footer><script>window.__articleSourceScript=true;setTimeout(()=>{document.querySelector(\'#tail\').innerHTML=\'<p id="end">Complete article ending: take regular breaks.</p>\';document.querySelector(\'#tail\').removeAttribute(\'aria-busy\')},25)</script></body></html>'
    const declared = markup.replace('</head>', `<link rel="canonical" href="${request.url}"></head>`)
    const metadata = declared.replace('alt="Fixture original"', '').replace('</head>', '<script>window.__articleImages={canonical:"/captioned",images:[{type:"image",url:"/original.png",alt:"Fixture original"}]}</script></head>')
    response.end(request.url === '/static' ? declared.replace('<div id="tail" aria-busy="true"></div>', '<p id="end">Complete article ending: take regular breaks.</p>')
      : (request.url === '/captioned' ? metadata : declared).replace('<figure>', request.url === '/captioned' ? '<div class="fixture-player"><video style="visibility:hidden"></video></div><script>window.__articleCaptionData={canonical:"/captioned",tracks:[{format:"WEB_VTT",url:"/captions.vtt"}],poster:{url:"/poster.png",title:"Fixture original"}}</script><figure>' : '<figure>'))
  })
  source.listen(0, '127.0.0.1'); await once(source, 'listening')
  onTestFinished(async () => {
    source.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      source.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    expect(source.listening).toBe(false)
  })
  const address = source.address()
  if (!address || typeof address === 'string') throw new Error('Fixture requires an allocated TCP address')
  const origin = `http://127.0.0.1:${address.port}`
  const scaffold = await launchWebScaffold({ profile: { packages: [], bundles: [PACKAGE] }, extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)) })
  onTestFinished(() => scaffold.close())
  const service = scaffold.ctx.get('articleImage') as ArticleHarness
  expect(service).toBeDefined()
  const pluginRequire = createRequire(new URL('../../../custom-plugins/workspace/dsh-plugin-article-image/package.json', import.meta.url))
  const { createCapture } = pluginRequire('article-image-toolkit/capture') as { createCapture: (config: object, dependencies: object) => Capture }
  await service.capture.dispose()
  service.capture = createCapture({ ...service.config.capture, minArticleChars: 1, renderWaitMs: 1000, scrollWaitMs: 25,
    imageMetadataSources: [{ hosts: ['127.0.0.1'], globalPath: ['__articleImages'], identityPath: ['canonical'], itemsPath: ['images'], typeKey: 'type', typeValue: 'image', sourcePath: ['url'], altPath: ['alt'] }],
    adapters: [{ id: 'article-ui-fixture', hosts: ['127.0.0.1'], articleSelector: '#story', endSelector: '#end', expectedMinImages: 1, captionSources: [{ selector: 'video track', hosts: ['127.0.0.1'], metadata: { globalPath: ['__articleCaptionData'], identityPath: ['canonical'], tracksPath: ['tracks'], formatKey: 'format', formatValue: 'WEB_VTT', urlKey: 'url', anchorSelector: '.fixture-player', language: 'en', poster: { urlPath: ['poster', 'url'], titlePath: ['poster', 'title'], hosts: ['127.0.0.1'] } } }] }] },
  { networkPolicy: async (url: URL) => {
    if (url.origin !== origin) throw Object.assign(new Error('article-url-blocked'), { code: 'article-url-blocked' })
    return [{ address: '127.0.0.1', family: 4 }]
  } })
  const captionSource = (await service.capture.capture(`${origin}/captioned`)).snapshot
  expect(captionSource.blocks.find(block => block.type === 'figure')?.alt).toBe('Fixture original')
  expect(captionSource.quality.checks).toContain('published-image-descriptions')
  await service.capture.dispose()
  service.capture = createCapture({ ...service.config.capture, minArticleChars: 1, renderWaitMs: 1000, scrollWaitMs: 25,
    adapters: [{ id: 'article-ui-fixture', hosts: ['127.0.0.1'], pathPrefixes: ['/static', '/article'], articleSelector: '#story', endSelector: '#end', expectedMinImages: 1, excludeSelector: 'aside',
      static: { startSelector: 'h1', endSelector: '#end', requiredSelectors: ['ul li', 'table', 'figure img'] }, browserResources: { deferTypes: ['image', 'font', 'media'] } }] },
  { networkPolicy: async (url: URL) => {
    if (url.origin !== origin) throw Object.assign(new Error('article-url-blocked'), { code: 'article-url-blocked' })
    return [{ address: '127.0.0.1', family: 4 }]
  } })
  const staticSource = (await service.capture.capture(`${origin}/static`)).snapshot
  expect(staticSource.quality.checks).toContain('static-site-verified')
  expect(requested.filter(path => path === '/static')).toHaveLength(1)
  const outsideSource = (await service.capture.capture(`${origin}/outside`)).snapshot
  expect(outsideSource.quality.reasons).toContain('unknown-article-scope')
  expect(outsideSource.quality.reasons).not.toContain('adapter-article-scope')
  expect(requested.filter(path => path === '/outside')).toHaveLength(1)
  service.download = async () => `Category,Links,语言,备注\nTravel,${origin}/article,en,\n`
  await service.importSource({ url: 'https://docs.google.com/spreadsheets/d/article-fixture/edit#gid=0' })
  const id = (await service.list({})).items[0]!.id
  service.config.analysis = { ...service.config.analysis, enabled: true, provider: 'article-fixture', model: 'fixture' }

  const { LlmAdapter } = requireBuilt('@deepseek-ai/dsh-llm') as typeof import('@deepseek-ai/dsh-llm')
  const requests: { task: string; tools: string[]; images: number; submitted: boolean }[] = []
  let held = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>(), pause = true, sequence = 0
  class RecordedArticleAdapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 128000 }, inputModalities: ['text', 'image'] as ('text' | 'image')[] } }
    override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      const text = options.messages.filter(message => message.role === 'user').flatMap(message => message.content).toReversed().find(block => block.type === 'text' && block.text.startsWith('{"task":'))
      if (!text || text.type !== 'text') throw new Error('Expected logged analysis task')
      const task = JSON.parse(text.text) as { task: string; attemptId: string; inputHash: string; expectedCoverage: Coverage }
      const submitted = options.messages.at(-1)?.role === 'tool'
      requests.push({ task: task.task, tools: options.tools?.map(tool => tool.name) ?? [], images: options.messages.flatMap(message => message.content).filter(block => block.type === 'image').length, submitted })
      if (submitted) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Submitted article analysis for human review.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Submitted article analysis for human review.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
      if (pause) {
        pause = false; entered.resolve(undefined)
        let abort: (() => void) | undefined
        try {
          await Promise.race([held.promise, new Promise<never>((_resolve, reject) => {
            abort = () => {
              const reason: unknown = options.signal?.reason
              reject(reason instanceof Error ? reason : new Error('Cancelled'))
            }
            options.signal?.addEventListener('abort', abort, { once: true })
            if (options.signal?.aborted) abort()
          })])
        }
        finally { if (abort) options.signal?.removeEventListener('abort', abort) }
      }
      options.signal?.throwIfAborted()
      const result = task.task === 'plan' ? planned(task.expectedCoverage) : understood(task.expectedCoverage)
      const block = { type: 'tool-call' as const, id: ToolCallId(`article-submit-${++sequence}`), name: 'article_image_submit_analysis', arguments: JSON.stringify({ stageId: task.task, attemptId: task.attemptId, inputHash: task.inputHash, result }) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  scaffold.ctx.llm.registerAdapter(['article-fixture'], new RecordedArticleAdapter())
  await scaffold.ctx.llm.resolveModelInfo('article-fixture', 'fixture')
  await scaffold.ctx.llm.resolveCallConfig({ provider: 'article-fixture', model: 'fixture', maxTokens: 6000 })
  expect((await service.status()).analysis).toMatchObject({ available: true })
  const browser = await chromium.launch(); onTestFinished(async () => { await browser.close(); expect(browser.isConnected()).toBe(false) })
  let page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 960 } })
  const tripwires = [watchConsole(page)], sideEffects: string[] = []
  const watchRequests = () => page.on('request', (request) => { if (/\/article-image\/(?:generate|publish|upload|writeback)(?:\b|\/)/.test(new URL(request.url()).pathname)) sideEffects.push(request.url()) })
  watchRequests()
  const openWorkbench = async () => {
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: '文章生图', exact: true }).click()
    await page.getByRole('heading', { name: '文章生图工作台' }).waitFor()
  }
  await openWorkbench()
  expect(requests).toHaveLength(0)
  await page.getByRole('button', { name: '导入文章', exact: true }).click()
  const importDialog = page.getByRole('dialog', { name: 'Google 表格来源与列映射', exact: true })
  await importDialog.getByLabel('表格链接', { exact: true }).fill('https://example.com/invalid-sheet')
  await importDialog.getByRole('button', { name: '导入文章', exact: true }).click()
  await importDialog.getByText('请输入有效的 Google 表格链接', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await expect.poll(() => importDialog.count()).toBe(0)
  await page.getByLabel('搜索当前页文章').fill('unmatched title')
  await page.getByText('没有匹配文章，试试其他关键词', { exact: true }).waitFor()
  await page.getByRole('button', { name: '收起文章任务', exact: true }).click()
  await expect.poll(() => page.locator('.ai-queue').evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(56)
  expect(await page.locator('.ai-queue-content').getAttribute('inert')).not.toBeNull()
  await page.getByRole('button', { name: '展开文章任务', exact: true }).click()
  expect(await page.getByLabel('搜索当前页文章').inputValue()).toBe('unmatched title')
  await page.getByLabel('搜索当前页文章').fill('')
  await page.getByRole('button', { name: '补充正文', exact: true }).click()
  const manualDialog = page.getByRole('dialog', { name: '补充正文', exact: true })
  await manualDialog.getByLabel('完整正文', { exact: true }).fill('An unsaved manual draft.')
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: '还有未保存的内容', exact: true }).waitFor()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  expect(await manualDialog.getByLabel('完整正文', { exact: true }).inputValue()).toBe('An unsaved manual draft.')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect.poll(() => manualDialog.count()).toBe(0)
  await page.getByRole('button', { name: '获取并分析', exact: true }).click()
  await expect.poll(async () => {
    const item = await service.detail(id)
    return { stage: item.run?.stage, state: item.state, error: item.error }
  }, { timeout: 20000 }).toEqual({ stage: 'understanding', state: 'understanding', error: null })
  await expect.poll(async () => ({
    requested: requests.length > 0,
    error: (await service.detail(id)).error,
  }), { timeout: 20000 }).toEqual({ requested: true, error: null })
  await entered.promise
  await page.getByRole('button', { name: '停止', exact: true }).waitFor()
  expect(await page.locator('.ai-workflow-progress,.ai-processing-workspace').count()).toBe(0)
  expect(await page.locator('.ai-run-diagnostics').count()).toBe(0)
  await page.locator('.ai-rich-article').waitFor()
  expect(await page.locator('#article-image-detail-article-panel').getAttribute('aria-busy')).toBe('false')
  await page.screenshot({ path: join(screenshots, 'active-progress.png') })
  await page.getByRole('tab', { name: '理解与提示词', exact: true }).click()
  await page.locator('.ai-retrieving .ai-illustration').waitFor()
  expect(await page.locator('.ai-editor').evaluate(element => getComputedStyle(element).animationName)).toBe('none')
  await expect.poll(() => page.locator('.ai-retrieving h3').textContent(), { timeout: 10000 }).toBe('理解文章内容')
  await page.screenshot({ path: join(screenshots, 'active-waiting.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.locator('.article-image-workbench').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  await page.locator('.ai-retrieving').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(screenshots, 'active-waiting-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('tab', { name: '运行诊断', exact: true }).click()
  await page.locator('.ai-elapsed time').waitFor()
  const elapsedBefore = await page.locator('.ai-elapsed time').textContent()
  await expect.poll(() => page.locator('.ai-elapsed time').textContent()).not.toBe(elapsedBefore)
  await page.getByRole('tab', { name: '运行日志', exact: true }).click()
  await page.getByText('已收到网页文档', { exact: true }).waitFor()
  expect(await page.locator('.ai-run-events').textContent()).toContain('HTTP: 200')
  await page.screenshot({ path: join(screenshots, 'active-diagnostics.png') })
  await page.getByRole('tab', { name: 'Debug 数据', exact: true }).click()
  expect(await page.getByRole('tabpanel', { name: 'Debug 数据', exact: true }).textContent()).toContain('document-loaded')
  await page.screenshot({ path: join(screenshots, 'active-debug.png') })
  await page.getByRole('tab', { name: 'Debug 数据', exact: true }).focus()
  await page.keyboard.press('ArrowLeft')
  expect(await page.getByRole('tab', { name: '运行日志', exact: true }).getAttribute('aria-selected')).toBe('true')
  expect((await service.detail(id)).run.stage).toBe('understanding')
  const modelCallsBeforeClose = requests.length
  await page.close()
  expect((await service.detail(id)).run.status).toBe('running')
  page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 960 } }); tripwires.push(watchConsole(page)); watchRequests()
  await openWorkbench()
  await page.getByRole('button', { name: '停止', exact: true }).waitFor()
  expect(requests).toHaveLength(modelCallsBeforeClose)
  held.resolve(undefined)
  await expect.poll(async () => { const item = await service.detail(id); return { state: item.state, error: item.error } }, { timeout: 20000 }).toEqual({ state: 'review', error: null })
  await page.getByLabel('文章主题', { exact: true }).waitFor()
  expect(await page.getByLabel('文章主题', { exact: true }).inputValue()).toBe('家庭旅行')
  expect(requests.every(request => request.tools.length === 1 && request.tools[0] === 'article_image_submit_analysis')).toBe(true)
  expect(requests.some(request => request.images === 1)).toBe(true)
  expect((await service.detail(id)).analysis.input.images).toHaveLength(1)
  expect((await scaffold.ctx.skills.list()).filter(skill => skill.name.startsWith('article-image-'))).toHaveLength(2)
  const plannedDetail = await service.detail(id)
  expect({ blocks: plannedDetail.snapshot.blocks.map(block => block.type), quality: plannedDetail.snapshot.quality,
    staticSource: { checks: staticSource.quality.checks, blocks: staticSource.blocks.map(block => block.type), singleDocumentRequest: requested.filter(path => path === '/static').length === 1 },
    outsideTemplate: { singleBrowserRequest: requested.filter(path => path === '/outside').length === 1, genericScope: outsideSource.quality.reasons.includes('unknown-article-scope'), noFalsePartial: outsideSource.quality.status !== 'partial' },
    captionSource: { publishedImageDescription: captionSource.blocks.find(block => block.type === 'figure')?.alt, posterOccurrences: captionSource.blocks.filter(block => block.type === 'figure').length, timedText: captionSource.blocks.some(block => block.inline?.some(run => run.text.includes('00:00:01.000–00:00:03.000 Published advice'))), sourceLink: captionSource.blocks.some(block => block.inline?.some(run => run.href === `${origin}/captions.vtt`)), capturedCues: captionSource.quality.checks.filter(check => check.startsWith('caption-track:')), remainsPartial: captionSource.quality.status === 'partial' },
    captureDiagnostics: { occurrenceTimes: plannedDetail.run.events.every(event => Number.isFinite(Date.parse(event.at))), imageTiming: plannedDetail.run.events.some(event => event.event === 'assets' && typeof event.details.downloadMs === 'number' && typeof event.details.decodeMs === 'number'), staticFallback: plannedDetail.run.events.some(event => event.event === 'static-fallback'), resourceDeferred: plannedDetail.run.events.some(event => event.event === 'resource-deferred') },
    stages: requests.filter(request => !request.submitted).map(({ task, tools, images }) => ({ task, tools, images })),
    plan: { theme: plannedDetail.plan.brief.theme, prompt: plannedDetail.plan.shots[0]!.prompt },
  }).toMatchSnapshot()

  await page.getByRole('button', { name: '定位原文块 b2', exact: true }).first().click()
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('article-image-block-b2')
  expect(await page.locator('.ai-rich-article strong').textContent()).toBe('outdoor activities')
  expect(await page.locator('.ai-rich-article table').count()).toBe(1)
  expect(await page.locator('.ai-rich-article ul ul').count()).toBe(1)
  expect(await page.locator('.ai-rich-article').textContent()).not.toMatch(/Fixture navigation|Fixture recommendations|Fixture footer/)
  expect(await page.locator('.ai-rich-article script,.ai-rich-article [onclick],.ai-rich-article a[href^="javascript:"]').count()).toBe(0)
  expect(await page.evaluate(() => '__articleSourceScript' in window)).toBe(false)
  const asset = plannedDetail.snapshot.assets[0]!, assetPath = `/api/article-image/asset?snapshot=${plannedDetail.snapshot.id}&asset=${asset.id}`
  const assetResponse = await scaffold.hostFetch(assetPath)
  expect(assetResponse.status).toBe(200); expect(assetResponse.headers.get('content-type')).toBe('image/png')
  expect(Buffer.from(await assetResponse.arrayBuffer())).toEqual(image)
  expect((await scaffold.hostFetch(`/api/article-image/asset?snapshot=../../private&asset=${asset.id}`)).status).toBe(404)
  expect((await fetch(new URL(assetPath, scaffold.baseUrl))).status).not.toBe(200)
  await page.getByRole('button', { name: '查看原图', exact: true }).click()
  await page.getByRole('dialog', { name: '查看原图', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await expect.poll(() => page.getByRole('dialog', { name: '查看原图', exact: true }).count()).toBe(0)
  await page.getByRole('tab', { name: '理解与提示词' }).click()
  await page.getByRole('button', { name: '审核通过', exact: true }).click()
  await expect.poll(async () => (await service.detail(id)).state).toBe('approved')
  await page.getByRole('button', { name: '画面设定与约束', exact: true }).click()
  await page.getByLabel('主体', { exact: true }).fill('A family resting beside a trail')
  await page.getByRole('button', { name: '插件', exact: true }).click()
  await page.locator('[data-plugin-package="dsh-plugin-article-image"]').waitFor()
  await page.getByRole('button', { name: '文章生图', exact: true }).click()
  await page.getByRole('heading', { name: '文章生图工作台' }).waitFor()
  expect(await page.getByLabel('主体', { exact: true }).inputValue()).toBe('A family resting beside a trail')
  await page.getByText('场景或理解概要已修改，请重新编写提示词并核对其与当前方案一致', { exact: true }).waitFor()
  expect(await page.getByRole('button', { name: '审核通过', exact: true }).isDisabled()).toBe(true)
  await page.getByLabel('最终英文提示词', { exact: true }).fill('A family resting beside a trail in natural daylight, wide editorial photograph.')
  await page.getByRole('button', { name: '确认提示词已同步', exact: true }).click()
  await page.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect.poll(async () => (await service.detail(id)).plan.shots[0]!.subject).toBe('A family resting beside a trail')
  expect((await service.detail(id)).approval).toBeNull()
  await expect.poll(() => page.getByRole('button', { name: '审核通过', exact: true }).isEnabled()).toBe(true)
  await page.getByRole('button', { name: '审核通过', exact: true }).focus(); await page.keyboard.press('Enter')
  await expect.poll(async () => (await service.detail(id)).state).toBe('approved')
  await page.getByRole('tab', { name: '审核结果' }).click()
  await page.getByRole('heading', { name: '配图提示词已审核', exact: true }).waitFor()
  expect(await page.getByRole('button', { name: '生成图片', exact: true }).count()).toBe(0)
  expect((await service.status()).generation.available).toBe(false)

  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await page.getByRole('tab', { name: '文章正文', exact: true }).click()
    await page.screenshot({ path: join(screenshots, `${colorScheme}-article.png`) })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => page.locator('.article-image-workbench').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await page.getByRole('tab', { name: '理解与提示词' }).click()
    await page.getByRole('button', { name: '审核通过', exact: true }).scrollIntoViewIfNeeded()
    expect(await page.getByRole('button', { name: '审核通过', exact: true }).isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: '审核通过', exact: true }).evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth
    })).toBe(true)
    expect(await page.locator('.ai-layout').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    await page.screenshot({ path: join(screenshots, `${colorScheme}-narrow.png`) })
    await page.setViewportSize({ width: 1440, height: 960 })
  }
  held = Promise.withResolvers<undefined>(); entered = Promise.withResolvers<undefined>(); pause = true
  const callsBeforeRestart = requests.length
  await page.getByRole('button', { name: '重新获取并分析', exact: true }).click()
  await expect.poll(async () => {
    const item = await service.detail(id)
    return {
      state: item.state, stage: item.run.stage, error: item.error,
      requested: requests.length > callsBeforeRestart, quality: item.snapshot.quality.status,
    }
  }, { timeout: 20000 }).toEqual({ state: 'understanding', stage: 'understanding', error: null, requested: true, quality: plannedDetail.snapshot.quality.status })
  await entered.promise
  await page.getByRole('button', { name: '停止', exact: true }).waitFor()
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect.poll(async () => (await service.detail(id)).run.status).toBe('cancelled')
  const stoppedCalls = requests.length
  expect((await service.detail(id)).approval).toBeNull()
  await page.getByRole('button', { name: '恢复任务', exact: true }).click()
  await expect.poll(async () => (await service.detail(id)).state, { timeout: 20000 }).toBe('review')
  expect(requests.length).toBeGreaterThan(stoppedCalls)
  expect(requested).toContain('/original.png')
  expect(sideEffects).toEqual([])
  expect(tripwires.flatMap(tripwire => tripwire.pageErrors)).toEqual([])
  service.capture.capture = async () => { throw Object.assign(new Error('article-restricted'), { code: 'article-restricted' }) }
  await page.getByRole('tab', { name: '文章正文', exact: true }).click()
  await page.getByRole('button', { name: '重新获取并分析', exact: true }).click()
  await expect.poll(async () => (await service.detail(id)).state).toBe('failed')
  await page.locator('.ai-fetch-notice[role="alert"]').waitFor()
  expect(await page.locator('.ai-workflow-progress,.ai-processing-workspace').count()).toBe(0)
  expect(await page.getByRole('button', { name: '恢复任务', exact: true }).isEnabled()).toBe(true)
  await page.screenshot({ path: join(screenshots, 'restored-failure.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.locator('.article-image-workbench').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: join(screenshots, 'restored-failure-narrow.png') })
  await page.getByRole('tab', { name: '运行诊断', exact: true }).click()
  await page.getByRole('tab', { name: 'Debug 数据', exact: true }).click()
  expect(await page.getByRole('tabpanel', { name: 'Debug 数据', exact: true }).textContent()).toContain('article-restricted')
  await scaffold.ctx.pluginManager.setBundleEnabled(PACKAGE, false)
  await expect.poll(() => page.getByRole('button', { name: '文章生图', exact: true }).count()).toBe(0)
  expect((await scaffold.ctx.skills.list()).some(skill => skill.name.startsWith('article-image-'))).toBe(false)
})
