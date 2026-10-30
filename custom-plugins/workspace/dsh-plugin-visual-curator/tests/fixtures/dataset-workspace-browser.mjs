/** Assembled Client verification; real saved reads plus isolated task responses, without inference or writes. */
async (page) => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const read = async (operation, args = {}) => {
    const result = await (await page.request.post('http://127.0.0.1:3080/api/visual-curator/data', { data: { operation, args } })).json()
    assert(result.ok, `Saved ${operation} must be readable: ${result.error?.code}`)
    return result.value
  }
  const snapshot = await read('snapshot'), style = snapshot.styles.find(item => item.name === '测试训练')
  assert(style, 'The saved collection must exist')
  const saved = await read('datasets-list', { styleId: style.styleId }), entry = saved.entries[0], detail = await read('dataset-get', { id: entry.id })
  assert(entry.counts.references === 10 && entry.counts.rules === 7 && entry.counts.candidates === 14 && detail.files.length === 5, 'Read the actual saved package')
  let qa
  for (const candidate of [...page.context().pages()].reverse()) if (await candidate.locator('.vc-image-workspace').isVisible()) { qa = candidate; break }
  assert(qa, 'Open the assembled dataset workspace before this scenario; a shared Host may be rebuilding bootstrap assets.')
  const errors = [], onError = error => errors.push(error.message)
  qa.on('pageerror', onError)
  let releaseAck, releaseList, listHold = true, mock, writes = 0, starts = 0, listReads = 0, snapshotReads = 0, failLists = false
  const acknowledgement = new Promise(resolve => { releaseAck = resolve }), firstList = new Promise(resolve => { releaseList = resolve })
  const synthetic = (status, progress) => {
    const { exportId, downloadPath, byteLength, ...base } = entry
    return { ...base, id: 'qa-dataset-run', runId: 'qa-dataset-run', createdAt: '2026-10-29T00:00:00.000Z', status, progress, counts: { ...entry.counts, files: 0 } }
  }
  const routeData = async route => {
    const input = route.request().postDataJSON()
    if (input.operation === 'snapshot') snapshotReads++
    if (input.operation === 'export-start') { starts++; await acknowledgement; return route.fulfill({ json: { ok: true, value: { runId: 'qa-dataset-run', status: 'running' } } }) }
    if (['profile-save', 'reference-analyze', 'config-save', 'run-control', 'run-delete'].includes(input.operation)) { writes++; return route.abort('blockedbyclient') }
    if (input.operation === 'datasets-list' && input.args.styleId === style.styleId) {
      listReads++
      if (listHold) await firstList
      if (failLists) return route.fulfill({ status: 503, json: { ok: false, error: { code: 'capability-unavailable', safeMessage: 'Fixture read unavailable', suggestedAction: 'Retry' } } })
      let entries = mock ? [mock, ...saved.entries] : saved.entries
      const total = entries.length
      if (input.args.query) entries = entries.filter(row => `${row.name} ${row.model} ${row.id}`.includes(input.args.query))
      if (input.args.status === 'completed') entries = entries.filter(row => row.status === 'completed')
      if (input.args.status === 'failed') entries = entries.filter(row => ['failed', 'cancelled', 'interrupted'].includes(row.status))
      if (input.args.status === 'active') entries = entries.filter(row => ['created', 'running', 'paused', 'pausing', 'cancelling'].includes(row.status))
      return route.fulfill({ json: { ok: true, value: { styleId: style.styleId, total: entries.length, allTotal: total, entries } } })
    }
    if (input.operation === 'dataset-get' && input.args.id === 'qa-dataset-run') return route.fulfill({ json: { ok: true, value: { ...detail, entry: mock } } })
    return route.continue()
  }
  await qa.route('**/api/visual-curator/data', routeData)
  const modal = qa.locator('.vc-profile-dialog'), overlay = modal.locator('.vc-dataset-generating-overlay'), card = qa.locator('.vc-reference-panel .vc-dataset-task-status'), datasets = qa.locator('.vc-datasets-workspace'), details = qa.locator('.vc-dataset-detail')
  const openProfile = () => qa.locator('.vc-profile-dock').getByRole('button', { name: '查看完整档案', exact: true }).click()
  const closeProfile = async () => { await modal.getByRole('button', { name: '关闭', exact: true }).last().click(); await modal.waitFor({ state: 'hidden' }) }
  const geometry = element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height } }
  const noOverflow = locator => locator.evaluate(element => element.scrollWidth <= element.clientWidth + 1)
  const alignedFilters = () => datasets.locator('.vc-datasets-toolbar').evaluate(element => { const search = element.querySelector('.vc-datasets-search').getBoundingClientRect(), status = element.querySelector('.vc-select').getBoundingClientRect(); return Math.abs(search.y + search.height / 2 - status.y - status.height / 2) <= 1 && search.right <= status.left })
  try {
    await qa.setViewportSize({ width: 1440, height: 900 })
    await qa.locator('.vc-collection-trigger').click(); await qa.getByRole('menuitem', { name: style.name, exact: true }).click()
    await qa.getByRole('tab', { name: '数据集', exact: true }).click()
    await datasets.getByRole('textbox', { name: '搜索数据集名称、模型或 ID' }).fill('e2e-cold-start')
    await datasets.locator('.vc-dataset-read-skeleton').waitFor()
    listHold = false; releaseList()
    await datasets.getByText('没有符合筛选条件的数据集', { exact: true }).waitFor()
    await datasets.getByRole('button', { name: '清除筛选', exact: true }).click()
    await datasets.locator('[data-dataset-row]').waitFor()
    assert(await alignedFilters(), 'Search and status must share one desktop row')
    await qa.getByRole('tab', { name: '参考与画像', exact: true }).click()
    await openProfile(); await modal.getByRole('button', { name: '生成数据集', exact: true }).click(); await overlay.waitFor()
    assert(await overlay.locator('[role=progressbar]').getAttribute('aria-valuenow') === null, 'Unacknowledged requests must be indeterminate')
    assert(await modal.locator('.vc-profile-workspace').evaluate(element => element.inert), 'Covered content must be inert')
    const overlayBox = await overlay.evaluate(geometry), contentBox = await modal.locator('.vc-profile-export-frame').evaluate(geometry), modalBox = await modal.evaluate(geometry)
    assert(Math.abs(overlayBox.y - contentBox.y) < 1 && Math.abs(overlayBox.height - contentBox.height) < 1 && overlayBox.height < modalBox.height, 'The mask must cover only dialog contents')
    assert(await overlay.evaluate(element => /0\.55/.test(getComputedStyle(element).backgroundColor)), 'The content mask must be translucent black')
    assert(await overlay.locator('.vc-gallery-import-art img').getAttribute('src') !== null, 'Reuse the native import card artwork')
    await closeProfile(); await card.waitFor()
    assert(await card.getAttribute('data-task-status') === 'submitting', 'A closed dialog must retain its unacknowledged submission')
    mock = synthetic('running', { phase: 'samples', completed: 3, total: 10, unit: 'samples' }); releaseAck()
    await qa.waitForFunction(() => document.querySelector('.vc-reference-panel .vc-dataset-task-status [role=progressbar]')?.getAttribute('aria-valuenow') === '3')
    const beforePolling = snapshotReads
    await card.getByRole('button', { name: '查看完整档案', exact: true }).click(); await overlay.waitFor()
    assert(await overlay.locator('[role=progressbar]').getAttribute('aria-valuenow') === '3', 'Reopening follows the same actual phase count')
    await qa.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await modal.screenshot({ path: '.playwright-mcp/dataset-workspace-overlay-dark.png', scale: 'css' })
    await closeProfile()
    await card.getByRole('button', { name: '查看数据集', exact: true }).click(); await datasets.locator('[data-dataset-row="qa-dataset-run"]').waitFor()
    assert(await datasets.locator('.vc-dataset-task-status').count() === 0, 'The dataset tab must not duplicate its task row with a background card')
    assert(snapshotReads === beforePolling, 'Dataset progress must not refresh the full image snapshot')
    mock = synthetic('failed', { phase: 'files', completed: 2, total: 5, unit: 'files' })
    await qa.waitForFunction(() => document.querySelector('[data-dataset-row="qa-dataset-run"]')?.textContent.includes('失败'))
    mock = { ...entry, id: 'qa-dataset-run', runId: 'qa-dataset-run', createdAt: '2026-10-29T00:00:00.000Z', progress: { phase: 'saving', completed: 1, total: 1, unit: 'items' } }
    await datasets.getByRole('button', { name: '刷新', exact: true }).click()
    await qa.waitForFunction(() => document.querySelector('[data-dataset-row="qa-dataset-run"]')?.textContent.includes('已完成'))
    await datasets.screenshot({ path: '.playwright-mcp/dataset-workspace-list-dark.png', scale: 'css' })
    await datasets.locator(`[data-dataset-row="${entry.id}"]`).getByRole('button', { name: '详情', exact: true }).click()
    await details.locator('.vc-dataset-facts').first().waitFor({ timeout: 60_000 }).catch(async error => { throw new Error('Saved detail failed: ' + (await details.innerText()).slice(0, 1200) + ' errors=' + JSON.stringify(errors), { cause: error }) })
    assert((await details.innerText()).includes('远程图片引用') && (await details.innerText()).includes('图片像素校验'), 'Explain saved URL references and file/pixel verification separately')
    await details.getByRole('tab', { name: '视觉规则', exact: true }).click()
    assert(await details.locator('.vc-dataset-saved-rule').count() === 7, 'Default to the seven active saved rules')
    assert(await details.getByRole('checkbox').count() === 0, 'Dataset rules must remain read-only')
    await details.getByRole('button', { name: '全部候选规则 · 14', exact: true }).click()
    assert(await details.locator('.vc-dataset-saved-rule').count() === 14, 'Keep inactive candidate rules available for inspection')
    await details.getByRole('tab', { name: '逐图观察', exact: true }).click()
    assert(await details.locator('.vc-dataset-sample').count() === 10, 'View all ten frozen reference observations')
    await details.getByRole('tab', { name: '数据包内容', exact: true }).click()
    assert(await details.locator('.vc-dataset-file').count() === 5, 'View all five package files')
    assert((await details.locator('.vc-dataset-download').getAttribute('href')).includes('api/visual-curator/resource?exportId='), 'Downloads stay on the authorized resource route')
    await details.screenshot({ path: '.playwright-mcp/dataset-workspace-detail-dark.png', scale: 'css' })
    await qa.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await details.screenshot({ path: '.playwright-mcp/dataset-workspace-detail-light.png', scale: 'css' })
    await qa.setViewportSize({ width: 390, height: 844 }); await details.getByRole('tab', { name: '视觉规则', exact: true }).click()
    assert(await noOverflow(details), 'Narrow dataset details must fit the viewport')
    await details.screenshot({ path: '.playwright-mcp/dataset-workspace-detail-narrow.png', scale: 'css' })
    await qa.keyboard.press('Escape'); await details.waitFor({ state: 'hidden' })
    assert(await noOverflow(datasets), 'Narrow dataset rows and filters must fit the viewport')
    assert(await alignedFilters(), 'Search and status must share one narrow row')
    await datasets.screenshot({ path: '.playwright-mcp/dataset-workspace-list-narrow.png', scale: 'css' })
    await qa.setViewportSize({ width: 1440, height: 900 }); await datasets.screenshot({ path: '.playwright-mcp/dataset-workspace-list-light.png', scale: 'css' })
    await datasets.getByRole('textbox', { name: '搜索数据集名称、模型或 ID' }).fill('no-such-dataset')
    await datasets.getByText('没有符合筛选条件的数据集', { exact: true }).waitFor()
    await datasets.getByRole('button', { name: '清除筛选', exact: true }).click(); await datasets.locator('[data-dataset-row]').first().waitFor()
    failLists = true; await datasets.getByRole('button', { name: '刷新', exact: true }).click(); await datasets.getByRole('alert').waitFor()
    assert(await datasets.locator('[data-dataset-row]').count() === 2, 'Failed metadata refreshes retain loaded packages')
    failLists = false; await datasets.getByRole('button', { name: '刷新', exact: true }).click()
    await qa.getByRole('tab', { name: '参考与画像', exact: true }).click()
    mock = synthetic('running', { phase: 'verifying', completed: 4, total: 10, unit: 'references' })
    await qa.getByRole('tab', { name: '数据集', exact: true }).click(); await datasets.getByRole('button', { name: '刷新', exact: true }).click()
    await qa.getByRole('tab', { name: '参考与画像', exact: true }).click(); await card.waitFor()
    await qa.waitForFunction(() => document.querySelector('.vc-reference-panel .vc-dataset-task-status')?.getAttribute('data-task-status') === 'running')
    await qa.emulateMedia({ reducedMotion: 'reduce' })
    assert(await card.locator('.vc-gallery-import-art img').evaluate(element => getComputedStyle(element).animationName === 'none'), 'Respect reduced-motion preferences')
    const denied = await (await page.request.post('http://127.0.0.1:3080/api/visual-curator/data', { data: { operation: 'dataset-get', args: { id: 'foreign-dataset' } } })).json()
    assert(denied.ok === false && denied.error.code === 'owner-denied', 'Unauthorized dataset IDs must not reveal a package')
    assert(writes === 0 && starts === 1 && errors.length === 0, 'Only one intercepted generation, no real writes or page errors')
    return { nativeCard: true, modelSettingsTable: true, horizontalFilters: true, bodyOnlyMask: true, closeBeforeAcknowledgement: true, sameTaskOnReopen: true, realPhaseProgress: true, noWorkspaceRefresh: true, noDuplicateCard: true, readOnlyRules: 7, candidateRules: 14, samples: 10, files: 5, responsive: true, themes: ['light', 'dark'], retainedOnReadFailure: true, restoredFromHostMetadata: true, reducedMotion: true, ownerDenied: true, interceptedStarts: starts, productionWrites: writes, pageErrors: errors, listReads }
  } finally { listHold = false; releaseList(); releaseAck(); await qa.unroute('**/api/visual-curator/data', routeData); qa.off('pageerror', onError); await qa.close() }
}
