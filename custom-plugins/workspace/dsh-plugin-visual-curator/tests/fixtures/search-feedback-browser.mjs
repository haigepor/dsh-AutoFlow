async (page) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/visual-curator/resource**', async route => {
    const url = new URL(route.request().url())
    const id = url.searchParams.get('imageVersionId') ?? 'landscape'
    const specs = {
      landscape: { w: 1600, h: 900, bg: '#1e2c26', fg: '#7ca38f', title: '1600×900 横图 · 森林薄雾' },
      'source-landscape': { w: 2000, h: 1200, bg: '#17231e', fg: '#9abca9', title: '2000×1200 源图 · 原始构图' },
      portrait: { w: 900, h: 1440, bg: '#2c2533', fg: '#a58eb8', title: '900×1440 竖图 · 山脊冷杉' },
      tall: { w: 420, h: 1680, bg: '#332421', fg: '#c48b7e', title: '420×1680 长图 · 极端比例' },
      wide: { w: 2100, h: 500, bg: '#1e2936', fg: '#7fa1c3', title: '2100×500 宽幅 · 远景天际' },
    }
    const s = specs[id] ?? specs.landscape
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s.w}" height="${s.h}" viewBox="0 0 ${s.w} ${s.h}"><rect width="100%" height="100%" fill="${s.bg}"/><rect x="24" y="24" width="${s.w - 48}" height="${s.h - 48}" rx="18" fill="none" stroke="${s.fg}" stroke-width="6" stroke-dasharray="18 10"/><circle cx="${Math.round(s.w * 0.68)}" cy="${Math.round(s.h * 0.42)}" r="${Math.round(Math.min(s.w, s.h) * 0.18)}" fill="${s.fg}" fill-opacity="0.28"/><path d="M0 ${Math.round(s.h * 0.78)} Q ${Math.round(s.w * 0.35)} ${Math.round(s.h * 0.56)} ${Math.round(s.w * 0.7)} ${Math.round(s.h * 0.72)} T ${s.w} ${Math.round(s.h * 0.64)} L ${s.w} ${s.h} L 0 ${s.h} Z" fill="${s.fg}" fill-opacity="0.36"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#e8f0ec" font-family="system-ui, sans-serif" font-size="${Math.max(24, Math.round(Math.min(s.w, s.h) * 0.06))}" font-weight="500">${s.title}</text></svg>`
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg })
  })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(page.url())
  await page.getByText('图库找图', { exact: true }).waitFor()
  await page.locator('[data-conversation-task] [data-result="selected"]').getByText('1 / 10').waitFor()
  const body = page.locator('[data-conversation-content]'), capsule = page.getByTestId('todo-panel')
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  assert(await capsule.isVisible(), 'wide body capsule missing')
  const capsuleBox = await capsule.boundingBox(), bodyBox = await body.boundingBox()
  assert(capsuleBox.x >= bodyBox.x && capsuleBox.x + capsuleBox.width <= bodyBox.x + bodyBox.width && capsuleBox.y >= bodyBox.y, 'capsule escaped its body')
  const toggle = capsule.getByRole('button')
  await toggle.focus(); await page.keyboard.press('Enter')
  await capsule.getByRole('list').waitFor()
  assert(await capsule.getByRole('listitem').count() === 3, 'todo rows changed')
  await page.keyboard.press('Escape')
  assert(await toggle.getAttribute('aria-expanded') === 'false', 'Escape did not close capsule')
  await page.getByRole('button', { name: '打开任务', exact: true }).click()
  assert(await page.evaluate(() => window.feedbackFixture.state.opened[0][0]) === 'a', 'wrong Session navigation')
  await page.screenshot({ path: '.playwright-mcp/search-feedback-desktop.png' })
  await page.locator('.fixture-conversation').evaluate(element => { element.style.width = '600px' })
  assert(!await capsule.isVisible(), 'narrow embedded body must hide at wide viewport')
  await page.locator('.fixture-conversation').evaluate(element => { element.style.width = '' })
  await page.setViewportSize({ width: 390, height: 844 })
  assert(!await capsule.isVisible(), 'narrow viewport capsule must hide')
  assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'narrow conversation overflow')
  await page.screenshot({ path: '.playwright-mcp/search-feedback-narrow.png' })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.evaluate(() => window.feedbackFixture.session('b'))
  await page.getByTestId('todo-panel').getByText('1 待处理', { exact: true }).waitFor()
  await page.getByTestId('todo-panel').getByRole('button').click()
  await page.getByText('另一个会话自己的任务', { exact: true }).waitFor()
  assert(!await page.getByText('读取参考包并核验固定画像与检索参数', { exact: true }).isVisible(), 'Session todo leaked')
  await page.evaluate(() => { window.feedbackFixture.state.offline = true; window.feedbackFixture.reset() })
  await page.getByRole('button', { name: '刷新进度', exact: true }).waitFor()
  assert((await page.locator('[data-conversation-task]').innerText()).includes('1 / 10'), 'disconnect discarded saved counts')
  await page.getByRole('button', { name: '刷新进度', exact: true }).evaluate(button => { window.feedbackFixture.state.offline = false; button.click() })
  await page.getByRole('button', { name: '刷新进度', exact: true }).waitFor({ state: 'hidden' })

  // Switch to full Workbench composition
  await page.evaluate(() => { window.feedbackFixture.theme(true); window.feedbackFixture.setMode('workbench') })
  await page.locator('.vc-pagebar').waitFor()
  await page.locator('.vc-search-launch-status').waitFor()
  await page.getByText('会话任务', { exact: true }).waitFor()
  await page.getByRole('button', { name: '返回素材库', exact: true }).waitFor()
  await page.getByRole('tab', { name: '找图与裁剪', exact: true }).waitFor()

  // Verify single-task auto-collapses left rail and shows single image cleanly
  assert(await page.locator('.vc-task-body').getAttribute('data-rail-open') === 'false', 'single task should collapse persistent rail by default')
  assert(await page.locator('.vc-results').getAttribute('data-count') === '1', 'default selected filter has 1 image')

  // Verify desktop heights across 1920x1080, 1440x900, 1280x720
  for (const [w, h] of [[1920, 1080], [1440, 900], [1280, 720]]) {
    await page.setViewportSize({ width: w, height: h })
    const previewBox = await page.locator('.vc-result-preview').first().boundingBox()
    const scrollBox = await page.locator('.vc-task-results-scroll').boundingBox()
    assert(previewBox.y <= Math.round(h * 0.35), `first preview too low at ${w}x${h}: y=${previewBox.y}`)
    assert(scrollBox.height >= Math.round(h * 0.58), `results scroll area too short at ${w}x${h}: height=${scrollBox.height}`)
    const noOuterScroll = await page.evaluate(() => {
      const wb = document.querySelector('.vc-workbench'), main = document.querySelector('.vc-main-workspace')
      return wb.scrollHeight <= wb.clientHeight + 1 && main.scrollHeight <= main.clientHeight + 1 && document.documentElement.scrollWidth <= innerWidth
    })
    assert(noOuterScroll, `outer scroll or horizontal overflow at ${w}x${h}`)
  }

  // Verify counts & filters distinction: 检索候选 6, 去重图片 4, 全部结果 · 4
  await page.setViewportSize({ width: 1440, height: 900 })
  const statsText = await page.locator('.vc-task-stats').innerText()
  assert(statsText.includes('检索候选') && statsText.includes('去重图片'), 'candidate vs distinct labels missing')
  await page.getByRole('button', { name: '待复核 · 0', exact: true }).click()
  await page.getByText('暂无需要人工判断的图片', { exact: true }).waitFor()
  await page.getByRole('button', { name: '全部结果 · 4', exact: true }).click()
  assert(await page.locator('.vc-result-card').count() === 4, 'all results should render 4 cards across categories')

  // Verify uniform card heights across landscape, portrait, tall, and wide images + clamped reason
  const cardMetrics = await page.locator('.vc-result-card').evaluateAll(cards => {
    const heights = cards.map(c => Math.round(c.getBoundingClientRect().height))
    const summaries = cards.map(c => c.querySelector('.vc-result-summary')?.getBoundingClientRect().height ?? 0)
    return { maxDiff: Math.max(...heights) - Math.min(...heights), maxSummaryHeight: Math.max(...summaries) }
  })
  assert(cardMetrics.maxDiff <= 2 && cardMetrics.maxSummaryHeight <= 40, `card height instability: ${JSON.stringify(cardMetrics)}`)

  // Verify diagnostics are collapsed by default and expand on click
  assert(await page.locator('.vc-task-diagnostics[open]').count() === 0, 'diagnostics must be collapsed by default')
  await page.locator('.vc-task-diagnostics summary').filter({ hasText: '候选处理情况' }).click()
  await page.locator('.vc-task-diagnostics[open]').getByText('图库没有返回原图', { exact: true }).waitFor()
  await page.locator('.vc-task-diagnostics summary').filter({ hasText: '候选处理情况' }).click()

  // Verify native Image Detail Modal, full review reason, source comparison, and Escape focus return
  const detailBtn = page.locator('.vc-result-card').first().getByRole('button', { name: '查看详情', exact: true })
  await detailBtn.click()
  const modal = page.locator('.vc-result-detail-modal')
  await modal.waitFor()
  assert((await modal.innerText()).includes('4) 裁剪框完整避开边缘干扰元素并保留地面纹理细节'), 'full untruncated review reason missing in detail modal')
  assert((await modal.innerText()).includes('120, 40 · 1600 × 900'), 'crop geometry missing in detail modal')
  assert(await modal.locator('.vc-result-detail-stage').count() === 2, 'source & result comparison stages missing')
  await page.screenshot({ path: '.playwright-mcp/search-feedback-detail-dark.png' })
  await page.keyboard.press('Escape')
  await modal.waitFor({ state: 'hidden' })
  assert(await detailBtn.evaluate(el => document.activeElement === el), 'focus did not return to detail button after Escape')

  // Verify desktop light & dark screenshots of full workbench
  await page.screenshot({ path: '.playwright-mcp/search-feedback-workbench-dark.png' })
  await page.evaluate(() => window.feedbackFixture.theme(false))
  await page.screenshot({ path: '.playwright-mcp/search-feedback-workbench.png' })

  // Verify multi-task switching, interrupted state, blocking error visibility, and launch vs run action separation
  await page.evaluate(() => window.feedbackFixture.setScenario('multi-task', 'all'))
  assert(await page.locator('.vc-task-body').getAttribute('data-rail-open') === 'true', 'multi-task should open task rail on desktop')
  await page.locator('.vc-run-item').filter({ hasText: '已中断' }).click()
  await page.locator('.vc-task-error-banner').getByText('vision-request-interrupted', { exact: false }).waitFor()
  assert(await page.locator('.vc-search-launch-status').getByRole('button', { name: '继续启动', exact: true }).count() === 0, 'interrupted run must not show duplicate launch retry button')
  assert((await page.locator('.vc-search-launch-status').innerText()).includes('会话内任务已中断'), 'launch strip should indicate session task interrupted')
  const resumePrimary = await page.locator('.vc-task-detail-header').getByRole('button', { name: '继续', exact: true }).evaluate(el => el.classList.contains('vc-primary-action'))
  const findSecondary = await page.locator('.vc-execution-nav').getByRole('button', { name: '按此画像找图', exact: true }).evaluate(el => !el.classList.contains('vc-primary-action'))
  assert(resumePrimary && findSecondary, 'resume must be primary while newTask becomes secondary on interrupted run')
  await page.screenshot({ path: '.playwright-mcp/search-feedback-multitask-interrupted.png' })

  // Verify narrow embedded container (600px inside 1440x900)
  await page.locator('.vc-page-frame').evaluate(el => { el.style.width = '600px' })
  assert(await page.locator('.vc-run-switcher-trigger').isVisible(), 'compact task switcher must appear in 600px narrow container')
  assert(!await page.locator('.vc-run-list').isVisible(), 'task rail must hide in 600px narrow container')
  assert(await page.locator('.vc-page-frame').evaluate(el => el.scrollWidth <= el.clientWidth + 1), '600px narrow container overflow')
  await page.screenshot({ path: '.playwright-mcp/search-feedback-container-600.png' })
  await page.locator('.vc-page-frame').evaluate(el => { el.style.width = '' })

  // Verify mobile 390x844 in light and dark themes
  await page.setViewportSize({ width: 390, height: 844 })
  assert(await page.locator('.vc-run-switcher-trigger').isVisible(), 'mobile compact task switcher missing')
  await page.locator('.vc-run-switcher-trigger').click()
  await page.getByRole('menuitem').first().click()
  assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'narrow workbench overflow')
  await page.screenshot({ path: '.playwright-mcp/search-feedback-workbench-narrow-light.png' })
  await page.evaluate(() => window.feedbackFixture.theme(true))
  await page.screenshot({ path: '.playwright-mcp/search-feedback-workbench-narrow-dark.png' })

  // Verify live refresh stability
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => window.feedbackFixture.setScenario('live-refresh', 'selected'))
  assert(await page.locator('.vc-result-card').count() === 2, 'live refresh should update selected cards to 2')

  const result = {
    capsuleInsideBody: true,
    keyboard: true,
    narrowBodyHidden: true,
    narrowViewportHidden: true,
    sessionIsolated: true,
    retainedOnDisconnect: true,
    recovered: true,
    scopedNavigation: true,
    workbenchFilters: true,
    sourceDiagnostic: true,
    detailModal: true,
    multiTaskAndInterrupted: true,
    narrowContainerAndMobile: true,
    liveRefreshStable: true,
    narrowOverflow: false,
    errors,
  }
  assert(errors.length === 0, errors.join('\n'))
  const expected = await page.evaluate(async () => (await fetch('search-feedback-ui.expected.json')).json())
  assert(JSON.stringify(result) === JSON.stringify(expected), 'browser facts differ from the owner-local expected output: ' + JSON.stringify(result))
  return result
}
