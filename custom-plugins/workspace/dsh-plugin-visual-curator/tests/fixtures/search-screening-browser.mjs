/** Real settings controls persist screening choices while retaining the native form and tokens. */
async page => {
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const pageErrors = [], onError = error => pageErrors.push(error.message)
  page.on('pageerror', onError)
  await page.route('**/api/visual-curator/resource**', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#496252"/></svg>' }))
  try {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.incrementalFixture)
    await page.evaluate(() => window.incrementalFixture.showScreeningSettings())
    await page.getByRole('tab', { name: '模型&图库设置', exact: true }).click()
    await page.getByRole('button', { name: '分析参数', exact: true }).click()
    const pool = page.getByRole('button', { name: '每轮唯一候选数量', exact: true })
    const batch = page.getByRole('spinbutton', { name: '每批初筛图片数量', exact: true })
    const edge = page.getByRole('spinbutton', { name: '初筛图片最长边（px）', exact: true })
    const defaults = { defaultPool: (await pool.textContent()).trim(), defaultBatch: await batch.inputValue(), defaultEdge: await edge.inputValue() }
    await pool.click()
    await page.getByRole('menuitem', { name: '100', exact: true }).click()
    await batch.fill('4'); await edge.fill('512')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await page.waitForFunction(() => window.incrementalFixture.state.configurationSaves.length === 1)
    const savedPolicy = await page.evaluate(() => window.incrementalFixture.state.configurationSaves[0].searchScreening)
    await page.getByRole('tab', { name: '图片工作区', exact: true }).click()
    await page.getByRole('tab', { name: '模型&图库设置', exact: true }).click()
    await page.getByRole('button', { name: '分析参数', exact: true }).click()
    const persistsAcrossTabs = (await pool.textContent()).trim() === '100' && await batch.inputValue() === '4' && await edge.inputValue() === '512'
    await page.getByRole('checkbox', { name: '为新找图任务启用批量初筛', exact: true }).uncheck()
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await page.waitForFunction(() => window.incrementalFixture.state.configurationSaves.length === 2)
    const disabledForNewTasks = await batch.isDisabled() && await edge.isDisabled() && await page.evaluate(() => window.incrementalFixture.state.configurationSaves[1].searchScreening.enabled === false)
    await page.evaluate(() => window.incrementalFixture.theme(false))
    await page.setViewportSize({ width: 390, height: 844 })
    const narrowOverflow = await page.locator('.vc-settings').evaluate(element => element.scrollWidth > element.clientWidth + 1)
    const actual = { ...defaults, savedPolicy, persistsAcrossTabs, disabledForNewTasks, narrowOverflow, pageErrors }
    const expected = await (await page.request.get(new URL('search-screening-ui.expected.json', page.url()).href)).json()
    assert(JSON.stringify(actual) === JSON.stringify(expected), `Screening settings mismatch: ${JSON.stringify(actual)}`)
    return actual
  } finally { page.off('pageerror', onError) }
}
