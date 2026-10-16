/** Built-in article planning through the real Loader, Agent loop, Remote and Client. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { requireBuilt, ZH_BROWSER_LOCALE } from './support.ts'

const PACKAGE = 'dsh-plugin-article-image'
const TEXT = 'Families can enjoy a relaxed trip together. Parents plan outdoor activities and rest breaks for children. '.repeat(7)
interface ArticleHarness {
  download: () => Promise<string>
  importSource(input: { url: string }): Promise<unknown>
  list(input: object): Promise<{ items: { id: string }[] }>
  fetchArticle(id: string, signal: AbortSignal): Promise<unknown>
  detail(id: string): Promise<{ id: string; revision: number; article: { hash: string }; state: string }>
}

it('replays article reads and prompt saves, reviews in the workbench and removes disabled contributions', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [], bundles: [PACKAGE] },
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)) })
  const browser = await chromium.launch()
  try {
    const service = scaffold.ctx.get('articleImage') as ArticleHarness
    expect(service).toBeDefined()
    service.download = async () => 'Category,Links,语言,备注\nTravel,https://example.com/family-travel,pt,\n'
    await service.importSource({ url: 'https://docs.google.com/spreadsheets/d/article-fixture/edit#gid=0' })
    const id = (await service.list({})).items[0]!.id
    const fetch = vi.spyOn(scaffold.ctx.web, 'fetch').mockResolvedValue({ url: 'https://example.com/family-travel', statusCode: 200,
      truncated: false, body: { kind: 'text', content: TEXT } })
    const fetchedTime = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-10-16T00:00:00.000Z')
    try { await service.fetchArticle(id, new AbortController().signal) } finally { fetchedTime.mockRestore() }
    fetch.mockRestore()
    const detail = await service.detail(id)
    const plan = { sourceHash: detail.article.hash, brief: { theme: '家庭旅行', facts: ['Parents plan rest breaks'], subjects: ['Family'], scenes: ['A family walking in a park'] },
      shots: [{ purpose: 'cover', paragraphs: [1], rationale: 'Illustrates a relaxed family trip', subject: 'Family', action: 'Walking together', environment: 'Public park', composition: 'Wide shot',
        lighting: 'Natural daylight', colors: 'Natural greens', style: 'Realistic editorial photography', details: 'Natural expressions', avoid: 'No text or invented event claims',
        prompt: 'Realistic editorial photograph of a family walking in a public park in natural daylight.', ratio: '16:9' }] }
    const script = [
      { name: 'article_image_article', args: { id, sourceHash: detail.article.hash, offset: 0 } },
      { name: 'article_image_save_plan', args: { id, revision: detail.revision, plan } },
      { name: 'article_image_report', args: { id } },
    ]
    const { LlmAdapter, createUserMessage } = requireBuilt('@deepseek-ai/dsh-llm') as typeof import('@deepseek-ai/dsh-llm')
    class RecordedArticleAdapter extends LlmAdapter {
      index = 0
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
      override async *stream(): AsyncGenerator<StreamChunk> {
        const call = script[this.index++]
        if (call) {
          const block = { type: 'tool-call' as const, id: ToolCallId(`article-call-${this.index}`), name: call.name, arguments: JSON.stringify(call.args) }
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
          yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'Saved a cover prompt for review; no image generated.' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Saved a cover prompt for review; no image generated.' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    scaffold.ctx.llm.registerAdapter(['article-fixture'], new RecordedArticleAdapter())
    const agent = await scaffold.ctx.agentLoop.create(SessionId('article-image-fixture'), { provider: 'article-fixture', model: 'fixture' }, { cwd: scaffold.workspaceCwd })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read this article and save an editorial cover plan for review.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const results = events.filter(event => event.type === 'tool/result').map(event => event.data)
    expect(results).toHaveLength(3)
    expect(results.every(result => !result.message.isError)).toBe(true)
    expect({ calls: events.filter(event => event.type === 'tool/call').map(event => ({ name: event.data.name, arguments: event.data.arguments })),
      results: results.map(result => result.message.content),
    }).toMatchSnapshot()
    expect((await service.detail(id)).state).toBe('review')
    expect((await scaffold.ctx.skills.list()).filter(skill => skill.name.startsWith('article-image-'))).toHaveLength(2)

    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 960 } })
    const console = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: '文章生图', exact: true }).click()
    await page.getByRole('heading', { name: '文章生图工作台' }).waitFor()
    expect(await page.locator('.ai-heading').evaluate(element => element.getBoundingClientRect().height)).toBe(43)
    await page.getByRole('button', { name: '导入文章', exact: true }).click()
    const sourceDialog = page.getByRole('dialog', { name: 'Google 表格来源与列映射' })
    await sourceDialog.waitFor()
    await sourceDialog.getByLabel('文章链接列', { exact: true }).click()
    expect(await sourceDialog.getByLabel('文章链接列', { exact: true }).evaluate(element => ({
      outline: getComputedStyle(element).outlineStyle,
      height: element.parentElement!.getBoundingClientRect().height,
      contained: element.getBoundingClientRect().right <= element.parentElement!.getBoundingClientRect().right,
    }))).toEqual({ outline: 'none', height: 36, contained: true })
    expect(await sourceDialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await sourceDialog.getByLabel('表格链接', { exact: true }).fill('https://example.com/invalid-sheet')
    await sourceDialog.getByRole('button', { name: '导入文章', exact: true }).click()
    await sourceDialog.getByRole('alert').waitFor()
    expect(await sourceDialog.getByRole('alert').textContent()).toBe('请输入有效的 Google 表格链接')
    await page.keyboard.press('Escape')
    await expect.poll(() => sourceDialog.count()).toBe(0)
    await page.getByLabel('搜索当前页文章').fill('unmatched title')
    await page.getByText('没有匹配文章，试试其他关键词').waitFor()
    await page.getByRole('button', { name: '收起文章任务', exact: true }).click()
    await expect.poll(() => page.locator('.ai-queue').evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(56)
    expect(await page.locator('.ai-queue-content').getAttribute('inert')).not.toBeNull()
    await page.getByRole('button', { name: '展开文章任务', exact: true }).click()
    expect(await page.getByLabel('搜索当前页文章').inputValue()).toBe('unmatched title')
    await page.getByLabel('搜索当前页文章').fill('')
    await page.locator('.ai-queue .ai-dropdown').click()
    await page.getByRole('menuitem', { name: 'Travel', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '补充正文', exact: true }).click()
    const manualDialog = page.getByRole('dialog', { name: '补充正文', exact: true })
    await manualDialog.waitFor()
    await page.keyboard.press('Escape')
    await expect.poll(() => manualDialog.count()).toBe(0)
    await page.getByRole('button', { name: '补充正文', exact: true }).click()
    await manualDialog.waitFor()
    await manualDialog.getByLabel('完整正文', { exact: true }).fill('An unsaved manual draft.')
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '还有未保存的内容' }).waitFor()
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    expect(await manualDialog.getByLabel('完整正文', { exact: true }).inputValue()).toBe('An unsaved manual draft.')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '放弃修改', exact: true }).click()
    await expect.poll(() => manualDialog.count()).toBe(0)
    await page.getByRole('tab', { name: '理解与提示词' }).click()
    await page.getByLabel('文章主题', { exact: true }).waitFor()
    expect(await page.getByLabel('文章主题', { exact: true }).inputValue()).toBe('家庭旅行')
    await page.getByRole('button', { name: '审核通过', exact: true }).click()
    await expect.poll(async () => (await service.detail(id)).state).toBe('approved')
    await page.getByLabel('最终英文提示词').fill('A revised realistic photograph of a family walking outdoors in soft daylight.')
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect.poll(async () => (await service.detail(id)).state).toBe('review')
    await page.getByRole('tab', { name: '图片结果' }).click()
    expect(await page.getByRole('button', { name: '生成图片', exact: true }).isDisabled()).toBe(true)
    await page.setViewportSize({ width: 700, height: 850 })
    expect(await page.locator('.article-image-workbench').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.locator('.article-image-workbench').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.getByRole('button', { name: '导入文章', exact: true }).click()
    await sourceDialog.waitFor()
    expect(await sourceDialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await sourceDialog.locator('.ai-mappings').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1)
    await page.keyboard.press('Escape')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await page.locator('.ai-layout').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const pendingPage = Promise.withResolvers<Awaited<ReturnType<typeof scaffold.ctx.web.fetch>>>()
    const retrieving = vi.spyOn(scaffold.ctx.web, 'fetch').mockImplementation(() => pendingPage.promise)
    try {
      await page.getByRole('tab', { name: '文章正文', exact: true }).click()
      await page.getByRole('button', { name: '抓取正文', exact: true }).click()
      await page.locator('.ai-retrieving').waitFor()
      expect(await page.locator('.ai-jobs').count()).toBe(0)
      expect(await page.locator('.ai-illustration[data-animated="true"] .ai-art-front').evaluate(element => getComputedStyle(element).animationName)).toBe('article-image-picture')
      await page.screenshot({ path: '.artifacts/article-image-fetch-animation.png' })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      expect(await page.locator('.ai-illustration[data-animated="true"] .ai-art-front').evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    } finally {
      pendingPage.resolve({ url: 'https://example.com/family-travel', statusCode: 200, truncated: false, body: { kind: 'text', content: TEXT } })
      await expect.poll(async () => (await service.detail(id)).state).not.toBe('fetching')
      retrieving.mockRestore()
    }
    expect(console.pageErrors).toEqual([])
    await scaffold.ctx.pluginManager.setBundleEnabled(PACKAGE, false)
    await expect.poll(() => page.getByRole('button', { name: '文章生图', exact: true }).count()).toBe(0)
    expect((await scaffold.ctx.skills.list()).some(skill => skill.name.startsWith('article-image-'))).toBe(false)
  } finally { await browser.close(); await scaffold.close() }
})
