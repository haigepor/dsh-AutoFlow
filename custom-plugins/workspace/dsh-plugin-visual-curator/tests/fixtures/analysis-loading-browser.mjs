/** Controlled read latency; the caller supplies ModelsSkeleton.module.css through the second argument. */
async (page, settingsCss) => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const read = async (operation, args = {}) => (await (await page.request.post(new URL('/api/visual-curator/data', page.url()).href, { data: { operation, args } })).json()).value
  const tasks = async () => (await (await page.request.post(new URL('/api/visual-curator/gallery', page.url()).href, { data: { operation: 'gallery-reference-tasks', args: {} } })).json()).value.analyses
  const before = await tasks(), task = before.find(item => item.name === '测试训练' && item.status === 'completed')
  assert(task, 'A completed saved analysis is required')
  const saved = await read('analysis-detail', { runId: task.runId })
  const configuration = await read('config-read')
  assert(configuration.limits.analysisCacheTtlMs === 60_000, 'The live Host must supply the default cache lifetime')
  assert(typeof settingsCss === 'string' && settingsCss.includes('.bar::after'), 'Read the native ModelsSkeleton.module.css before invoking this scenario')
  const referenceCss = [settingsCss.match(/\.bar \{[^}]+\}/)?.[0], settingsCss.match(/\.bar::after \{[^}]+\}/)?.[0], settingsCss.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0]].join('\n').replaceAll('.bar', '.qa-settings-skeleton')
  let release, hold = true, reads = 0, inputReads = 0, writes = 0
  let gate = new Promise(resolve => { release = resolve })
  const errors = [], onError = error => errors.push(error.message)
  const originalDark = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
  const data = async route => {
    const input = route.request().postDataJSON()
    if (['reference-analyze', 'run-control', 'profile-save', 'export-start', 'config-save'].includes(input.operation)) { writes++; return route.abort('blockedbyclient') }
    if (input.operation === 'analysis-detail' && input.args.runId === task.runId) {
      reads++
      if (hold) await gate
      return route.fulfill({ json: { ok: true, value: saved } })
    }
    if (input.operation === 'analysis-input' && input.args.runId === task.runId) inputReads++
    return route.continue()
  }
  const modal = page.locator('.vc-analysis-modal'), sidebar = modal.locator('.vc-process-context')
  const open = () => page.locator('.vc-profile-dock').getByRole('button', { name: '分析过程', exact: true }).click()
  const close = async () => { await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' }) }
  const inViewport = locator => locator.evaluate(el => { const box = el.getBoundingClientRect(); return box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth })
  const styleMatches = async () => page.evaluate(() => {
    const reference = document.querySelector('.qa-settings-skeleton')
    const candidates = [document.querySelector('.vc-chat-loading .vc-skeleton-fill'), document.querySelector('.vc-process-facts .vc-skeleton-fill'), document.querySelector('.qa-gallery-skeleton')]
    const signature = element => {
      const base = getComputedStyle(element), after = getComputedStyle(element, '::after')
      return [base.backgroundColor, after.backgroundImage, after.animationDuration, after.animationTimingFunction, after.animationIterationCount].join('|')
    }
    return candidates.every(element => element && signature(element) === signature(reference))
  })
  await page.route('**/api/visual-curator/data', data)
  page.on('pageerror', onError)
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '训练图片工作台', exact: true }).click()
    await page.locator('.vc-collection-trigger').click()
    await page.getByRole('menuitem', { name: task.name, exact: true }).click()
    await open(); await sidebar.locator('.vc-model-skeleton').waitFor()
    assert(await modal.locator('.vc-chat-loading').isVisible(), 'Conversation loading must use a skeleton')
    assert(await sidebar.locator('.vc-context-skeleton').isVisible(), 'Context loading must use a skeleton')
    assert(await sidebar.locator('.vc-navigation-skeleton-row').count() === 4, 'Navigation loading must reserve four rows')
    assert(await modal.getByText('本次请求未记录模型容量', { exact: true }).count() === 0, 'Loading must not present missing historical metadata')
    assert(await modal.locator('.vc-chat-loading').innerText() === '', 'Loading must match the settings treatment without extra shimmering text')
    await page.evaluate(css => {
      const style = document.createElement('style'); style.id = 'qa-settings-skeleton-style'; style.textContent = css; document.head.append(style)
      for (const name of ['qa-settings-skeleton', 'qa-gallery-skeleton vc-gallery-skeleton-fill']) {
        const probe = document.createElement('span'); probe.className = name; probe.setAttribute('aria-hidden', 'true'); probe.style.cssText = 'position:fixed;left:-1000px;top:0;width:100px;height:12px'; document.body.append(probe)
      }
    }, referenceCss)
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
      assert(await styleMatches(), 'Analysis, sidebar and gallery skeletons must match the actual Settings CSS in both themes')
    }
    await sidebar.screenshot({ path: '.playwright-mcp/analysis-sidebar-skeleton-dark.png', scale: 'css' })
    await modal.locator('.vc-chat-loading').screenshot({ path: '.playwright-mcp/analysis-conversation-skeleton-dark.png', scale: 'css' })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert(await modal.locator('.vc-skeleton-fill').first().evaluate(el => getComputedStyle(el, '::after').display === 'none'), 'Reduced motion must stop the sheen')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.setViewportSize({ width: 390, height: 844 })
    assert(await modal.locator('.vc-process-mobile-context .vc-context-skeleton').isVisible(), 'Compact context must also show its loading skeleton')
    assert(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Compact skeletons must not overflow')
    hold = false; release()
    await modal.locator('.vc-final-summary').waitFor()
    await page.setViewportSize({ width: 1440, height: 900 })
    const navigation = sidebar.locator('.vc-process-navigation nav'), links = navigation.locator('.vc-process-batch-link')
    await links.first().waitFor()
    await navigation.evaluate(el => { el.scrollTop = 0 })
    const fourVisible = await navigation.evaluate(nav => [...nav.querySelectorAll('.vc-process-batch-link')].slice(0, 4).every(row => row.getBoundingClientRect().bottom <= nav.getBoundingClientRect().bottom + 1))
    assert(await links.count() >= 4 && fourVisible, 'A normal desktop height must show four navigation rows together')
    assert(await inViewport(sidebar.locator('.vc-process-log-toggle')), 'The activity action must remain in view')
    await sidebar.screenshot({ path: '.playwright-mcp/analysis-navigation-expanded-dark.png', scale: 'css' })
    await links.first().click()
    const firstInput = modal.locator('.vc-request-input').first()
    await firstInput.waitFor(); await firstInput.locator('.vc-input-skeleton').waitFor({ state: 'hidden' })
    const initialReads = reads, initialInputs = inputReads
    assert(initialReads === 1 && initialInputs > 0, 'The cold view must finish one detail read and lazy input reads')
    await close(); await open()
    assert(await modal.locator('.vc-chat-loading').count() === 0 && await sidebar.locator('.vc-model-skeleton').count() === 0, 'A fresh cache hit must not flash skeletons')
    await sidebar.locator('.vc-process-batch-link').first().click()
    await modal.locator('.vc-request-input').first().waitFor()
    assert(await modal.locator('.vc-request-input').first().locator('.vc-input-skeleton').count() === 0, 'Previously inspected input must be restored immediately')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert(reads === initialReads && inputReads === initialInputs, 'Warm reopening must not request detail or saved inputs again')
    await page.setViewportSize({ width: 1440, height: 650 })
    assert(await inViewport(sidebar.locator('.vc-process-log-toggle')), 'Short windows must keep the bottom action reachable')
    const independent = await sidebar.locator('.vc-process-facts').evaluate(facts => {
      const nav = facts.parentElement.querySelector('.vc-process-navigation'), before = nav.getBoundingClientRect().top
      facts.scrollTop = facts.scrollHeight
      return facts.scrollTop > 0 && Math.abs(nav.getBoundingClientRect().top - before) <= 1
    })
    assert(independent, 'Model information must scroll without moving batch navigation')
    await page.setViewportSize({ width: 1440, height: 1200 })
    assert((await modal.boundingBox()).height > 1000, 'Tall windows must use the increased dialog height')
    await close(); await page.setViewportSize({ width: 1440, height: 900 })
    hold = true; gate = new Promise(resolve => { release = resolve })
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/visual-curator/data') && response.request().postDataJSON()?.operation === 'snapshot')
    await page.locator('.vc-workbench').getByRole('button', { name: '刷新', exact: true }).click(); await refreshed
    await open(); await sidebar.locator('.vc-model-skeleton').waitFor()
    assert(reads === 2, 'Manual refresh must invalidate cached detail')
    hold = false; release(); await modal.locator('.vc-final-summary').waitFor(); await close()
    const after = await tasks(), persisted = await read('analysis-detail', { runId: task.runId })
    assert(after.length === before.length && persisted.requests.length === saved.requests.length && writes === 0, 'Loading and caching must not start models or write business data')
    assert(errors.length === 0, `Page errors: ${errors.join('; ')}`)
    return { coldConversationSkeleton: true, coldContextSkeleton: true, coldNavigationRows: 4, settingsStyleParity: true, reducedMotion: true, compactSkeleton: true, missingCapacityNotShownWhileLoading: true, coldDetailReads: 1, warmDetailReads: 0, warmInputReads: 0, manualRefreshInvalidates: true, fourNavigationRowsVisible: true, modelFactsScrollIndependently: true, shortWindowActionVisible: true, tallerDialog: true, narrowOverflow: false, modelRequestsUnchanged: true, dataWritten: false, pageErrors: errors }
  } finally {
    hold = false; release()
    page.off('pageerror', onError)
    await page.keyboard.press('Escape')
    await page.unroute('**/api/visual-curator/data', data)
    await page.evaluate(() => document.querySelectorAll('#qa-settings-skeleton-style,.qa-settings-skeleton,.qa-gallery-skeleton').forEach(el => el.remove()))
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), originalDark)
  }
}
