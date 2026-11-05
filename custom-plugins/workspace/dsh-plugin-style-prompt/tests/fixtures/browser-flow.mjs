/** Playwright MCP on a keyless scratch profile: open a starter canvas and import its reference before running. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const errors = [], operations = []
  const captureError = error => errors.push(String(error))
  const captureRequest = request => {
    if (request.url().endsWith('/api/style-prompt/data') && request.method() === 'POST') operations.push(request.postDataJSON().operation)
  }
  page.on('pageerror', captureError); page.on('request', captureRequest)
  const node = id => page.locator(`.react-flow__node[data-id="${id}"]`)
  const fit = async () => {
    await page.getByRole('button', { name: '缩放比例', exact: true }).click()
    await page.getByRole('menuitem', { name: '显示全部节点', exact: true }).click()
  }
  const control = mode => page.evaluate(async mode => {
    const response = await fetch('/api/style-prompt/test-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) })
    if (!response.ok) throw new Error('Fixture control failed')
  }, mode)
  try {
    await fit()
    assert(await node('node-1').locator('img').count() > 0, 'Import a reference into the starter reference node first')
    for (const [id, label, model] of [['node-2', '项目视觉模型', /Style Prompt · Keyless fixture/], ['node-5', '项目文本模型', /Style Prompt · Keyless fixture/], ['node-6', '项目生图模型', /Style Prompt · Synthetic image/]]) {
      await node(id).getByRole('button', { name: label, exact: true }).click()
      await page.getByRole('menuitem', { name: model }).click()
    }
    await node('node-4').getByRole('textbox', { name: '新主体或场景 · 中文', exact: true }).fill('街角咖啡店')
    await node('node-4').getByRole('textbox', { name: '希望改变的内容 · 中文', exact: true }).fill('店面偏右，横向街景')
    await page.getByRole('button', { name: '运行工作流', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-id="node-7"] .sp-node')?.getAttribute('data-status') === 'succeeded')
    assert(await page.locator('.sp-node[data-status="succeeded"]').count() === 7, 'Every connected starter node completes')
    assert(await node('node-3').locator('input:checked').count() === 2, 'Only transferable rules are selected')
    assert(await node('node-6').getByRole('textbox', { name: '生图提示词', exact: true }).isDisabled(), 'Connected prompts disable manual entry')
    await page.waitForFunction(() => document.querySelector('[data-id="node-7"] img')?.naturalWidth > 0)
    assert(await node('node-7').locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), 'Result previews decode through authenticated attachment routes')
    await fit()
    await node('node-4').locator('.sp-node-titlebar').click()
    for (const id of ['node-5', 'node-6', 'node-7']) await node(id).locator('.sp-node-titlebar').click({ modifiers: ['Shift'] })
    await page.getByRole('button', { name: '复制分支', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 11)
    const selection = await page.locator('.react-flow__node.selected').first().getAttribute('data-id')
    assert(selection !== 'node-4', 'The copied branch has new identities')
    await page.getByRole('button', { name: '运行选中节点', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.sp-node[data-status="succeeded"]').length === 11)
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出画布', exact: true }).click()
    await (await download).saveAs('D:/project/deepseek-harness/.artifacts/style-prompt-canvas/qa-canvas.json')
    await fit()
    await control('image-waiting')
    await node('node-6').getByRole('button', { name: '运行节点', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-id="node-6"] .sp-node')?.getAttribute('data-status') === 'running')
    assert(await page.locator('.sp-wire-flow').count() > 0, 'Only active dependencies render flow overlays')
    assert(await node('node-6').locator('img').count() > 0, 'The previous successful image remains visible while rerunning')
    const motion = await page.locator('.sp-wire-flow').first().evaluate(async path => {
      const first = getComputedStyle(path).strokeDashoffset
      await new Promise(resolve => setTimeout(resolve, 150))
      return { first, next: getComputedStyle(path).strokeDashoffset }
    })
    assert(motion.first !== motion.next, 'Running links actually animate')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert(await page.locator('.sp-wire-flow').first().evaluate(path => getComputedStyle(path).display === 'none'), 'Reduced motion keeps a static active line')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.locator('.sp-current-run').getByRole('button', { name: '停止任务', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-id="node-6"] .sp-node')?.getAttribute('data-status') === 'cancelled')
    assert(await page.locator('.sp-wire-flow').count() === 0, 'Stopped work has no animated links')
    assert(await node('node-6').locator('img').count() > 0, 'Cancellation retains the successful preview')
    await control('invalid')
    await node('node-2').getByRole('button', { name: '运行节点', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-id="node-2"] .sp-node')?.getAttribute('data-status') === 'failed')
    assert((await node('node-2').innerText()).includes('返回的数据不完整'), 'Malformed model output is localized beside its node')
    await control('success')
    assert(await page.locator('.sp-canvas-bottom').count() === 0, 'No persistent bottom history bar')
    assert(errors.length === 0, `No uncaught page errors: ${errors.join('; ')}`)
    return { passed: ['native attachments', 'vision and text routes', 'image provider', 'branch copy and execution', 'canvas export', 'active-link animation', 'reduced motion', 'cancellation', 'retained previous results', 'invalid model output'], operations, pageErrors: errors }
  } finally {
    await control('success'); await page.emulateMedia({ reducedMotion: 'no-preference' })
    page.off('pageerror', captureError); page.off('request', captureRequest)
  }
}
