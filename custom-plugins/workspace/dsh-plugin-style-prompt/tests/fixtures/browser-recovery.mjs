/** Canvas import, concurrent-save recovery and reload preserve both drafts and original history. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const api = action => page.evaluate(async action => {
    const envelope = await (await fetch('/api/style-prompt/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })).json()
    if (!envelope.ok) throw new Error(envelope.error.code)
    return envelope.value
  }, action)
  const models = []
  const onRequest = request => { if (request.url().endsWith('/api/style-prompt/data') && request.method() === 'POST' && request.postDataJSON().operation === 'canvas/run') models.push(request.postDataJSON().id) }
  page.on('request', onRequest)
  try {
    await page.setViewportSize({ width: 1580, height: 980 })
    const before = await api({ operation: 'list' })
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出画布', exact: true }).click()
    const path = 'D:/project/deepseek-harness/.artifacts/style-prompt-canvas/roundtrip.json'
    await (await download).saveAs(path)
    const admitted = page.waitForResponse(response => response.url().endsWith('/api/style-prompt/data') && response.request().method() === 'POST' && response.request().postDataJSON().operation === 'canvas/import')
    await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles(path)
    const imported = (await (await admitted).json()).value
    await page.getByText('画布已导入', { exact: true }).waitFor()
    const updated = await api({ operation: 'canvas/save', document: { ...imported, name: '另一个窗口的更新' }, expectedRevision: imported.revision })
    await page.getByRole('button', { name: '检查面板', exact: true }).click()
    const name = page.getByRole('textbox', { name: '画布名称', exact: true })
    const draftName = imported.name === '保留我的草稿' ? '保留我的草稿（副本）' : '保留我的草稿'
    await name.fill(draftName)
    await page.getByText(/其他页面已保存了更新版本/).waitFor()
    assert(await name.inputValue() === draftName, 'A conflict retains the edited draft')
    assert((await api({ operation: 'canvas/get', id: imported.id })).document.name === updated.name, 'The other window is not overwritten')
    await page.locator('.sp-canvas-error').getByRole('button', { name: '另存为新画布', exact: true }).click()
    await page.getByText('草稿已另存为新画布', { exact: true }).waitFor()
    assert(await name.inputValue() === draftName, 'Save as retains the draft name')
    await page.reload()
    const navigation = page.getByRole('navigation', { name: '全局面板' })
    await navigation.waitFor()
    const entry = navigation.getByRole('button', { name: '风格提示词', exact: true })
    if (!await entry.isVisible()) await navigation.getByRole('button', { name: '更多', exact: true }).click()
    await entry.click()
    await page.locator('.sp-document-picker').getByRole('button', { name: '画布', exact: true }).waitFor()
    await page.waitForFunction(name => document.querySelector('.sp-document-picker')?.textContent.includes(name), draftName)
    await page.waitForFunction(() => [...document.querySelectorAll('.sp-node[data-kind="reference"] img')].some(image => image.complete && image.naturalWidth > 0))
    assert((await api({ operation: 'list' })).tasks.length === before.tasks.length, 'Import and conflict recovery leave original history untouched')
    assert(models.length === 0, 'Export, import and recovery do not dispatch model work')
    return { passed: ['portable import', 'concurrent save conflict', 'retained draft', 'save as', 'reload with attachments', 'unchanged original history'], modelRequests: models.length }
  } finally { page.off('request', onRequest) }
}
