/** Real canvas controls exercise response reordering, history mode and autosave recovery. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const api = action => page.evaluate(async action => { const envelope = await (await fetch('/api/style-prompt/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })).json(); if (!envelope.ok) throw new Error(envelope.error.code); return envelope.value }, action)
  const mode = value => page.evaluate(async mode => { await fetch('/api/style-prompt/test-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) }) }, value)
  const root = page.locator('.sp-canvas-page'), image = page.locator('.react-flow__node[data-id="node-6"]')
  const canvas = await root.getAttribute('data-canvas-id')
  const initial = (await api({ operation: 'canvas/get', id: canvas })).document
  const recoveryName = `离线保存恢复 · 验收 ${Date.now()}`
  if (!await page.getByRole('menuitem', { name: '显示全部节点', exact: true }).isVisible()) await page.getByRole('button', { name: '缩放比例', exact: true }).click()
  await page.getByRole('menuitem', { name: '显示全部节点', exact: true }).click()
  const brief = page.locator('.react-flow__node[data-id="node-4"]')
  await brief.focus(); await page.keyboard.press('Enter')
  const saved = page.waitForResponse(response => response.url().endsWith('/api/style-prompt/data') && response.request().postDataJSON().operation === 'canvas/save')
  await page.keyboard.press('ArrowRight'); await saved
  await page.waitForFunction(() => document.querySelector('.sp-save-state')?.textContent === '已保存')
  const moved = (await api({ operation: 'canvas/get', id: canvas })).document
  assert(moved.nodes.find(node => node.id === 'node-4').position.x === initial.nodes.find(node => node.id === 'node-4').position.x + 5, 'Keyboard movement persists')
  const undone = page.waitForResponse(response => response.url().endsWith('/api/style-prompt/data') && response.request().postDataJSON().operation === 'canvas/save')
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await undone
  assert((await api({ operation: 'canvas/get', id: canvas })).document.nodes.find(node => node.id === 'node-4').position.x === initial.nodes.find(node => node.id === 'node-4').position.x, 'Keyboard movement is undoable')

  const failedSave = async route => { if (route.request().postDataJSON().operation === 'canvas/save') await route.abort('failed'); else await route.continue() }
  await page.route('**/api/style-prompt/data', failedSave)
  await page.getByRole('button', { name: '检查面板', exact: true }).click()
  await page.getByRole('textbox', { name: '画布名称', exact: true }).fill(recoveryName)
  await page.getByText('保存失败，当前草稿仍保留；请重试保存，或先导出草稿', { exact: true }).waitFor()
  assert(!await page.locator('.sp-canvas-error').innerText().then(text => text.includes('计费')), 'Save failure has no model billing copy')
  await page.unroute('**/api/style-prompt/data', failedSave)
  const retried = page.waitForResponse(response => response.url().endsWith('/api/style-prompt/data') && response.request().postDataJSON().operation === 'canvas/save')
  await page.getByRole('button', { name: '重试保存', exact: true }).click(); await retried
  await page.waitForFunction(() => !document.querySelector('.sp-canvas-error'))
  assert((await api({ operation: 'canvas/get', id: canvas })).document.name === recoveryName, 'Retry saves the retained draft')
  await page.getByRole('button', { name: '检查面板', exact: true }).click()

  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '运行记录与历史', exact: true }).click()
  await page.locator('.sp-run-history-row > button:first-child').first().click()
  await page.locator('.sp-history-banner').waitFor()
  assert(await image.getByRole('textbox', { name: '生图提示词', exact: true }).isDisabled(), 'History freezes node inputs')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await mode('image-waiting')
  let releasePoll, captured
  const gate = new Promise(resolve => { releasePoll = resolve }), polling = new Promise(resolve => { captured = resolve })
  let held = false
  const delayedPoll = async route => {
    if (route.request().postDataJSON().operation === 'canvas/run-get' && !held) { held = true; const response = await route.fetch(); const json = await response.json(); captured(json.value); await gate; await route.fulfill({ response, json }) }
    else await route.continue()
  }
  await page.route('**/api/style-prompt/data', delayedPoll)
  let running
  try {
    await image.getByRole('button', { name: '运行当前草稿节点', exact: true }).click()
    running = await polling
    assert(await root.getAttribute('data-view') === 'live', 'Run from history returns to live view')
    await page.evaluate(() => { window.__uxStatuses = []; new MutationObserver(records => { for (const record of records) if (record.attributeName === 'data-status') window.__uxStatuses.push(record.target.getAttribute('data-status')) }).observe(document.querySelector('.react-flow__node[data-id="node-6"] .sp-node'), { attributes: true }) })
    await page.locator('.sp-current-run').getByRole('button', { name: '停止任务', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.react-flow__node[data-id="node-6"] .sp-node')?.getAttribute('data-status') === 'cancelled')
    releasePoll(); await page.waitForTimeout(400)
    const statuses = await page.evaluate(() => window.__uxStatuses)
    assert(statuses.indexOf('cancelled') >= 0 && !statuses.slice(statuses.indexOf('cancelled') + 1).includes('running'), 'Late running poll never revives the cancelled UI')
  } finally { releasePoll(); await page.unroute('**/api/style-prompt/data', delayedPoll); if (running) await api({ operation: 'canvas/cancel', id: running.id }) }

  let releaseRun, admitted
  const runGate = new Promise(resolve => { releaseRun = resolve }), admission = new Promise(resolve => { admitted = resolve })
  const delayedRun = async route => { if (route.request().postDataJSON().operation === 'canvas/run') { const response = await route.fetch(); const json = await response.json(); admitted(json.value); await runGate; await route.fulfill({ response, json }) } else await route.continue() }
  await page.route('**/api/style-prompt/data', delayedRun)
  let accepted
  try {
    await image.getByRole('button', { name: '运行节点', exact: true }).click(); accepted = await admission
    await page.getByRole('button', { name: '新建画布', exact: true }).click()
    await page.waitForFunction(previous => document.querySelector('.sp-canvas-page')?.getAttribute('data-canvas-id') !== previous, canvas)
    const destination = await root.getAttribute('data-canvas-id')
    releaseRun()
    await page.getByRole('button', { name: '其他画布运行中：1', exact: true }).waitFor()
    assert(await page.locator('.sp-current-run').count() === 0, 'The destination has no foreign run progress')
    assert((await api({ operation: 'canvas/get', id: destination })).runs.length === 0, 'The destination has no foreign stored run')
    await page.getByRole('button', { name: '其他画布运行中：1', exact: true }).click()
    await page.getByRole('menuitem', { name: recoveryName, exact: true }).click()
    await page.waitForFunction(source => document.querySelector('.sp-canvas-page')?.getAttribute('data-canvas-id') === source, canvas)
    assert(await page.locator('.sp-current-run').count() === 1, 'The background menu returns to the actual running canvas')
    await page.locator('.sp-current-run').getByRole('button', { name: '停止任务', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.sp-current-run').length === 0)
  } finally { releaseRun(); await page.unroute('**/api/style-prompt/data', delayedRun); if (accepted) await api({ operation: 'canvas/cancel', id: accepted.id }); await mode('success') }
  return { keyboardSaveUndo: true, offlineSaveRecovery: true, historicalReadOnlyAndLiveRun: true, cancellationMonotonic: true, crossCanvasAdmission: true }
}
