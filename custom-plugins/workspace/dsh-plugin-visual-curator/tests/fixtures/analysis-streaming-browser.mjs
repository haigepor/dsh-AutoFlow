/** Controlled UI transitions over a saved real task; never starts or controls a model job. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const savedRun = '48e87bc98ec3736bbf7316ecb342f2e0d07ff6855612da695beda972005bb3c3'
  const baseResponse = await page.request.post('http://127.0.0.1:3080/api/visual-curator/data', { data: { operation: 'analysis-detail', args: { runId: savedRun } } })
  const saved = (await baseResponse.json()).value
  assert(saved?.summary && saved.requests.length, 'The completed acceptance task must remain available')
  let mode = 'thinking', inputReleased = false, releaseInput
  const inputGate = new Promise(resolve => { releaseInput = resolve })
  const imageId = saved.requests[0].imageIds[0]
  let partial = ''
  const errors = [], onError = error => errors.push(error.message)
  const view = () => mode === 'completed' ? saved : { ...saved, summary: undefined, observations: [], task: { ...saved.task, status: mode === 'failed' ? 'failed' : 'running', observed: 0, phase: mode === 'failed' ? 'failed' : 'receiving' }, requests: [saved.requests[0]], process: { ...saved.process, phase: mode === 'failed' ? 'failed' : 'receiving', updatedAt: new Date().toISOString(), messages: [{ ...saved.process.messages[0], content: partial, reasoning: '这是接口返回的思考夹具，正在比较参考图的色彩与光影。', state: mode === 'failed' ? 'failed' : 'streaming', updatedAt: new Date().toISOString() }] } }
  const dataRoute = async route => {
    const input = route.request().postDataJSON()
    if (input.operation === 'reference-analyze' || input.operation === 'run-control') throw new Error('Presentation QA must never mutate a model task')
    if (input.operation === 'analysis-detail' && input.args.runId === savedRun) return route.fulfill({ json: { ok: true, value: view() } })
    if (input.operation === 'analysis-input' && input.args.runId === savedRun && !inputReleased) await inputGate
    return route.continue()
  }
  const streamRoute = async route => {
    if (route.request().postDataJSON().args.runId !== savedRun) return route.continue()
    await new Promise(resolve => setTimeout(resolve, 180))
    const detail = view()
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ runId: savedRun, status: detail.task.status, process: detail.process, checkpoint: true })}\n\n` })
  }
  const failedPreview = async route => route.request().url().includes(`imageVersionId=${imageId}`) ? route.abort('failed') : route.continue()
  const originalDark = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
  await page.route('**/api/visual-curator/data', dataRoute)
  await page.route('**/api/visual-curator/analysis-stream', streamRoute)
  await page.route('**/api/visual-curator/resource?**', failedPreview)
  page.on('pageerror', onError)
  try {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '训练图片工作台', exact: true }).click()
    await page.locator('.vc-collection-trigger').click()
    await page.getByRole('menuitem', { name: '111', exact: true }).click()
    await page.locator('.vc-profile-dock').getByRole('button', { name: '分析过程', exact: true }).click()
    const modal = page.locator('.vc-analysis-modal'), process = modal.locator('.vc-process-disclosure')
    await modal.locator('.vc-input-skeleton').waitFor()
    const skeletonCount = await modal.locator('.vc-input-skeleton-images > span').count()
    assert(skeletonCount === saved.requests[0].imageIds.length, 'Skeleton cards must match the actual image count')
    assert(await process.getByRole('button', { name: /思考与分析过程/ }).getAttribute('aria-expanded') === 'true', 'A running process must open by default')
    assert(await modal.getByText('这是接口返回的思考夹具，正在比较参考图的色彩与光影。', { exact: true }).isVisible(), 'Actual reasoning must stream visibly')
    await modal.screenshot({ path: '.playwright-mcp/analysis-input-skeleton.png', scale: 'css' })
    inputReleased = true; releaseInput()
    await modal.locator('.vc-request-input [data-state="failed"]').first().waitFor()
    assert(await modal.locator('.vc-request-input img').evaluateAll(ns => ns.every(i => !i.complete || i.naturalWidth > 0)), 'Failed images must not leave broken alternative text')
    const hasInlineRetry = await modal.locator('.vc-request-input').getByRole('button', { name: /重试/ }).count()
    assert(hasInlineRetry === 0, 'Preview failure must not add a retry button')
    mode = 'writing'
    partial = `{"observations":[{"imageVersionId":"${imageId}","dimensions":[{"dimension":"color","observation":"画面呈现柔和的`
    await modal.getByText('画面呈现柔和的', { exact: false }).first().waitFor()
    partial += '低饱和绿色，阴影过渡自然'
    await modal.getByText('低饱和绿色，阴影过渡自然', { exact: false }).first().waitFor()
    assert(!await modal.locator('.vc-final-summary').count(), 'Unfinished text must not appear as a final summary')
    await modal.screenshot({ path: '.playwright-mcp/analysis-readable-stream.png', scale: 'css' })
    mode = 'completed'
    await modal.locator('.vc-final-summary').waitFor()
    await page.waitForFunction(() => document.querySelector('.vc-process-disclosure > [data-disclosure-header] > [data-disclosure-row]')?.getAttribute('aria-expanded') === 'false')
    assert(await modal.locator('.vc-final-summary h2').count() === 1, 'Final summary must appear once as native Markdown')
    await page.waitForFunction(() => !document.querySelector('.vc-process-disclosure .vc-request-exchange'))
    await modal.locator('.vc-chat-feed').evaluate(element => { element.scrollTop = 0 })
    await modal.screenshot({ path: '.playwright-mcp/analysis-final-summary.png', scale: 'css' })
    await process.getByRole('button', { name: /思考与分析过程/ }).click()
    await page.waitForTimeout(500)
    assert(await process.getByRole('button', { name: /思考与分析过程/ }).getAttribute('aria-expanded') === 'true', 'Manual reopening must survive later reads')
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await modal.screenshot({ path: '.playwright-mcp/analysis-stream-dark.png', scale: 'css' })
    await page.setViewportSize({ width: 390, height: 844 })
    assert(await modal.locator('.vc-chat-feed').evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'Narrow process content must stay inside the viewport')
    await modal.screenshot({ path: '.playwright-mcp/analysis-stream-mobile.png', scale: 'css' })
    mode = 'failed'
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.locator('.vc-profile-dock').getByRole('button', { name: '分析过程', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.vc-process-disclosure > [data-disclosure-header] > [data-disclosure-row]')?.getAttribute('aria-expanded') === 'true')
    assert(!await page.locator('.vc-final-summary').count(), 'A failed task must keep its process open without a fabricated summary')
    assert(!errors.length, `Page errors: ${errors.join('; ')}`)
    return { skeletonCount, reasoningVisible: true, readableStream: true, failedImageContained: true, inlineRetryButtons: hasInlineRetry, autoCollapse: true, manualReopen: true, finalSummaryOnce: true, narrow: true, failedProcessRetained: true, pageErrors: errors }
  } finally {
    inputReleased = true; releaseInput()
    page.off('pageerror', onError)
    await page.unroute('**/api/visual-curator/data', dataRoute)
    await page.unroute('**/api/visual-curator/analysis-stream', streamRoute)
    await page.unroute('**/api/visual-curator/resource?**', failedPreview)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), originalDark)
  }
}
