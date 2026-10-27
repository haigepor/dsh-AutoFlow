/** Keyless Playwright MCP scenario for an existing image set; compare result fields with gallery-loading-ui.expected.json. All import requests are intercepted. */
async page => {
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const pageCalls = [], submissions = [], pageErrors = []
  let releasePage, releaseStart, enterPage
  let pendingPage = new Promise(resolve => { releasePage = resolve })
  let pageEntered = new Promise(resolve => { enterPage = resolve })
  let startGate = new Promise(resolve => { releaseStart = resolve })
  const image = 'https://images.unsplash.com/vc-loading-fixture.svg'
  const imageHandler = route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#869bb4"/></svg>' })
  const photos = Array.from({ length: 40 }, (_, i) => ({ id: `loading-photo-${i}`, title: `加载验收 ${i + 1}`, photographer: 'UI fixture', width: 400, height: 240, thumbnailUrl: image, referenceUrl: image, pageUrl: 'https://unsplash.com/', photographerUrl: '', premium: i === 3 }))
  const folder = { id: 'loading-collection', title: '加载验收收藏夹', description: '', totalPhotos: 40, private: true }
  const account = { id: 'loading-account', label: '验收图库', userId: 'loading-user', username: 'acceptance', name: 'Acceptance', credentialRef: 'UI_FIXTURE' }
  const onError = error => pageErrors.push(error.message)
  const dataHandler = async route => {
    const input = route.request().postDataJSON()
    if (!['snapshot', 'config-read'].includes(input.operation)) return route.continue()
    const response = await route.fetch(), body = await response.json()
    const config = input.operation === 'snapshot' ? body.value.configuration : body.value
    config.source.unsplash.accounts = [account]
    config.source.unsplash.defaultAccountId = account.id
    config.revision += '-loading-ui-fixture'
    await route.fulfill({ response, json: body })
  }
  const galleryHandler = async route => {
    const input = route.request().postDataJSON()
    if (input.operation === 'gallery-collections') return route.fulfill({ json: { ok: true, value: { items: [folder], nextCursor: null } } })
    if (input.operation === 'gallery-photos') {
      const cursor = input.args.cursor ?? null
      pageCalls.push(cursor)
      if (cursor) { enterPage(); await pendingPage }
      try { await route.fulfill({ json: { ok: true, value: { items: photos.slice(cursor ? 20 : 0, cursor ? 40 : 20), nextCursor: cursor ? null : 'loading-page-2' } } }) } catch (error) { if (!cursor) throw error }
      return
    }
    if (input.operation === 'gallery-reference-start') {
      submissions.push(input.args)
      await startGate
      return route.fulfill({ json: { ok: true, value: { id: 'a'.repeat(64), styleId: input.args.styleId, accountId: account.id, status: 'completed', phase: 'saving', total: input.args.photoIds.length, completed: input.args.photoIds.length, registered: input.args.photoIds.length, failed: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } })
    }
    return route.continue()
  }
  page.on('pageerror', onError)
  await page.route('**/api/visual-curator/data', dataHandler)
  await page.route('**/api/visual-curator/gallery', galleryHandler)
  await page.route('**/vc-loading-fixture.svg', imageHandler)
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('button', { name: '训练图片工作台', exact: true }).click()
    await page.locator('.vc-command-actions').getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByRole('tab', { name: '参考与画像', exact: true }).click()
    for (const mode of ['manual', 'select-all']) {
      const open = page.getByRole('button', { name: '引用图库收藏夹', exact: true })
      if (await open.isVisible()) await open.click()
      else { await page.locator('.vc-add-reference').click(); await page.getByRole('menuitem', { name: '引用图库收藏夹', exact: true }).click() }
      const dialog = page.getByRole('dialog', { name: '引用图库收藏夹', exact: true })
      await dialog.getByRole('button', { name: /加载验收收藏夹/ }).click()
      await page.waitForFunction(() => document.querySelectorAll('.vc-gallery-reference-modal .vc-gallery-photos figure').length === 20)
      await pageEntered
      const submit = dialog.getByRole('button', { name: /^加入素材集/ })
      if (mode === 'manual') {
        await dialog.getByRole('checkbox', { name: '加载验收 1', exact: true }).check()
        await dialog.getByRole('checkbox', { name: '加载验收 4', exact: true }).check()
        await dialog.locator('.vc-gallery-reference-content').evaluate(el => { el.scrollTop = el.scrollHeight })
      } else await dialog.getByRole('checkbox', { name: '全选', exact: true }).check()
      await dialog.getByRole('button', { name: '取消读取', exact: true }).waitFor()
      assert(!(await submit.isDisabled()), `${mode}: selected photos must be addable while later pages are loading`)
      await dialog.screenshot({ path: `.playwright-mcp/gallery-add-loading-${mode}.png`, scale: 'css' })
      const expected = mode === 'manual' ? ['loading-photo-0', 'loading-photo-3'] : photos.slice(0, 20).map(photo => photo.id)
      const before = submissions.length
      await submit.click()
      await page.waitForFunction(() => !document.querySelector('.vc-gallery-reference-footer button:last-child')?.textContent?.includes('加入素材集'))
      assert(submissions.length === before + 1, `${mode}: one click must submit one task`)
      assert(JSON.stringify(submissions.at(-1).photoIds) === JSON.stringify(expected), `${mode}: task must contain only the click-time selection`)
      releasePage()
      releaseStart()
      await page.waitForFunction(() => document.querySelector('.vc-gallery-reference-footer button:last-child')?.textContent?.includes('加入素材集'))
      assert(await dialog.locator('.vc-gallery-photos input:checked').count() === 0, `${mode}: late pages must not reselect photos after submission`)
      await page.keyboard.press('Escape')
      pendingPage = new Promise(resolve => { releasePage = resolve })
      pageEntered = new Promise(resolve => { enterPage = resolve })
      startGate = new Promise(resolve => { releaseStart = resolve })
    }
    assert(pageErrors.length === 0, 'No uncaught browser errors')
    return { pageCalls, submittedCounts: submissions.map(input => input.photoIds.length), actualDataWritten: false, modes: ['manual', 'select-all'], pageErrors }
  } finally {
    releasePage(); releaseStart()
    await page.keyboard.press('Escape').catch(() => {})
    await page.unroute('**/api/visual-curator/data', dataHandler)
    await page.unroute('**/api/visual-curator/gallery', galleryHandler)
    await page.unroute('**/vc-loading-fixture.svg', imageHandler)
    page.off('pageerror', onError)
    const refresh = page.locator('.vc-command-actions').getByRole('button', { name: '刷新', exact: true })
    if (await refresh.isVisible()) await refresh.click()
  }
}
