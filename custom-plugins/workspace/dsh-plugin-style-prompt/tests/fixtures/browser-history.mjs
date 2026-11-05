/** Reading existing prompt history never needs a new model request. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const api = action => page.evaluate(async action => {
    const value = await (await fetch('/api/style-prompt/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })).json()
    if (!value.ok) throw new Error(value.error.code)
    return value.value
  }, action)
  const history = await api({ operation: 'list' }), models = []
  const index = history.tasks.findIndex(task => task.kind === 'generation' && task.status === 'succeeded')
  assert(index >= 0, 'The scratch profile needs a successful prompt record')
  const original = await api({ operation: 'get', id: history.tasks[index].id })
  const onRequest = request => { if (request.url().endsWith('/api/style-prompt/data') && request.method() === 'POST' && request.postDataJSON().operation === 'canvas/run') models.push(request.postDataJSON().id) }
  page.on('request', onRequest)
  try {
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '运行记录与历史', exact: true }).click()
    await page.locator('.sp-legacy-history > div').nth(index).getByRole('button', { name: '创建画布', exact: true }).click()
    await page.getByText('已从历史创建画布，原记录已保留', { exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('[data-id="node-7"] .sp-node-summary'))
    assert((await page.locator('[data-id="node-7"] .sp-node-summary').innerText()) === original.result.fullPrompt.en, 'The output shows the stored English prompt')
    await page.getByRole('button', { name: '缩放比例', exact: true }).click()
    await page.getByRole('menuitem', { name: '显示全部节点', exact: true }).click()
    await page.locator('[data-id="node-5"] .sp-node-titlebar').click()
    await page.getByRole('button', { name: '检查面板', exact: true }).click()
    await page.locator('.sp-canvas-inspector').getByText(original.result.fullPrompt.en, { exact: true }).waitFor()
    assert(await page.locator('.sp-canvas-inspector details').count() >= original.result.variants.length, 'Inspector retains every stored variant')
    assert(JSON.stringify(await api({ operation: 'get', id: original.id })) === JSON.stringify(original), 'The original task stays unchanged')
    assert(models.length === 0, 'Reading history dispatches no model request')
    return { passed: ['legacy prompt import', 'stored prompt in output', 'complete prompt and variants in inspector', 'original record unchanged'], modelRequests: models.length }
  } finally { page.off('request', onRequest) }
}
