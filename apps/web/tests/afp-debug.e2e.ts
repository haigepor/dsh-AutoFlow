/** Keyless AFP diagnostics through the shipped Web composition, real jobs and authenticated browser reads. */
import { fileURLToPath } from 'node:url'
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

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
    const handle: { runId: string; jobId: string } = JSON.parse(result.output)
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    // 审阅使用本地栅格和详情夹具；真实认证、报告读取、选择与确认入口仍走应用路径。
    await page.route('**/api/afp/preview?*', route => new URL(route.request().url()).searchParams.get('photoId') === 'review-failed'
      ? route.fulfill({ status: 503, json: { retryable: false } })
      : route.fulfill({ status: 200, contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/J0AAAAASUVORK5CYII=', 'base64') }))
    await page.route('**/api/afp/workbench-data', async (route) => {
      const input: { operation: string; args: { photoId?: string } } = route.request().postDataJSON()
      if (input.operation === 'collection-list') {
        await route.fulfill({ json: { ok: true, value: { items: [{ id: 'fixture-target', name: '审阅确认夹具', readOnly: false, count: 0 }] } } }); return
      }
      if (input.operation !== 'photo-details') { await route.continue(); return }
      const photo = [...reviewRun.groups.food.candidates, ...reviewRun.pending.candidates].find(item => item.id === input.args.photoId)
      await route.fulfill({ json: { ok: true, value: photo } })
    })
    const console = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'AFP 图片策展', exact: true }).click()
    await page.getByRole('tab', { name: '筛选任务', exact: true }).click()
    await page.locator('.afp-wb-history-row').first().click()
    const panel = page.locator('[data-afp-diagnostics]')
    await panel.locator('summary').click()
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
    expect(await panel.getAttribute('open')).toBe('')
    expect(await panel.getByRole('button', { name: '导出诊断日志', exact: true }).isEnabled()).toBe(true)
    const downloadPromise = page.waitForEvent('download')
    await panel.getByRole('button', { name: '导出诊断日志', exact: true }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe(`afp-diagnostics-${handle.runId}.jsonl`)
    const path = await download.path()
    if (!path) throw new Error('AFP diagnostic download unavailable')
    const text = await readFile(path, 'utf8')
    const summary: {
      event: string
      runId: string
      debug: boolean
      failure: { stage: string }
      timings: { stage: string }[]
    } = JSON.parse(text.trim())
    expect(summary.event).toBe('summary')
    expect(summary.runId).toBe(handle.runId)
    expect(summary.debug).toBe(false)
    expect(summary.failure.stage).toBe('connection')
    expect(text).not.toMatch(/https?:|accessToken|password|responseBody|data:image/)
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/afp-debug/diagnostics.expected.md', import.meta.url)),
      JSON.stringify({ event: summary.event, debug: summary.debug, failureStage: summary.failure.stage,
        steps: summary.timings.map(row => row.stage), exported: download.suggestedFilename().replace(handle.runId, '<runId>'), reportStableAcrossPolling: true,
        technicalDetailsInitiallyCollapsed: true, historyCounts: { planned: 2, completed: 1, missingActual: '—' } }, null, 2), webSnapshotMode())
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
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await page.getByRole('tab', { name: '账户与设置', exact: true }).click()
    await page.getByRole('tab', { name: '视觉模型', exact: true }).click()
    const advanced = page.getByRole('button', { name: '高级配置', exact: true })
    if (await advanced.getAttribute('aria-expanded') === 'false') await advanced.click()
    expect(await page.getByRole('switch', { name: '开启 Debug 详细诊断', exact: true }).isChecked()).toBe(false)
    await page.getByRole('switch', { name: '开启 Debug 详细诊断', exact: true }).click()
    expect(await page.getByRole('switch', { name: '开启 Debug 详细诊断', exact: true }).isChecked()).toBe(true)
    const draft = page.getByRole('textbox', { name: '部署配置（JSON，不含密钥）', exact: true })
    expect(JSON.parse(await draft.inputValue()).debugEnabled).toBe(true)
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
    await page.getByRole('button', { name: '关闭报告', exact: true }).click()
    await page.locator('.afp-wb-history-row').filter({ hasText: '结果可用' }).click()
    const photos = page.locator('.afp-wb-report .afp-wb-photo-tile')
    await photos.first().waitFor({ state: 'visible' })
    await photos.first().locator('.afp-wb-image-button').click()
    const review = page.getByRole('dialog', { name: '审阅图片', exact: true })
    expect(await review.isVisible()).toBe(true)
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
    await page.getByRole('button', { name: '关闭图片详情', exact: true }).click()
    await photos.first().locator('.afp-wb-image-button').click()
    await expect.poll(() => review.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    expect(await review.getByText('已通过', { exact: true }).isVisible()).toBe(true)
    await page.screenshot({ path: `${artifacts}/review-light.png`, fullPage: true })
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await page.screenshot({ path: `${artifacts}/review-dark.png`, fullPage: true })
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await review.getByRole('button', { name: '关闭', exact: true }).click()
    await photos.nth(2).locator('.afp-wb-image-fallback').waitFor({ state: 'visible' })
    await photos.nth(2).locator('.afp-wb-photo-frame').click()
    expect(await review.locator('.afp-wb-review-position').innerText()).toBe('3 / 4')
    expect(await review.getByRole('button', { name: '选择图片', exact: true }).isEnabled()).toBe(false)
    await review.getByRole('button', { name: '关闭', exact: true }).click()
    for (const width of [600, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await photos.first().locator('.afp-wb-image-button').click()
      expect(await review.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await review.getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByRole('tab', { name: '账户与设置', exact: true }).click()
      await page.getByRole('tab', { name: '视觉模型', exact: true }).click()
      expect(await page.locator('.afp-wb-panel-account').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await draft.inputValue()).toBe(draftText)
      await page.getByRole('tab', { name: '筛选任务', exact: true }).click()
    }
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/afp-debug/review.expected.md', import.meta.url)),
      JSON.stringify({ leftClick: 'review', rightClick: 'details', navigation: ['kept', 'rejected', 'failed', 'pending'],
        rejectedSelectable: false, failedSelectable: false, pendingSelectable: false, selected: 1,
        configurationFillsContainer: true, editorDraftPreserved: true, responsiveWidths: [600, 390] }, null, 2), webSnapshotMode())
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  } finally { await browser.close(); await scaffold.close() }
})
