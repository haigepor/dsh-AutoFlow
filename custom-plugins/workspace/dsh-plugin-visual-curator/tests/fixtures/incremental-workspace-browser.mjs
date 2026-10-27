/** Read-only Playwright MCP acceptance over the named QA collections; progress responses are controlled and never write a real task. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const errors = [], reads = []
  const onError = error => errors.push(error.message)
  const onRequest = request => {
    if (request.url().endsWith('/api/visual-curator/data')) {
      const input = request.postDataJSON()
      if (input?.operation === 'references-list') reads.push(input.args.styleId)
    }
  }
  const select = async name => {
    await page.locator('.vc-collection-trigger').click()
    await page.getByRole('menuitem', { name, exact: true }).click()
    await page.waitForFunction(name => document.querySelector('.vc-collection-trigger')?.textContent.includes(name), name)
    await page.waitForFunction(() => !document.querySelector('.vc-reference-skeleton'))
  }
  const four = '验收 · 增量存储最终验收 · 10-27', base = '验收 · 逐张引用与缓存 · 10-27 · 基线', empty = '验收 · 创建与空状态 · 10-27'
  const baseline = await (await page.request.post('http://127.0.0.1:3080/api/visual-curator/gallery', { data: { operation: 'gallery-reference-tasks', args: {} } })).json()
  assert(baseline.ok, 'Real task inventory must be readable')
  let task, stops = 0
  const galleryHandler = async route => {
    const input = route.request().postDataJSON()
    if (input.operation === 'gallery-reference-tasks' && task) {
      const body = structuredClone(baseline)
      body.value.tasks = [task, ...body.value.tasks.filter(item => item.id !== task.id)]
      return route.fulfill({ json: body })
    }
    if (input.operation === 'gallery-collections' && task) return route.fulfill({ json: { ok: true, value: { items: [], nextCursor: null } } })
    if (input.operation === 'gallery-reference-stop' && task) {
      stops++
      task = { ...task, status: 'cancelled', completed: task.registered, registered: 0 }
      return route.fulfill({ json: { ok: true, value: task } })
    }
    return route.continue()
  }
  page.on('pageerror', onError); page.on('request', onRequest)
  await page.route('**/api/visual-curator/gallery', galleryHandler)
  try {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('tab', { name: '图片工作区', exact: true }).click()
    await select(four)
    await page.waitForFunction(() => document.querySelectorAll('.vc-reference-grid > figure').length === 4)
    await select(base)
    await page.waitForFunction(() => document.querySelectorAll('.vc-reference-grid > figure').length === 4)
    reads.length = 0
    for (const name of [four, base, four, base]) await select(name)
    assert(reads.length === 0, 'Warm collection switches must not reread reference pages')
    const cachedSwitchReads = reads.length
    const search = page.locator('.vc-image-search input')
    await search.fill('Chandler')
    for (let index = 0; index < 3; index++) {
      await page.getByRole('tab', { name: '找图与裁剪', exact: true }).click()
      assert(!(await page.locator('.vc-reference-panel').isVisible()), 'Execution must hide references')
      await page.getByRole('tab', { name: '参考与画像', exact: true }).click()
      assert(await page.locator('.vc-history-region .vc-execution-empty-art').count() === 0, 'Exit animation must not retain the previous page')
      assert(await search.inputValue() === 'Chandler', 'Tab switches retain the current search')
    }
    await search.fill('')
    await page.getByRole('tab', { name: '模型&图库设置', exact: true }).click()
    assert(!(await page.locator('.vc-workbench-panel').isVisible()), 'Settings must hide the image workspace')
    await page.getByRole('tab', { name: '图片工作区', exact: true }).click()
    await select(empty)
    await page.locator('.vc-reference-empty-art').waitFor()
    const illustrationLoaded = await page.locator('.vc-reference-empty-art').evaluate(image => image.complete && image.naturalWidth === 384 && image.naturalHeight === 288)
    assert(illustrationLoaded, 'Bundled transparent illustration must decode')
    await page.locator('.vc-import-empty').screenshot({ path: '.playwright-mcp/reference-empty-final-desktop.png', scale: 'css' })
    const noOverflow = async () => page.locator('.vc-workbench').evaluate(element => element.scrollWidth <= element.clientWidth + 1 && [...element.querySelectorAll('.vc-import-empty button')].every(button => button.getBoundingClientRect().right <= innerWidth + 1))
    await page.setViewportSize({ width: 390, height: 844 })
    // 原生侧栏在视口变化后执行收起动画，等待其释放内容宽度再检查最终布局。
    await page.waitForFunction(() => { const element = document.querySelector('.vc-workbench'); return element && element.clientWidth >= 280 && element.scrollWidth <= element.clientWidth + 1 })
    assert(await noOverflow(), 'Empty collection must fit a narrow viewport')
    await page.locator('.vc-workbench').screenshot({ path: '.playwright-mcp/reference-empty-final-narrow.png', scale: 'css' })
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    assert(await noOverflow(), 'Dark narrow collection must fit')
    await page.locator('.vc-workbench').screenshot({ path: '.playwright-mcp/reference-empty-final-dark.png', scale: 'css' })
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await page.setViewportSize({ width: 1440, height: 1000 })
    const response = await page.request.post('http://127.0.0.1:3080/api/visual-curator/data', { data: { operation: 'snapshot', args: {} } })
    const snapshot = (await response.json()).value, style = snapshot.styles.find(item => item.name === empty)
    assert(style, 'QA collection must exist')
    task = { id: 'c'.repeat(64), styleId: style.styleId, accountId: snapshot.configuration.source.unsplash.defaultAccountId, status: 'running', phase: 'referencing', total: 25, completed: 0, failed: 0, registered: 1, createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:01.000Z' }
    await page.waitForFunction(() => document.querySelector('.vc-gallery-task-status[data-active=true] [role=progressbar]')?.getAttribute('aria-valuenow') === '1')
    const track = page.locator('.vc-gallery-task-status[data-active=true] [role=progressbar]')
    const first = await track.evaluate(element => ({ width: element.firstElementChild.style.width, color: element.firstElementChild.style.backgroundColor, animated: getComputedStyle(element.firstElementChild, '::after').animationName !== 'none' }))
    task = { ...task, registered: 2, updatedAt: '2026-10-27T00:00:02.000Z' }
    await page.waitForFunction(() => document.querySelector('.vc-gallery-task-status[data-active=true] [role=progressbar]')?.getAttribute('aria-valuenow') === '2')
    const second = await track.evaluate(element => ({ width: element.firstElementChild.style.width, color: element.firstElementChild.style.backgroundColor }))
    assert(first.width === '4%' && second.width === '8%' && first.color !== second.color && first.animated, 'Progress fill and token mix must follow committed references and remain animated')
    const compact = await page.locator('.vc-gallery-task-status[data-active=true]').evaluate(element => ({ height: element.getBoundingClientRect().height, gap: parseFloat(getComputedStyle(element).marginBottom) }))
    assert(compact.height <= 60 && compact.gap >= 12, 'Progress card must stay compact with lower spacing')
    await page.locator('.vc-gallery-task-status[data-active=true]').screenshot({ path: '.playwright-mcp/gallery-live-progress-final.png', scale: 'css' })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reduced = await track.evaluate(element => getComputedStyle(element.firstElementChild, '::after').animationName === 'none')
    assert(reduced, 'Reduced-motion preference disables the scan')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.locator('.vc-add-reference').click()
    await page.getByRole('menuitem', { name: '引用图库收藏夹', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '引用图库收藏夹', exact: true })
    await dialog.locator('.vc-gallery-reference-footer').getByRole('status').waitFor()
    assert((await dialog.locator('.vc-gallery-reference-footer').innerText()).includes('2 / 25'), 'Reopened dialog must share live progress')
    await dialog.locator('.vc-gallery-reference-footer').getByRole('button', { name: '关闭', exact: true }).click()
    await page.locator('.vc-gallery-task-status[data-active=true]').getByRole('button').click()
    await page.waitForFunction(() => !document.querySelector('.vc-gallery-task-status[data-active=true]'))
    assert(stops === 1, 'Stop gesture must submit exactly once')
    assert(errors.length === 0, 'No uncaught browser errors')
    return { cachedSwitchReads, tabCycles: 3, previousPageArtifacts: 0, retainedSearch: true, illustrationLoaded, narrowOverflow: false, darkOverflow: false, progressPercent: [4, 8], progressColorChanged: true, shimmer: true, compactHeight: compact.height, lowerGap: compact.gap, reducedMotion: reduced, reopenedDialogProgress: '2 / 25', stopRequests: stops, realTasksChanged: false, pageErrors: errors }
  } finally {
    task = undefined
    await page.keyboard.press('Escape').catch(() => {})
    await page.unroute('**/api/visual-curator/gallery', galleryHandler)
    page.off('pageerror', onError); page.off('request', onRequest)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
}
