/** Field focus, native menus and profile asset cleanup stay usable across window sizes. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const api = action => page.evaluate(async action => { const value = await (await fetch('/api/style-prompt/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })).json(); if (!value.ok) throw new Error(value.error.code); return value.value }, action)
  const openEntry = async () => { if (await page.getByRole('button', { name: '返回', exact: true }).isVisible()) await page.getByRole('button', { name: '返回', exact: true }).click(); const nav = page.getByRole('navigation', { name: '全局面板' }); await nav.waitFor(); const entry = nav.getByRole('button', { name: '风格提示词', exact: true }); if (!await entry.isVisible()) await nav.getByRole('button', { name: '更多', exact: true }).click(); await entry.click(); await page.waitForFunction(() => document.querySelector('.sp-canvas-page')?.getAttribute('data-canvas-id')) }
  const listing = await api({ operation: 'canvas/list' }), history = await api({ operation: 'list' }), inventory = await api({ operation: 'canvas/assets' })
  const template = (await api({ operation: 'canvas/get', id: listing.documents.find(document => document.name === '风格创作画布').id })).document
  const analysis = history.tasks.find(task => task.kind === 'analysis' && task.status === 'succeeded')
  const document = { ...template, id: await page.evaluate(() => crypto.randomUUID()), revision: 0, name: '交互细节验证', nodes: template.nodes.map(node => node.kind === 'reference' ? { ...node, assetIds: [inventory.assets[0].asset.id] } : node.kind === 'analysis' ? { ...node, route: null, historyTaskId: analysis.id } : node.kind === 'prompt' ? { ...node, mode: 'quick', route: null } : node.kind === 'brief' ? { ...node, brief: { zh: '海边的小屋', en: '' }, changes: { zh: '变成清晨', en: '' } } : node.kind === 'image' ? { ...node, route: { provider: 'removed-provider', model: 'missing-image-model' } } : node) }
  await api({ operation: 'canvas/save', document, expectedRevision: 0 })
  await page.reload(); await openEntry()
  const prompt = page.locator('.react-flow__node[data-id="node-5"]'), brief = page.locator('.react-flow__node[data-id="node-4"]'), image = page.locator('.react-flow__node[data-id="node-6"]')
  await prompt.getByRole('button', { name: '运行节点', exact: true }).click()
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-canvas-field') === 'brief.en')
  assert(await brief.locator('details').getAttribute('open') !== null, 'Validation expands the English inputs')
  assert(await brief.locator('[data-canvas-field="brief.en"]').getAttribute('aria-invalid') === 'true', 'The missing English scene owns its validation state')
  await brief.locator('[data-canvas-field="brief.en"]').fill('A cottage by the sea')
  await brief.locator('[data-canvas-field="changes.en"]').fill('Change to early morning')
  await page.waitForFunction(() => document.querySelectorAll('.sp-node-error').length === 0)
  await page.getByRole('button', { name: '缩放比例', exact: true }).click(); await page.getByRole('menuitem', { name: '显示全部节点', exact: true }).click()
  assert((await image.getByRole('button', { name: '项目生图模型', exact: true }).innerText()).includes('missing-image-model'), 'A removed selection retains its identity')
  await image.getByRole('button', { name: '打开设置', exact: true }).click()
  await page.getByRole('button', { name: '模型', exact: true }).waitFor()
  const settingsReached = await page.getByRole('button', { name: '模型', exact: true }).isVisible()
  await openEntry()
  await page.getByRole('button', { name: '缩放比例', exact: true }).click(); await page.getByRole('menuitem', { name: '显示全部节点', exact: true }).click()
  await image.getByRole('button', { name: '项目生图模型', exact: true }).click()
  assert(await page.locator('.sp-model-group').innerText() === 'style-prompt-fixture', 'Model choices have a provider heading')
  await page.getByRole('menuitem', { name: 'Style Prompt · Synthetic image', exact: true }).click()
  await page.getByRole('button', { name: '更多操作', exact: true }).click(); await page.getByRole('menuitem', { name: '参考素材', exact: true }).click()
  await page.getByRole('dialog', { name: '参考素材', exact: true }).waitFor()
  await page.getByText(/素材名额已用/).waitFor()
  assert((await page.locator('.sp-asset-manager').innerText()).includes('素材名额已用'), 'Asset manager reports profile usage')
  assert(await page.locator('.sp-asset-row').count() >= 2, 'Asset manager retains referenced images')
  await page.getByRole('dialog', { name: '参考素材', exact: true }).getByRole('button', { name: '关闭', exact: true }).last().click()
  const orphan = await page.evaluate(async () => {
    const api = async action => { const envelope = await (await fetch('/api/style-prompt/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })).json(); if (!envelope.ok) throw new Error(envelope.error.code); return envelope.value }
    const inventory = await api({ operation: 'canvas/assets' }), id = crypto.randomUUID()
    const blob = await (await fetch(`/api/style-prompt/canvas-image?asset=${inventory.assets[0].asset.id}`)).blob()
    const base64 = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob) })
    return (await api({ operation: 'canvas/upload', assets: [{ id, name: '可清理的验证素材.png', mediaType: 'image/png', base64 }] })).assets[0].id
  })
  await page.waitForTimeout(1100)
  await page.getByRole('button', { name: '更多操作', exact: true }).click(); await page.getByRole('menuitem', { name: '参考素材', exact: true }).click()
  const assetsDialog = page.getByRole('dialog', { name: '参考素材', exact: true })
  await assetsDialog.getByRole('button', { name: '清理未引用素材', exact: true }).click()
  await page.getByRole('dialog', { name: '清理未引用素材', exact: true }).getByRole('button', { name: '清理未引用素材', exact: true }).click()
  await page.getByRole('dialog', { name: '清理未引用素材', exact: true }).waitFor({ state: 'hidden' })
  const after = await api({ operation: 'canvas/assets' })
  assert(!after.assets.some(value => value.asset.id === orphan), 'Confirmed cleanup removes the unused asset slot')
  assert(after.assets.some(value => value.asset.id === inventory.assets[0].asset.id), 'Cleanup keeps saved references')
  await assetsDialog.getByRole('button', { name: '关闭', exact: true }).last().click()
  return { fieldFocusAndExpansion: true, removedModelIdentity: true, nativeSettings: settingsReached, groupedModelMenu: true, assetUsageAndSafeCleanup: true, canvasId: document.id }
}
