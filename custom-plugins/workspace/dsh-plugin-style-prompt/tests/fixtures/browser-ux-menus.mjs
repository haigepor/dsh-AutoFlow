/** Menus fit window edges and keep searchable choices, focus and running feedback consistent. */
async page => {
  await page.setViewportSize({ width: 1580, height: 1000 })
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const openEntry = async () => { const nav = page.getByRole('navigation', { name: '全局面板' }); await nav.waitFor(); const entry = nav.getByRole('button', { name: '风格提示词', exact: true }); if (!await entry.isVisible()) await nav.getByRole('button', { name: '更多', exact: true }).click(); await entry.click(); await page.waitForFunction(() => document.querySelector('.sp-canvas-page')?.getAttribute('data-canvas-id')); await page.locator('.sp-canvas-header').click({ position: { x: 4, y: 4 } }) }
  const directory = async route => {
    if (route.request().postDataJSON().operation !== 'canvas/models') { await route.continue(); return }
    const response = await route.fetch(), json = await response.json(), base = json.value.models[0]
    json.value.models = [base, ...Array.from({ length: 5 }, (_, index) => ({ ...base, id: `menu-only-${index}`, name: `Search fixture ${index}` }))]
    await route.fulfill({ response, json })
  }
  await page.route('**/api/style-prompt/data', directory)
  try {
    await page.reload(); await openEntry()
    const trigger = page.locator('.react-flow__node[data-id="node-6"]').getByRole('button', { name: '项目生图模型', exact: true })
    await trigger.click()
    const search = page.getByRole('textbox', { name: '搜索已配置的模型', exact: true })
    await search.fill('No match for this query')
    await page.getByRole('status').filter({ hasText: '没有匹配的模型' }).waitFor()
    assert(await search.evaluate(el => el === document.activeElement), 'Filtering retains search focus')
    await search.fill('Synthetic image'); await search.press('Enter')
    await page.locator('.sp-model-menu').waitFor({ state: 'hidden' })
    assert((await trigger.innerText()).includes('Synthetic image'), 'Enter selects the real filtered image model')
    await trigger.click(); await page.keyboard.press('Escape'); assert(await page.locator('.sp-model-menu').count() === 0, 'Escape dismisses model choices')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: '添加节点', exact: true }).click()
    const palette = page.locator('.sp-canvas-node-menu'), bounds = await palette.boundingBox()
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, 'Node menu fits the narrow viewport')
    const input = page.getByRole('textbox', { name: '搜索节点', exact: true }), inputBounds = await input.boundingBox()
    assert(inputBounds && inputBounds.x + inputBounds.width <= bounds.x + bounds.width, 'Search input stays inside the menu')
    await input.fill('unavailable node'); await page.getByRole('status').filter({ hasText: '没有匹配的节点' }).waitFor()
    await page.keyboard.press('Escape')
    assert(!await page.locator('html').evaluate(el => el.scrollWidth > window.innerWidth), 'The narrow canvas has no page overflow')
    await page.getByRole('button', { name: '更多操作', exact: true }).click(); await page.getByRole('menuitem', { name: '参考素材', exact: true }).click()
    await page.getByText(/素材名额已用/).waitFor()
    const dialog = page.getByRole('dialog', { name: '参考素材', exact: true }), modalBounds = await dialog.boundingBox()
    assert(modalBounds && modalBounds.x >= 0 && modalBounds.x + modalBounds.width <= 390, 'Asset dialog fits narrow windows')
    await page.screenshot({ path: 'D:/project/deepseek-harness/.artifacts/style-prompt-canvas/ux-final-narrow.png' })
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click()
    await page.setViewportSize({ width: 1580, height: 1000 })
  } finally { await page.unroute('**/api/style-prompt/data', directory) }
  await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: '外观主题', exact: true }).click(); await page.getByRole('button', { name: '深色', exact: true }).click(); await page.getByRole('button', { name: '返回', exact: true }).click(); await openEntry()
  await page.evaluate(async () => { await fetch('/api/style-prompt/test-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'image-waiting' }) }) })
  await page.locator('.react-flow__node[data-id="node-6"]').getByRole('button', { name: '运行节点', exact: true }).click()
  await page.locator('.sp-wire-flow').first().waitFor({ state: 'attached' })
  const animation = await page.locator('.sp-wire-flow').first().evaluate(el => getComputedStyle(el).animationName)
  assert(animation === 'sp-wire-motion', 'Only live dependency wires animate')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert(await page.locator('.sp-wire-flow').first().evaluate(el => getComputedStyle(el).display) === 'none', 'Reduced motion suppresses wire flow')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.screenshot({ path: 'D:/project/deepseek-harness/.artifacts/style-prompt-canvas/ux-final-dark-running.png' })
  await page.locator('.sp-current-run').getByRole('button', { name: '停止任务', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.sp-wire-flow').length === 0)
  await page.evaluate(async () => { await fetch('/api/style-prompt/test-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'success' }) }) })
  return { searchableModelMenu: true, keyboardAndEscape: true, narrowMenuAndDialog: true, liveWireAnimation: true, reducedMotion: true }
}
