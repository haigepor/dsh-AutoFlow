/** Verify the native overlay height and actual scrolling, without model requests. */
async (page) => {
  const errors = [], assert = (value, message) => { if (!value) throw new Error(message) }
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/visual-curator/resource**', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#34534a"/></svg>' }))
  await page.setViewportSize({ width: 1920, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.reload()
  const dock = page.locator('[data-conversation-task]'), todos = page.getByTestId('todo-panel'), expand = dock.getByRole('button', { name: '展开结果', exact: true })
  await expand.waitFor()
  assert(await dock.count() === 1 && await dock.evaluate(node => !!node.closest('[data-conversation-body-overlay]') && !node.closest('[data-fixture-process]')), 'task card escaped its Session overlay')
  await expand.click(); await dock.locator('.vc-conversation-task-previews img').last().waitFor()
  const measure = () => page.evaluate(() => {
    const card = document.querySelector('[data-conversation-task]'), panel = document.querySelector('[data-conversation-body-overlay]'), todo = document.querySelector('[data-testid="todo-panel"]'), details = card.querySelector('.vc-conversation-task-details')
    const a = card.getBoundingClientRect(), b = panel.getBoundingClientRect(), c = todo.getBoundingClientRect()
    return { cardHeight: a.height, cardBottom: a.bottom, overlayBottom: b.bottom, gap: a.top - c.bottom, detailsHeight: details.clientHeight, detailsScrollHeight: details.scrollHeight }
  })
  const desktop = await measure()
  assert(Math.abs(desktop.cardBottom - desktop.overlayBottom) < 1 && desktop.gap === 8, 'card does not fill remaining height')
  await todos.getByRole('button').click(); const expandedTodo = await measure()
  assert(expandedTodo.cardHeight < desktop.cardHeight && Math.abs(expandedTodo.cardBottom - expandedTodo.overlayBottom) < 1, 'todo expansion does not reallocate height')
  await page.setViewportSize({ width: 1920, height: 500 }); const compact = await measure(), details = dock.locator('.vc-conversation-task-details')
  assert(compact.detailsScrollHeight > compact.detailsHeight, 'short viewport has no internal scrolling')
  const heading = await dock.locator('.vc-conversation-task-header').boundingBox()
  await details.hover(); await page.mouse.wheel(0, 500); await page.waitForFunction(() => document.querySelector('.vc-conversation-task-details').scrollTop > 0)
  assert(Math.abs((await dock.locator('.vc-conversation-task-header').boundingBox()).y - heading.y) < 1, 'results scrolling moves controls')
  const resize = dock.getByRole('separator'), beforeWidth = (await dock.boundingBox()).width
  await resize.focus(); await page.keyboard.press('ArrowLeft'); assert((await dock.boundingBox()).width === beforeWidth + 24, 'keyboard resizing changed')
  await dock.getByRole('button', { name: '收起结果', exact: true }).focus(); await page.keyboard.press('Escape')
  assert(await expand.getAttribute('aria-expanded') === 'false' && await expand.evaluate(node => node === document.activeElement), 'collapse focus changed')
  await page.setViewportSize({ width: 390, height: 844 }); assert(!await dock.isVisible() && !await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'narrow layout changed')
  await page.setViewportSize({ width: 1920, height: 900 }); await page.evaluate(() => window.dockFixture.session('b')); await dock.getByText('另一个会话的找图任务', { exact: true }).waitFor()
  assert(await dock.getByRole('button', { name: '展开结果', exact: true }).getAttribute('aria-expanded') === 'false', 'Session expansion leaked')
  const result = { singleDock: true, outsideProcess: true, fillsRemainingHeight: true, todoReflowsHeight: true, innerScroll: true, controlsRemainVisible: true, resizingRetained: true, collapseFocus: true, narrowHidden: true, sessionIsolated: true, horizontalOverflow: false, errors }
  const expected = await page.evaluate(async () => (await fetch('expected.json')).json()); assert(JSON.stringify(result) === JSON.stringify(expected), 'saved output differs')
  return { result, measurements: { desktop, expandedTodo, compact } }
}
