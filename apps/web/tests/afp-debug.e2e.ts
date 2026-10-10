/** Keyless AFP diagnostics through the shipped Web composition, real jobs and authenticated browser reads. */
import { fileURLToPath } from 'node:url'
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { launchWebScaffold, seedSession, watchConsole, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import { expandTurnProcesses, ZH_BROWSER_LOCALE } from './support.ts'

it('exports a failed AFP run without secrets and exposes the debug configuration switch', async () => {
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: fileURLToPath(new URL('../../../custom-plugins/workspace/dsh-plugin-afp/', import.meta.url)), enabled: true }] },
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  const browser = await chromium.launch()
  try {
    // This isolated profile has no AFP credentials: connection fails locally before any provider request.
    const result = await scaffold.ctx.pluginManager.invokeAction('dsh-plugin-afp', 'workbench',
      { operation: 'refresh', args: JSON.stringify({ categories: ['food'], targetPerCategory: 1 }) }, new AbortController().signal)
    const handle: unknown = JSON.parse(result.output)
    assert(handle && typeof handle === 'object' && 'runId' in handle && 'jobId' in handle)
    assert(typeof handle.runId === 'string' && typeof handle.jobId === 'string')
    const jobs = scaffold.ctx.jobs.list()
    const admitted = jobs.find(job => job.id === handle.jobId)
    expect(admitted).toBeDefined()
    if (!admitted) throw new Error('AFP fixture job was not admitted')
    expect((await scaffold.ctx.jobs.wait(admitted.id, 5000)).status).toBe('failed')
    // 本地历史夹具不配置凭据，也不调用远端写入；分别覆盖计划、已执行和缺失的执行结果。
    const profiles = join(scaffold.harnessHome, '.plugins', 'dsh-plugin-afp', 'profiles')
    const owners = (await readdir(profiles)).filter(name => /^[a-f0-9]{64}$/.test(name))
    const profileOwner = owners[0]
    if (owners.length !== 1 || !profileOwner) throw new Error('Expected one AFP test profile')
    const plan = { schema: 1, owner: 'fixture-session', account: 'fixture-account', remoteHash: 'fixture-only',
      operation: 'append', expiresAt: Date.now() + 60000, state: 'completed', createdAt: 1791540000000,
      targets: [{ category: 'food', name: 'AutoFlow_食物', id: 'fixture-food', existing: 2, docs: [{ id: 'one' }, { id: 'two' }] }],
      result: { status: 'completed', categories: [{ category: 'food', status: 'completed', removed: 0, added: 1 }] } }
    const history = [
      { ...plan, id: '4a8b7032-fc24-4a8c-85fb-6c3a3c108b90' },
      { ...plan, id: '4a8b7032-fc24-4a8c-85fb-6c3a3c108b91', state: 'planned', result: undefined },
      { ...plan, id: '4a8b7032-fc24-4a8c-85fb-6c3a3c108b92', state: 'failed', result: { status: 'failed', categories: [] } },
    ]
    const planDirectory = join(profiles, profileOwner, 'plans')
    await mkdir(planDirectory, { recursive: true })
    for (const item of history) await writeFile(join(planDirectory, `${item.id}.json`), JSON.stringify(item) + '\n', 'utf8')
    const reviewRun = { schema: 1, id: '4a8b7032-fc24-4a8c-85fb-6c3a3c108b93', categories: ['food'], settings: { targetPerCategory: 1 },
      status: 'paused', createdAt: 50, pending: { category: 'food', candidates: [{ id: 'review-pending', title: '等待判断夹具' }] },
      groups: { food: { batches: 1, candidates: [{ id: 'review-kept', title: '通过图片夹具' },
        { id: 'review-rejected', title: '未通过图片夹具' }, { id: 'review-failed', title: '请求失败夹具' }] } },
      decisions: [{ id: 'review-kept', category: 'food', keep: true, confidence: .95, reason: '通过原因夹具' },
        { id: 'review-rejected', category: 'food', keep: false, confidence: .3, reason: '未通过原因夹具' },
        { id: 'review-failed', category: 'food', keep: false, confidence: null, reason: 'preview or vision request failed' }] }
    const runDirectory = join(profiles, profileOwner, 'runs')
    await writeFile(join(runDirectory, `${reviewRun.id}.json`), JSON.stringify(reviewRun) + '\n', 'utf8')
    const downloadDirectory = join(profiles, profileOwner, 'downloads')
    await mkdir(downloadDirectory, { recursive: true })
    const downloadRecord = { schema: 1, id: '4a8b7032-fc24-4a8c-85fb-6c3a3c108b95', createdAt: 1791540000000,
      updatedAt: 1791540000000, status: 'completed', total: 9, completed: 9, failed: 0, pending: 0,
      items: Array.from({ length: 9 }, (_, index) => ({ photoId: `download-${index}`, title: `图片 ${index + 1}`,
        rendition: 'preview', fileName: `fixture-${index + 1}.jpg`, status: 'completed', errorCode: null })) }
    await writeFile(join(downloadDirectory, `${downloadRecord.id}.json`), JSON.stringify(downloadRecord) + '\n', 'utf8')
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const previewFixture = await readFile(fileURLToPath(new URL('../public/assets/plugin-bundle-hero.jpg', import.meta.url)))
    // 审阅使用本地栅格和详情夹具；真实认证、报告读取、选择与确认入口仍走应用路径。
    await page.route('**/api/afp/preview?*', route => new URL(route.request().url()).searchParams.get('photoId') === 'review-failed'
      ? route.fulfill({ status: 503, json: { retryable: false } })
      : route.fulfill({ status: 200, contentType: 'image/jpeg', body: previewFixture }))
    await page.route('**/api/afp/workbench-data', async (route) => {
      const input: unknown = route.request().postDataJSON()
      assert(input && typeof input === 'object' && 'operation' in input && typeof input.operation === 'string')
      if (input.operation === 'collection-list') {
        await route.fulfill({ json: { ok: true, value: { items: [{ id: 'fixture-target', name: '审阅确认夹具', readOnly: false, count: 0 }] } } }); return
      }
      if (input.operation === 'collection-items') {
        await route.fulfill({ json: { ok: true, value: { items: [{ id: 'collection-photo', title: '收藏夹图片夹具', provider: 'AFP',
          previewPath: 'api/afp/preview?photoId=collection-photo' }], total: 1, hasMore: false } } }); return
      }
      if (input.operation !== 'photo-details') { await route.continue(); return }
      assert('args' in input && input.args && typeof input.args === 'object' && 'photoId' in input.args)
      assert(typeof input.args.photoId === 'string')
      const photoId = input.args.photoId
      const photo = [...reviewRun.groups.food.candidates, ...reviewRun.pending.candidates].find(item => item.id === photoId)
      await route.fulfill({ json: { ok: true, value: photo } })
    })
    const console = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'AFP 图片策展', exact: true }).click()
    await page.getByRole('tab', { name: '筛选任务', exact: true }).click()
    const indicator = page.locator('.afp-wb-tab-indicator')
    await expect.poll(() => indicator.getAttribute('data-placed')).toBe('true')
    await page.getByRole('tab', { name: '变更记录', exact: true }).click()
    expect(await indicator.evaluate(element => getComputedStyle(element).transitionProperty)).toContain('transform')
    await expect.poll(() => page.locator('.afp-wb-tabstrip').evaluate((element) => {
      const layer = element.querySelector('.afp-wb-tab-indicator'), active = element.querySelector('[aria-selected="true"]')
      if (!layer || !active) throw new Error('Missing tab indicator')
      return Math.abs(layer.getBoundingClientRect().left - active.getBoundingClientRect().left) < 2
    })).toBe(true)
    expect(await page.locator('.afp-wb-tab').first().evaluate(element => getComputedStyle(element, '::after').content)).toBe('none')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await indicator.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.getByRole('tab', { name: '筛选任务', exact: true }).click()
    await page.locator('.afp-wb-history-row').first().click()
    await page.getByRole('button', { name: '运行诊断', exact: true }).click()
    const diagnosticsDialog = page.getByRole('dialog', { name: '运行诊断', exact: true })
    const panel = page.locator('[data-afp-diagnostics]')
    await panel.getByText('摘要模式', { exact: false }).waitFor({ state: 'visible' })
    await panel.getByText('失败位置: 连接与配置').waitFor({ state: 'visible' })
    expect(await panel.locator('.afp-wb-diagnostics-failure > span').count()).toBeGreaterThan(1)
    const timings = panel.locator('[data-afp-timings]')
    expect(await timings.getAttribute('open')).toBeNull()
    await timings.locator('summary').click()
    expect(await timings.getByRole('table').isVisible()).toBe(true)
    expect(await timings.locator('tbody th[scope="row"]').count()).toBeGreaterThan(0)
    const metadata = panel.locator('[data-afp-diagnostic-metadata]')
    expect(await metadata.getAttribute('open')).toBeNull()
    await metadata.locator('summary').click()
    expect(await metadata.getByText(handle.runId, { exact: true }).isVisible()).toBe(true)
    expect(await metadata.locator('.afp-wb-diagnostics-identities > div').count()).toBe(2)
    expect(await metadata.locator('pre').count()).toBe(0)
    // 跨越状态轮询周期，诊断字段不能让报告重挂载并收起已展开的诊断面板。
    await page.waitForTimeout(5000)
    expect(await diagnosticsDialog.isVisible()).toBe(true)
    expect(await metadata.getAttribute('open')).toBe('')
    await page.screenshot({ path: fileURLToPath(new URL('../../../.artifacts/afp-ui-20261009/diagnostics-dialog-light.png', import.meta.url)), fullPage: true })
    expect(await panel.getByRole('button', { name: '导出诊断日志', exact: true }).isEnabled()).toBe(true)
    const downloadPromise = page.waitForEvent('download')
    await panel.getByRole('button', { name: '导出诊断日志', exact: true }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe(`afp-diagnostics-${handle.runId}.jsonl`)
    const path = await download.path()
    if (!path) throw new Error('AFP diagnostic download unavailable')
    const text = await readFile(path, 'utf8')
    const summary: unknown = JSON.parse(text.trim())
    assert(summary && typeof summary === 'object' && 'event' in summary && 'runId' in summary && 'debug' in summary)
    assert('failure' in summary && summary.failure && typeof summary.failure === 'object' && 'stage' in summary.failure)
    assert('timings' in summary && Array.isArray(summary.timings))
    const steps = summary.timings.map((row: unknown) => {
      assert(row && typeof row === 'object' && 'stage' in row && typeof row.stage === 'string')
      return row.stage
    })
    expect(summary.event).toBe('summary')
    expect(summary.runId).toBe(handle.runId)
    expect(summary.debug).toBe(false)
    expect(summary.failure.stage).toBe('connection')
    expect(text).not.toMatch(/https?:|accessToken|password|responseBody|data:image/)
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/afp-debug/diagnostics.expected.md', import.meta.url)),
      JSON.stringify({ event: summary.event, debug: summary.debug, failureStage: summary.failure.stage,
        steps, exported: download.suggestedFilename().replace(handle.runId, '<runId>'), reportStableAcrossPolling: true,
        technicalDetailsInitiallyCollapsed: true, historyCounts: { planned: 2, completed: 1, missingActual: '—' } }, null, 2), webSnapshotMode())
    await diagnosticsDialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('tab', { name: '变更记录', exact: true }).click()
    const planned = page.locator('.afp-wb-plan-history').filter({ hasText: '等待确认' })
    const completed = page.locator('.afp-wb-plan-history').filter({ hasText: '已完成' })
    const failed = page.locator('.afp-wb-plan-history').filter({ hasText: '失败' })
    await page.locator('.afp-wb-plan-history').first().waitFor({ state: 'visible' })
    expect(await planned.locator('.afp-wb-plan-totals').innerText()).toBe('计划新增 2 · 计划移除 0')
    expect(await completed.locator('.afp-wb-plan-totals').innerText()).toBe('已新增 1 · 已删除 0')
    expect(await failed.locator('.afp-wb-plan-totals').innerText()).toBe('已新增 — · 已删除 —')
    await completed.locator('summary').click()
    expect(await completed.locator('.afp-wb-plan-results').innerText()).toContain('已新增 1')
    for (const dark of [false, true]) {
      await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark)
      expect(await completed.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const artifacts = fileURLToPath(new URL('../../../.artifacts/afp-ui-20261009/', import.meta.url))
      await mkdir(artifacts, { recursive: true })
      await page.screenshot({ path: `${artifacts}/changes-${dark ? 'dark' : 'light'}.png`, fullPage: true })
    }
    await page.setViewportSize({ width: 600, height: 900 })
    expect(await completed.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.locator('.afp-wb-panel-changes').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    await page.getByRole('tab', { name: '账户与设置', exact: true }).click()
    await page.getByRole('tab', { name: '视觉模型', exact: true }).click()
    const advanced = page.getByRole('button', { name: '高级配置', exact: true })
    if (await advanced.getAttribute('aria-expanded') === 'false') await advanced.click()
    expect(await page.getByRole('switch', { name: '开启 Debug 详细诊断', exact: true }).isChecked()).toBe(false)
    await page.getByRole('switch', { name: '开启 Debug 详细诊断', exact: true }).click()
    expect(await page.getByRole('switch', { name: '开启 Debug 详细诊断', exact: true }).isChecked()).toBe(true)
    const draft = page.getByRole('textbox', { name: '部署配置（JSON，不含密钥）', exact: true })
    const draftConfig: unknown = JSON.parse(await draft.inputValue())
    assert(draftConfig && typeof draftConfig === 'object' && 'debugEnabled' in draftConfig)
    expect(draftConfig.debugEnabled).toBe(true)
    expect(await page.locator('.afp-config-advanced-card .afp-muted').count()).toBe(0)
    const geometry = await page.locator('.afp-wb-panel-account').evaluate((element) => {
      const body = element.querySelector('.afp-wb-account-body')
      const primary = element.querySelector('.afp-config-primary')
      const card = element.querySelector('.afp-config-advanced-card')
      const editor = element.querySelector('textarea')
      if (!body || !primary || !card || !editor) throw new Error('Missing configuration layout')
      return {
        bodyGap: element.getBoundingClientRect().bottom - parseFloat(getComputedStyle(element).paddingBottom)
          - body.getBoundingClientRect().bottom,
        cardGap: primary.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom,
        editorGap: card.getBoundingClientRect().bottom - editor.getBoundingClientRect().bottom,
        editorHeight: editor.getBoundingClientRect().height,
      }
    })
    expect(Math.abs(geometry.bodyGap)).toBeLessThan(2)
    expect(Math.abs(geometry.cardGap)).toBeLessThan(2)
    expect(geometry.editorGap).toBeLessThan(20)
    expect(geometry.editorHeight).toBeGreaterThan(300)
    const draftText = await draft.inputValue()
    await advanced.click()
    expect(await draft.isVisible()).toBe(false)
    await advanced.click()
    expect(await draft.inputValue()).toBe(draftText)
    const artifacts = fileURLToPath(new URL('../../../.artifacts/afp-ui-20261009/', import.meta.url))
    await page.screenshot({ path: `${artifacts}/vision-light.png`, fullPage: true })
    await page.getByRole('tab', { name: 'AFP 账户', exact: true }).click()
    const credentialGap = await page.locator('.afp-wb-account-body').evaluate((element) => {
      const form = element.querySelector('form'), profile = element.querySelector('.afp-wb-user-profile')
      if (!form || !profile) throw new Error('Missing account cards')
      return Math.abs(form.getBoundingClientRect().bottom - profile.getBoundingClientRect().bottom)
    })
    expect(credentialGap).toBeLessThan(2)
    await page.getByRole('tab', { name: '功能与入口', exact: true }).click()
    expect(await page.locator('.afp-wb-account-body').isVisible()).toBe(false)
    expect(await page.locator('.afp-wb-feature-section').isVisible()).toBe(true)
    await page.getByRole('tab', { name: '筛选任务', exact: true }).click()
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await page.locator('.afp-wb-history-row').filter({ hasText: '已暂停，可继续' }).locator('.afp-wb-history-open').click()
    const photos = page.locator('.afp-wb-report .afp-wb-photo-tile')
    await photos.first().waitFor({ state: 'visible' })
    const taskLayout = page.locator('.afp-wb-task-layout')
    const setup = page.locator('.afp-wb-task-sidebar-content')
    expect(await page.locator('.afp-wb-report [data-afp-diagnostics], .afp-wb-task-activity').count()).toBe(0)
    await page.getByRole('button', { name: '运行与下载记录', exact: true }).click()
    const activity = page.getByRole('dialog', { name: '运行与下载记录', exact: true })
    expect(await activity.locator('.afp-wb-live-section').isVisible()).toBe(true)
    expect(await activity.getByRole('tab', { name: /下载记录/ }).getAttribute('aria-selected')).toBe('true')
    await activity.locator('.afp-wb-download-task > summary').click()
    expect(await activity.locator('.afp-wb-download-task-files > p').count()).toBe(9)
    expect(await activity.getByRole('progressbar').getAttribute('value')).toBe('9')
    await expect.poll(() => activity.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    expect(await activity.locator('..').locator(':scope > [aria-hidden="true"]').evaluate(element => getComputedStyle(element).backdropFilter)).toBe('blur(8px)')
    await page.screenshot({ path: `${artifacts}/activity-downloads-light.png`, fullPage: true })
    await activity.getByRole('tab', { name: /运行任务/ }).click()
    expect(await activity.getByText('暂无运行中的任务', { exact: true }).isVisible()).toBe(true)
    await activity.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '预览收藏夹变更', exact: true }).click()
    const previewDialog = page.getByRole('dialog', { name: '预览收藏夹变更', exact: true })
    expect(await previewDialog.locator('.afp-wb-change-layout').isVisible()).toBe(true)
    expect(await previewDialog.getByRole('button', { name: '预览收藏夹变更', exact: true }).isEnabled()).toBe(false)
    await previewDialog.getByRole('button', { name: '关闭', exact: true }).click()
    const initialResultsWidth = await page.locator('.afp-wb-task-results').evaluate(element => element.clientWidth)
    const toggleBox = await page.getByRole('button', { name: '收起任务设置', exact: true }).boundingBox()
    expect(toggleBox?.width).toBe(36)
    expect(toggleBox?.height).toBe(36)
    expect(await taskLayout.evaluate(element => getComputedStyle(element).transitionProperty)).toContain('grid-template-columns')
    await page.getByRole('button', { name: '收起任务设置', exact: true }).click()
    await expect.poll(() => setup.isVisible()).toBe(false)
    await expect.poll(() => page.locator('.afp-wb-task-results').evaluate(element => element.clientWidth)).toBeGreaterThan(initialResultsWidth + 220)
    await page.getByRole('button', { name: '展开任务设置', exact: true }).press('Enter')
    expect(await setup.isVisible()).toBe(true)
    await expect.poll(() => setup.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await expect.poll(() => page.getByRole('button', { name: '收起任务设置', exact: true }).getAttribute('aria-expanded')).toBe('true')
    await page.locator('.afp-wb-result-filters').getByRole('button', { name: '已通过', exact: true }).click()
    await expect.poll(() => photos.count()).toBe(1)
    expect(await page.locator('.afp-wb-report .afp-wb-history-skeleton').count()).toBe(0)
    expect(await photos.first().getByRole('button', { name: '选择图片', exact: true }).isEnabled()).toBe(true)
    await page.locator('.afp-wb-result-filters').getByRole('button', { name: '全部记录', exact: true }).click()
    await expect.poll(() => photos.count()).toBe(4)
    const baseFill = await photos.first().evaluate(element => getComputedStyle(element).backgroundColor)
    await photos.first().hover()
    expect(await photos.first().evaluate(element => getComputedStyle(element).backgroundColor)).toBe(baseFill)
    expect(await photos.first().locator('.afp-wb-photo-confidence').evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none')
    await photos.first().getByRole('button', { name: '选择图片', exact: true }).click()
    expect(await photos.first().evaluate(element => getComputedStyle(element).backgroundColor)).toBe(baseFill)
    expect(await photos.first().locator('.afp-wb-photo-frame').evaluate(element => getComputedStyle(element).outlineColor)).toBe('rgba(0, 0, 0, 0)')
    await photos.first().getByRole('button', { name: '从清单移除', exact: true }).click()
    await photos.first().getByRole('button', { name: '图片详情', exact: true }).hover()
    await expect.poll(() => page.locator('[role="tooltip"]:visible').count()).toBe(0)
    expect(await photos.nth(1).getByRole('button', { name: '选择图片', exact: true }).isEnabled()).toBe(false)
    const dimensions = await taskLayout.evaluate((element) => {
      const sidebar = element.querySelector('.afp-wb-task-sidebar'), results = element.querySelector('.afp-wb-task-results')
      const card = element.querySelector('.afp-wb-photo-tile'), actions = card?.querySelectorAll('.afp-wb-photo-review-actions button')
      const metadata = card?.querySelector('.afp-wb-photo-meta'), reason = card?.querySelector('.afp-wb-photo-reason')
      if (!sidebar || !results || !actions || actions.length !== 2 || !metadata || !reason) throw new Error('Missing task layout')
      return { heightGap: Math.abs(sidebar.getBoundingClientRect().height - results.getBoundingClientRect().height),
        buttonGap: Math.abs(actions[0]!.getBoundingClientRect().width - actions[1]!.getBoundingClientRect().width),
        informationHeight: metadata.getBoundingClientRect().height + reason.getBoundingClientRect().height,
        icons: Array.from(actions).map(button => button.querySelectorAll('svg').length) }
    })
    expect(dimensions.heightGap).toBeLessThan(2)
    expect(dimensions.buttonGap).toBeLessThan(1)
    expect(dimensions.informationHeight).toBeLessThan(48)
    expect(dimensions.icons).toEqual([1, 1])
    expect(await taskLayout.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect.poll(() => photos.nth(1).locator('.afp-wb-image-stage').getAttribute('class')).toContain('is-ready')
    await expect.poll(() => photos.nth(1).locator('.afp-wb-image-stage > img')
      .evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await page.screenshot({ path: `${artifacts}/tasks-layout-light.png`, fullPage: true })
    // 系统配色触发主题服务更新全部变量，避免仅改属性后残留浅色覆盖值。
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
    await expect.poll(() => photos.first().evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgb(255, 255, 255)')
    await page.screenshot({ path: `${artifacts}/tasks-layout-dark.png`, fullPage: true })
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBeNull()
    await page.getByRole('button', { name: '收起任务设置', exact: true }).click()
    await expect.poll(() => page.locator('.afp-wb-task-sidebar').evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(56)
    await expect.poll(() => page.locator('.afp-wb-task-compact').evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await page.screenshot({ path: `${artifacts}/tasks-layout-collapsed.png`, fullPage: true })
    await page.getByRole('button', { name: '展开任务设置', exact: true }).click()
    await expect.poll(() => setup.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await photos.first().locator('.afp-wb-image-button').click()
    const review = page.getByRole('dialog', { name: '审阅图片', exact: true })
    expect(await review.isVisible()).toBe(true)
    expect(await review.evaluate(element => getComputedStyle(element, '::before').backdropFilter)).toBe('none')
    await review.press('ArrowRight')
    expect(await review.locator('.afp-wb-review-position').innerText()).toBe('2 / 4')
    await review.press('ArrowLeft')
    expect(await page.locator('.afp-wb-detail').count()).toBe(0)
    expect(await review.getByRole('button', { name: '上一张', exact: true }).isEnabled()).toBe(false)
    await review.getByRole('button', { name: '选择图片', exact: true }).click()
    expect(await review.getByRole('button', { name: '从清单移除', exact: true }).isVisible()).toBe(true)
    await review.getByRole('button', { name: '下一张', exact: true }).click()
    expect(await review.getByText('未通过原因夹具', { exact: true }).isVisible()).toBe(true)
    expect(await review.getByRole('button', { name: '选择图片', exact: true }).isEnabled()).toBe(false)
    await review.getByRole('button', { name: '下一张', exact: true }).press('ArrowRight')
    expect(await review.locator('.afp-wb-review-position').innerText()).toBe('3 / 4')
    expect(await review.getByRole('button', { name: '选择图片', exact: true }).isEnabled()).toBe(false)
    await review.getByRole('button', { name: '下一张', exact: true }).click()
    expect(await review.getByRole('button', { name: '下一张', exact: true }).isEnabled()).toBe(false)
    expect(await review.getByRole('button', { name: '选择图片', exact: true }).isEnabled()).toBe(false)
    await review.getByRole('button', { name: '选图清单', exact: true }).click()
    expect(await page.locator('.afp-wb-report .afp-wb-selection-item').count()).toBe(1)
    expect(await page.locator('.afp-wb-report > .afp-wb-report-aside .afp-wb-selection').count()).toBe(1)
    await expect.poll(() => page.locator('.afp-wb-report-aside-content').evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await page.screenshot({ path: `${artifacts}/report-selection-aside.png`, fullPage: true })
    expect(await photos.first().getAttribute('class')).toContain('is-selected')
    // 本测试仅检查确认入口，绝不执行收藏夹写入。
    expect(await page.getByRole('button', { name: '加入收藏夹', exact: true }).isEnabled()).toBe(true)
    await page.getByRole('button', { name: '加入收藏夹', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: '加入收藏夹', exact: true })
    await confirmation.getByRole('button', { name: /审阅确认夹具/ }).click()
    expect(await confirmation.getByRole('button', { name: '确认加入', exact: true }).isEnabled()).toBe(true)
    expect(await confirmation.getByText('已选择 1 张图片', { exact: true }).isVisible()).toBe(true)
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await photos.first().locator('.afp-wb-photo-frame').click({ button: 'right' })
    expect(await review.isVisible()).toBe(false)
    expect(await page.locator('.afp-wb-detail:not(.afp-wb-selection)').isVisible()).toBe(true)
    await page.setViewportSize({ width: 1440, height: 620 })
    const detailPane = page.locator('.afp-wb-report .afp-wb-detail:not(.afp-wb-selection)')
    await expect.poll(() => page.locator('.afp-wb-report-aside-content').evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await expect.poll(() => detailPane.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await expect.poll(async () => Math.abs(await detailPane.evaluate(element => element.getBoundingClientRect().top)
      - await page.locator('.afp-wb-report').evaluate(element => element.getBoundingClientRect().top))).toBeLessThan(2)
    const detailTop = await detailPane.evaluate(element => element.getBoundingClientRect().top)
    expect(await page.locator('.afp-wb-report > .afp-wb-report-aside .afp-wb-detail:not(.afp-wb-selection)').count()).toBe(1)
    expect(Math.abs(detailTop - await page.locator('.afp-wb-report').evaluate(element => element.getBoundingClientRect().top))).toBeLessThan(2)
    const imageList = page.locator('.afp-wb-report .afp-wb-gallery-wrap')
    const reportHeader = page.locator('.afp-wb-report-main > .afp-wb-section-heading')
    const headerTop = await reportHeader.evaluate(element => element.getBoundingClientRect().top)
    const summaryTop = await page.locator('.afp-wb-report-summary').evaluate(element => element.getBoundingClientRect().top)
    await imageList.evaluate((element) => { element.scrollTop = element.scrollHeight })
    expect(await imageList.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(Math.abs(await detailPane.evaluate(element => element.getBoundingClientRect().top) - detailTop)).toBeLessThan(1)
    expect(Math.abs(await reportHeader.evaluate(element => element.getBoundingClientRect().top) - headerTop)).toBeLessThan(1)
    expect(await page.locator('.afp-wb-report-summary').evaluate(element => element.getBoundingClientRect().top)).toBeLessThan(summaryTop)
    expect(await page.locator('.afp-wb-report-toolbar').evaluate(element => getComputedStyle(element).position)).toBe('static')
    await page.locator('.afp-wb-report-main').getByRole('button', { name: '回到顶部', exact: true }).click()
    await expect.poll(() => imageList.evaluate(element => element.scrollTop)).toBe(0)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.screenshot({ path: `${artifacts}/report-detail-aside.png`, fullPage: true })
    await page.getByRole('button', { name: '关闭图片详情', exact: true }).click()
    await photos.first().locator('.afp-wb-image-button').click()
    await expect.poll(() => review.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    expect(await review.getByText('已通过', { exact: true }).isVisible()).toBe(true)
    await page.screenshot({ path: `${artifacts}/review-light.png`, fullPage: true })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => review.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgb(255, 255, 255)')
    await page.screenshot({ path: `${artifacts}/review-dark.png`, fullPage: true })
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => review.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)')
    await review.getByRole('button', { name: '关闭', exact: true }).click()
    await photos.nth(2).locator('.afp-wb-image-fallback').waitFor({ state: 'visible' })
    await photos.nth(2).locator('.afp-wb-photo-frame').click()
    expect(await review.locator('.afp-wb-review-position').innerText()).toBe('3 / 4')
    expect(await review.getByRole('button', { name: '选择图片', exact: true }).isEnabled()).toBe(false)
    await review.getByRole('button', { name: '关闭', exact: true }).click()
    for (const width of [600, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await taskLayout.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await expect.poll(() => page.getByRole('tab', { name: '筛选任务', exact: true }).evaluate((element) => {
        const tab = element.getBoundingClientRect(), track = element.closest('[role="tablist"]')!.getBoundingClientRect()
        return tab.left >= track.left - 1 && tab.right <= track.right + 1
      })).toBe(true)
      await page.getByRole('button', { name: '收起任务设置', exact: true }).click()
      await expect.poll(() => setup.isVisible()).toBe(false)
      await page.getByRole('button', { name: '展开任务设置', exact: true }).click()
      await expect.poll(() => setup.isVisible()).toBe(true)
      await expect.poll(() => setup.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
      await page.screenshot({ path: `${artifacts}/tasks-layout-${width}.png`, fullPage: true })
      await photos.first().locator('.afp-wb-image-button').click()
      expect(await review.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await review.getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByRole('tab', { name: '账户与设置', exact: true }).click()
      await page.getByRole('tab', { name: '视觉模型', exact: true }).click()
      expect(await page.locator('.afp-wb-panel-account').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await draft.inputValue()).toBe(draftText)
      await page.getByRole('tab', { name: '筛选任务', exact: true }).click()
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('tab', { name: '收藏夹', exact: true }).click()
    await page.locator('.afp-wb-collection-list').getByRole('button', { name: /审阅确认夹具/ }).click()
    const collectionPhoto = page.locator('.afp-wb-collection-content .afp-wb-photo-tile').first()
    const collectionFrame = collectionPhoto.locator('.afp-wb-photo-frame')
    await collectionFrame.waitFor({ state: 'visible' })
    await collectionFrame.press('Space')
    expect(await collectionPhoto.getAttribute('class')).toContain('is-selected')
    expect(await collectionFrame.getAttribute('aria-pressed')).toBe('true')
    expect(await collectionPhoto.locator('.afp-wb-photo-select').count()).toBe(0)
    expect(await collectionFrame.evaluate(element => getComputedStyle(element).outlineColor)).toBe('rgba(0, 0, 0, 0)')
    await expect.poll(() => collectionPhoto.evaluate(element => getComputedStyle(element).borderTopColor)).not.toBe('rgba(0, 0, 0, 0)')
    await page.screenshot({ path: `${artifacts}/collection-selected-card.png`, fullPage: true })
    await collectionFrame.press('Space')
    expect(await collectionFrame.getAttribute('aria-pressed')).toBe('false')
    await page.getByRole('tab', { name: '筛选任务', exact: true }).click()
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/afp-debug/review.expected.md', import.meta.url)),
      JSON.stringify({ leftClick: 'review', rightClick: 'details', navigation: ['kept', 'rejected', 'failed', 'pending'],
        rejectedSelectable: false, failedSelectable: false, pendingSelectable: false, selected: 1,
        configurationFillsContainer: true, editorDraftPreserved: true, responsiveWidths: [600, 390],
        taskSetupCollapsible: true, taskUtilitiesInTabs: true, directOutcomeFilters: true,
        directSelectionOnlyForPassed: true, taskSetupFullHeight: true, cardActionsHalfWidth: true,
        cardMetadataCompact: true, tabsGlide: true, reviewSolidSurface: true,
        detailDoesNotFollowImageScroll: true, cardSelectionBorderOnly: true, confidenceSolidFill: true,
        cardActionsNoTooltip: true }, null, 2), webSnapshotMode())
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  } finally { await browser.close(); await scaffold.close() }
})

const RUN_ID = '4a8b7032-fc24-4a8c-85fb-6c3a3c108b93'
const RESULT_REF = '4a8b7032-fc24-4a8c-85fb-6c3a3c108b94'
const SESSION_ID = 'afp-conversation-feedback'
const report = { resultRef: RESULT_REF, runId: RUN_ID, status: 'ready', stage: 'visual', categories: [
  { category: 'landscape', reviewed: 18, pixelReviewed: 18, kept: 3, rejected: 15, target: 3, requestFailures: 0 },
] }
const reviewedPhotos = Array.from({ length: 18 }, (_, index) => ({
  id: `fixture-${index}`, title: `图片 ${index + 1}`, category: 'landscape', keep: index < 3,
}))

/** Create closed Session events without requesting a model or AFP account. */
function screeningFixture(): string {
  const session = Session.create(SessionId('afp-feedback-source'))
  for (const turn of [1, 2]) {
    const calls: { name: string; id: string; value: JsonValue }[] = turn === 1 ? [
      { name: 'afp_refresh', id: 'launch', value: { runId: RUN_ID, jobId: 'afp-1' } },
      { name: 'afp_report', id: 'saved-report', value: report },
    ] : [{ name: 'afp_refresh', id: 'missing-report', value: { runId: 'other-run', jobId: 'afp-2' } }]
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `AFP feedback fixture ${turn}` }],
      source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', { stream: [], turn, step: 1, message: createAssistantMessage({
      content: calls.map(call => ({ type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: '{}' })),
      source: { provider: 'fixture', model: 'fixture' },
    }) }, { surfaceOp: 'append' })
    for (const call of calls) {
      const callId = ToolCallId(call.id)
      const source = session.append('tool/call', { turn, step: 1, callId, name: call.name, arguments: '{}' })
      session.append('tool/result', { turn, step: 1,
        meta: { afp: { version: 1, complete: true, result: call.value } },
        message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: JSON.stringify(call.value) }] }),
      }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    }
    session.append('step/end', { turn, step: 1 })
    session.append('step/start', { turn, step: 2 })
    session.append('assistant/message', { stream: [], turn, step: 2, message: createAssistantMessage({
      content: [{ type: 'text', text: `AFP_FEEDBACK_DONE_${turn}` }], source: { provider: 'fixture', model: 'fixture' },
    }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 2 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

it('replays closed launch cards with saved thumbnails across reload and explains missing reports', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [], bundles: ['dsh-plugin-afp'] },
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)) })
  let browser
  try {
    await seedSession(scaffold, screeningFixture(), SESSION_ID)
    browser = await chromium.launch()
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 960 } })
    const tripwire = watchConsole(page)
    const reads: string[] = []
    await page.route('**/api/afp/workbench-data', async (route) => {
      const input = route.request().postDataJSON() as {
        operation: string
        args: { sessionId?: string; turn?: number; callId?: string; resultRef?: string }
      }
      if (input.operation !== 'conversation-result') { await route.continue(); return }
      expect(input.args).toEqual({ sessionId: SESSION_ID, turn: 1, callId: 'saved-report', resultRef: RESULT_REF })
      reads.push(input.args.callId!)
      await route.fulfill({ json: { ok: true, value: { ...report, reviewedPhotos } } })
    })
    await page.route('**/api/afp/preview?*', route => route.fulfill({ contentType: 'image/png', body:
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/J0AAAAASUVORK5CYII=', 'base64') }))
    await page.goto(scaffold.authenticatedUrl)
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText('AFP_FEEDBACK_DONE_2', { exact: true }).waitFor()
    for (const reload of [false, true]) {
      if (reload) await page.reload()
      await expandTurnProcesses(page)
      const launch = page.locator('.afp-agent-tool-row[data-feedback]').first()
      await launch.locator('[data-expandable]').first().click()
      await launch.getByText('已通过 3 张', { exact: true }).waitFor()
      expect(await launch.locator('.afp-reviewed-disclosure').allTextContents()).toMatchInlineSnapshot(`
        [
          "已通过 3 张",
          "未通过 15 张",
        ]
      `)
      expect(await launch.locator('.afp-reviewed-thumbnail').count()).toBe(0)
      await launch.getByText('已通过 3 张', { exact: true }).click()
      await expect.poll(() => launch.locator('.afp-reviewed-thumbnail img').count()).toBe(3)
      const strip = launch.locator('.afp-reviewed-previews')
      const geometry = await strip.evaluate((element) => {
        const owner = element.closest('.afp-reviewed-disclosure')!
        const thumbnail = element.querySelector('.afp-reviewed-thumbnail')!
        return { width: element.getBoundingClientRect().width, thumbnail: thumbnail.getBoundingClientRect().width,
          rightGap: owner.getBoundingClientRect().right - element.getBoundingClientRect().right }
      })
      expect(geometry.width).toBeGreaterThan(geometry.thumbnail * 5 + 32)
      expect(Math.abs(geometry.rightGap)).toBeLessThan(2)
      await expect.poll(() => launch.locator('img').evaluateAll(images => images.every(image => image instanceof HTMLImageElement && image.naturalWidth > 0))).toBe(true)
      await launch.locator('.afp-reviewed-thumbnail .afp-wb-image-button').first().click()
      const modal = page.locator('.afp-wb-preview-modal')
      await modal.waitFor()
      expect(await modal.getByRole('button', { name: '上一张', exact: true }).isDisabled()).toBe(true)
      await modal.getByRole('button', { name: '下一张', exact: true }).click()
      await modal.getByText('2 / 3', { exact: true }).waitFor()
      await page.keyboard.press('ArrowRight')
      await modal.getByText('3 / 3', { exact: true }).waitFor()
      expect(await modal.getByRole('button', { name: '下一张', exact: true }).isDisabled()).toBe(true)
      await page.keyboard.press('ArrowRight')
      expect(await modal.getByText('3 / 3', { exact: true }).isVisible()).toBe(true)
      await page.keyboard.press('ArrowLeft')
      await modal.getByText('2 / 3', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await expect.poll(() => page.locator('.afp-wb-preview-modal').count()).toBe(0)
      const rejected = launch.locator('[data-review-status="rejected"]')
      await rejected.getByText('未通过 15 张', { exact: true }).click()
      await rejected.locator('.afp-reviewed-thumbnail .afp-wb-image-button').first().click()
      await modal.getByText('1 / 15', { exact: true }).waitFor()
      await modal.getByRole('button', { name: '下一张', exact: true }).click()
      await modal.getByText('2 / 15', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await rejected.getByText('未通过 15 张', { exact: true }).click()
      const missing = page.locator('.afp-agent-tool-row[data-feedback]').last()
      await missing.locator('[data-expandable]').first().click()
      await missing.getByText('该记录未保存查看明细，无法回溯缩略图。', { exact: true }).waitFor()
      expect(await missing.locator('.afp-reviewed-lists').count()).toBe(0)
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      for (const width of [600, 390]) {
        await page.setViewportSize({ width, height: 844 })
        expect(await launch.getByText('已通过 3 张', { exact: true }).isVisible()).toBe(true)
        expect(await strip.evaluate(element => element.scrollWidth >= element.clientWidth)).toBe(true)
        await launch.locator('.afp-reviewed-thumbnail .afp-wb-image-button').first().click()
        expect(await modal.getByRole('button', { name: '下一张', exact: true }).isVisible()).toBe(true)
        await page.keyboard.press('ArrowRight')
        await modal.getByText('2 / 3', { exact: true }).waitFor()
        await page.keyboard.press('Escape')
      }
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
      await page.setViewportSize({ width: 1440, height: 960 })
    }
    expect(reads).toEqual(['saved-report', 'saved-report'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
})
