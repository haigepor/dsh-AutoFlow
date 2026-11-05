/** Native File/DataTransfer admission and searchable project Menu on the real canvas. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const initial = await page.locator('.react-flow__node').count()
  const image = page.locator('.sp-node[data-kind="reference"] img').first()
  const pixels = await image.evaluate(async image => Array.from(new Uint8Array(await (await fetch(image.currentSrc)).arrayBuffer())))
  const transfer = await page.evaluateHandle(pixels => {
    const data = new DataTransfer(); data.items.add(new File([new Uint8Array(pixels)], 'dropped-reference.png', { type: 'image/png' })); return data
  }, pixels)
  await page.locator('.sp-flow-container').dispatchEvent('drop', { dataTransfer: transfer, clientX: 650, clientY: 350 })
  await page.waitForFunction(count => document.querySelectorAll('.react-flow__node').length > count, initial)
  await transfer.dispose()
  const count = await page.locator('.react-flow__node').count()
  await page.locator('input[type="file"][multiple]').setInputFiles({ name: 'not-an-image.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') })
  assert(await page.locator('.react-flow__node').count() === count, 'Unsupported file leaves the graph unchanged')
  await page.getByRole('button', { name: '添加节点', exact: true }).click()
  const search = page.getByRole('textbox', { name: '搜索节点', exact: true })
  await search.waitFor()
  assert(await search.evaluate(input => input === document.activeElement), 'The node search receives focus')
  await search.fill('missing-node')
  await page.getByRole('status').filter({ hasText: '没有匹配的节点' }).waitFor()
  assert(await search.isVisible(), 'An empty search keeps its menu and input visible')
  await search.fill('生图')
  assert(await page.locator('.sp-canvas-node-menu button[role="menuitem"]:not(:disabled)').count() === 1, 'Search filters compatible node names')
  await search.press('Escape')
  await page.locator('.sp-canvas-node-menu').waitFor({ state: 'detached' })
  return { passed: ['canvas file drop', 'invalid file feedback', 'focused search', 'empty search', 'filtered nodes', 'Escape dismissal'] }
}
