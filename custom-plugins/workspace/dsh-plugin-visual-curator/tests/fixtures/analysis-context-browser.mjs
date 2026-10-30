/** Read-only UI acceptance: real saved work plus isolated token-reporting states; no model starts or writes. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const read = async (operation, args = {}) => (await (await page.request.post(new URL('/api/visual-curator/data', page.url()).href, { data: { operation, args } })).json()).value
  const tasks = async () => (await (await page.request.post(new URL('/api/visual-curator/gallery', page.url()).href, { data: { operation: 'gallery-reference-tasks', args: {} } })).json()).value.analyses
  const before = await tasks(), task = before.find(item => item.name === '测试训练' && item.status === 'completed')
  assert(task, 'A completed reference analysis is required for read-only acceptance')
  const saved = await read('analysis-detail', { runId: task.runId })
  const main = saved.requests.filter(request => request.operation !== null).at(-1)
  assert(main?.native?.context?.contextWindow > 0 && main.native.usage, 'The live Host must project recorded native capacity and usage')
  let mode = 'actual', mutations = 0
  const errors = [], onError = error => errors.push(error.message)
  const originalDark = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
  const measured = { ...main.native, context: { contextWindow: 1_000_000 }, usage: { inputTokens: 20_000, cacheReadTokens: 5_000, cacheWriteTokens: 2_000, outputTokens: 13_000, reasoningTokens: 8_000 } }
  const view = () => {
    if (mode === 'actual') return saved
    const native = { ...measured }
    if (mode === 'pending') { native.context = { contextWindow: 200_000 }; delete native.usage }
    if (mode === 'historical') delete native.context
    if (mode === 'zero') native.usage = { inputTokens: 0, outputTokens: 0 }
    if (mode === 'overflow') { native.context = { contextWindow: 1_000 }; native.usage = { inputTokens: 1_100, outputTokens: 100 } }
    const requests = saved.requests.map(request => request.requestId === main.requestId ? { ...request, state: mode === 'pending' ? 'reserved' : 'committed', native } : request)
    requests.push({ ...main, requestId: 'context-ui-auxiliary-compaction', operation: null, model: null, imageIds: [], available: false, native: { ...measured, context: { contextWindow: 128_000 }, usage: { inputTokens: 100_000, outputTokens: 20_000 } } })
    return { ...saved, requests, task: { ...saved.task, ...(mode === 'pending' ? { status: 'running', phase: 'receiving' } : {}) } }
  }
  const data = async route => {
    const input = route.request().postDataJSON()
    // 各读数场景单独验证首次读取，缓存命中由 analysis-loading-browser 覆盖。
    if (input.operation === 'snapshot') {
      const response = await route.fetch(), body = await response.json()
      body.value.configuration.limits.analysisCacheTtlMs = 0
      return route.fulfill({ response, json: body })
    }
    if (['reference-analyze', 'run-control', 'profile-save', 'export-start'].includes(input.operation)) { mutations++; return route.abort('blockedbyclient') }
    if (input.operation === 'analysis-detail' && input.args.runId === task.runId) return route.fulfill({ json: { ok: true, value: view() } })
    return route.continue()
  }
  const stream = async route => {
    if (route.request().postDataJSON().args.runId !== task.runId) return route.continue()
    await new Promise(resolve => setTimeout(resolve, 200))
    const detail = view()
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ runId: task.runId, status: detail.task.status, process: detail.process, checkpoint: true })}\n\n` })
  }
  const modal = page.locator('.vc-analysis-modal')
  const reading = () => modal.locator('.vc-context-usage:visible')
  const ring = () => reading().getByRole('progressbar', { name: '上下文占用', exact: true })
  const open = async () => { await page.locator('.vc-profile-dock').getByRole('button', { name: '分析过程', exact: true }).click(); await modal.locator('.vc-process-model').waitFor() }
  const close = async () => { await modal.getByRole('button', { name: '关闭', exact: true }).first().click(); await modal.waitFor({ state: 'hidden' }) }
  await page.route('**/api/visual-curator/data', data)
  await page.route('**/api/visual-curator/analysis-stream', stream)
  page.on('pageerror', onError)
  try {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '训练图片工作台', exact: true }).click()
    await page.locator('.vc-collection-trigger').click()
    await page.getByRole('menuitem', { name: task.name, exact: true }).click()
    await open()
    const liveUsed = main.native.usage.inputTokens + (main.native.usage.cacheReadTokens ?? 0) + (main.native.usage.cacheWriteTokens ?? 0) + main.native.usage.outputTokens
    assert(await ring().getAttribute('aria-valuenow') === String(Math.min(100, liveUsed / main.native.context.contextWindow * 100)), 'The real reading must use a single recorded request')
    await close()
    mode = 'pending'; await open()
    assert(await ring().getAttribute('aria-valuenow') === null, 'Pending usage must not inherit the preceding request')
    assert(await reading().getByText('200,000', { exact: true }).isVisible(), 'Pending usage must retain its own recorded capacity')
    assert(await reading().getByText('等待服务返回本次用量', { exact: true }).isVisible(), 'Pending state must be explicit')
    mode = 'measured'
    await page.waitForFunction(() => document.querySelector('.vc-process-context .vc-context-ring')?.getAttribute('aria-valuenow') === '4')
    assert(await reading().getByText('40,000', { exact: true }).isVisible(), 'Reported cache and output buckets must count once')
    assert(await reading().getByText('1,000,000', { exact: true }).isVisible(), 'Auxiliary compaction capacity must not replace analysis capacity')
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
      await modal.locator('.vc-context-usage:visible').screenshot({ path: `.playwright-mcp/context-ring-${dark ? 'dark' : 'light'}.png`, scale: 'css' })
    }
    await page.setViewportSize({ width: 1040, height: 900 })
    assert(await modal.locator('.vc-process-mobile-context').isVisible(), 'Compact desktop dialogs must retain the context reading')
    await page.setViewportSize({ width: 390, height: 844 })
    assert(await ring().getAttribute('aria-valuenow') === '4', 'Narrow dialogs must preserve the same reading')
    assert(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Narrow context content must not overflow')
    assert(await modal.locator('.vc-chat-feed').evaluate(el => el.clientHeight > 100), 'Context details must leave space for the conversation')
    await modal.screenshot({ path: '.playwright-mcp/context-ring-mobile.png', scale: 'css' })
    await close(); await page.setViewportSize({ width: 1440, height: 1000 })
    mode = 'historical'; await open()
    assert(await ring().getAttribute('aria-valuenow') === null, 'Missing historical capacity must not be filled from current settings')
    assert(await reading().getByText('40,000', { exact: true }).isVisible(), 'Historical reported usage must remain readable')
    assert(await reading().getByText('本次请求未记录模型容量', { exact: true }).isVisible(), 'Missing capacity must be explicit')
    await close(); mode = 'zero'; await open()
    assert(await ring().getAttribute('aria-valuenow') === '0', 'Measured zero must remain distinct from unavailable usage')
    await close(); mode = 'overflow'; await open()
    assert(await ring().getAttribute('aria-valuenow') === '100', 'Overflow must bound the ring')
    assert(await reading().getByText('1,200', { exact: true }).isVisible(), 'Overflow must retain the actual token count')
    await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' })
    assert(await page.locator('.vc-profile-dock').getByRole('button', { name: '分析过程', exact: true }).evaluate(el => el === document.activeElement), 'Escape must restore the invoking control')
    await page.locator('.vc-profile-dock').getByRole('button', { name: '查看完整档案', exact: true }).click()
    const profile = page.locator('.vc-profile-dialog')
    await profile.locator('.vc-profile-pane-heading').first().waitFor()
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
      const values = await profile.locator('.vc-profile-pane-heading').evaluateAll(headings => headings.map(heading => {
        const style = getComputedStyle(heading), probe = document.createElement('span')
        probe.style.backgroundColor = 'var(--dsw-alias-bg-layer-2)'; heading.append(probe)
        const expected = getComputedStyle(probe).backgroundColor; probe.remove()
        const luminance = color => {
          const [r, g, b] = color.match(/[\d.]+/g).map(Number).map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        const text = luminance(getComputedStyle(heading.querySelector('h3')).color), background = luminance(style.backgroundColor)
        const pane = heading.parentElement; pane.scrollTop = pane.scrollHeight
        return { matches: style.backgroundColor === expected, contrast: (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05), sticky: Math.abs(heading.getBoundingClientRect().top - pane.getBoundingClientRect().top) <= 1 }
      }))
      assert(values.length === 2 && values.every(value => value.matches && value.contrast >= 4.5 && value.sticky), 'Both profile headings must use the theme surface with readable text and sticky coverage')
      await profile.locator('.vc-profile-rules, .vc-profile-evidence').evaluateAll(panes => panes.forEach(pane => { pane.scrollTop = 0 }))
      const box = await profile.boundingBox()
      await page.screenshot({ path: `.playwright-mcp/profile-headings-${dark ? 'dark' : 'light'}.png`, clip: { ...box, height: 200 }, scale: 'css' })
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await profile.getByRole('tab', { name: '图片与依据', exact: true }).click()
    assert(await profile.locator('.vc-profile-evidence .vc-profile-pane-heading').isVisible(), 'The refined evidence heading must remain available on mobile')
    assert(await profile.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Profile headings must not introduce narrow overflow')
    await page.keyboard.press('Escape')
    const after = await tasks(), persisted = await read('analysis-detail', { runId: task.runId })
    assert(after.length === before.length && persisted.requests.length === saved.requests.length && mutations === 0, 'Presentation checks must leave analysis history and model call counts unchanged')
    assert(errors.length === 0, `Page errors: ${errors.join('; ')}`)
    return { latestRequestOnly: true, usedTokens: 40000, capacity: 1000000, percent: 4, pendingToReported: true, historicalUnavailable: true, measuredZero: true, overflowBounded: true, compactContextVisible: true, narrowOverflow: false, focusRestored: true, profileThemeSurface: true, profileTextContrast: true, stickyHeaders: true, profileMobileEvidence: true, modelRequestsUnchanged: true, dataWritten: false, pageErrors: errors }
  } finally {
    page.off('pageerror', onError)
    await page.keyboard.press('Escape')
    await page.unroute('**/api/visual-curator/data', data)
    await page.unroute('**/api/visual-curator/analysis-stream', stream)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), originalDark)
  }
}
