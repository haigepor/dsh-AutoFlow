/** Playwright MCP fixture: real page, controlled model reads/saves, no profile mutation or paid model call. */
async page => {
  const assert = (value, message) => { if (!value) throw Error(message) }
  const catalog = { models: [
    { provider: 'managed', providerName: '已配置供应商', id: 'vision-a', name: '图像模型 A' },
    { provider: 'managed', providerName: '已配置供应商', id: 'vision-b', name: '图像模型 B', contextWindow: 1000000, maxOutputTokens: 65536 },
  ], unavailable: [] }
  let currentCatalog = catalog, release, reads = 0, saved, baseline, wasDark
  const firstRead = new Promise(resolve => { release = resolve })
  const errors = [], onError = error => errors.push(error.message)
  const handler = async route => {
    const input = route.request().postDataJSON()
    if (input.operation === 'vision-models') {
      reads++
      if (reads === 1) await firstRead
      return route.fulfill({ json: { ok: true, value: currentCatalog } })
    }
    if (input.operation === 'config-read') return route.fulfill({ json: { ok: true, value: { ...baseline, vision: { ...baseline.vision, backend: 'compatible', provider: '', model: 'legacy-model', endpoint: 'https://legacy.invalid/v1', credentialRef: 'OLD_REF' } } } })
    if (input.operation === 'snapshot') {
      const response = await route.fetch(), body = await response.json()
      assert(body.ok && body.value?.configuration, 'The real workspace snapshot must be readable')
      body.value.configuration.vision = { ...baseline.vision, backend: 'compatible', provider: '', model: 'legacy-model', endpoint: 'https://legacy.invalid/v1', credentialRef: 'OLD_REF' }
      return route.fulfill({ response, json: body })
    }
    if (input.operation === 'config-save') {
      saved = input.args
      return route.fulfill({ json: { ok: true, value: { saved: true, changed: true, configuration: { ...baseline, revision: baseline.revision + '-managed-fixture', vision: input.args.vision, limits: { ...baseline.limits, ...input.args.limits } } } } })
    }
    return route.continue()
  }
  page.on('pageerror', onError)
  try {
    await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '训练图片工作台', exact: true }).waitFor({ timeout: 60_000 })
    wasDark = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
    const response = await page.request.post('http://127.0.0.1:3080/api/visual-curator/data', { data: { operation: 'config-read', args: {} } })
    const configuration = await response.json()
    assert(configuration.ok && configuration.value?.revision, 'The real configuration must be readable')
    baseline = configuration.value
    await page.route('**/api/visual-curator/data', handler)
    await page.getByRole('button', { name: '训练图片工作台', exact: true }).click({ timeout: 60_000 })
    await page.getByRole('tab', { name: '模型&图库设置', exact: true }).click()
    const settings = page.locator('.vc-settings'), vision = settings.locator('[data-panel=vision]')
    const save = settings.getByRole('button', { name: '保存配置', exact: true })
    await vision.locator('[role=status] [data-state=ongoing]').waitFor()
    assert(await save.isDisabled(), 'Saving must wait for the authoritative catalog')
    release()
    await page.waitForFunction(() => !document.querySelector('.vc-settings [role=status] [data-state=ongoing]'))
    assert(await vision.locator('input').count() === 0, 'Provider, endpoint and model IDs must not be free-text inputs')
    assert(await save.isDisabled(), 'A legacy or removed selection cannot be saved as a managed model')
    const select = vision.getByRole('button', { name: '已配置的视觉模型', exact: true })
    await select.click()
    assert(await page.getByRole('menuitem').count() === 2, 'Only configured catalog models must be selectable')
    await page.getByRole('menuitem', { name: '图像模型 B · 已配置供应商', exact: true }).click()
    assert(!(await save.isDisabled()), 'An available model can be saved')
    await vision.getByText('分析参数', { exact: true }).click()
    assert((await vision.getByLabel('模型上下文容量', { exact: true }).inputValue()).replaceAll(',', '') === '1000000', 'Context capacity follows native model settings')
    assert((await vision.getByLabel('模型输出默认值', { exact: true }).inputValue()).replaceAll(',', '') === '65536', 'Output default follows native model settings')
    assert(await vision.getByLabel('模型输出默认值', { exact: true }).getAttribute('readonly') !== null, 'Native output default cannot be independently edited')
    await vision.getByText('分析参数', { exact: true }).click()
    await settings.getByRole('tab', { name: '图库来源', exact: true }).click()
    await settings.getByRole('tab', { name: '视觉模型', exact: true }).click()
    assert(reads === 1, 'Switching settings tabs must reuse the model catalog')
    currentCatalog = { models: [], unavailable: [] }
    await vision.getByRole('button', { name: '刷新', exact: true }).click()
    await vision.getByText('暂无可用视觉模型，请在设置 → 模型中配置并启用图片输入', { exact: true }).waitFor()
    assert(await save.isDisabled(), 'Removing the selected model withdraws save readiness')
    currentCatalog = catalog
    await vision.getByRole('button', { name: '刷新', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.vc-settings-footer button[type=submit]')?.disabled)
    await save.click()
    assert(saved.vision.backend === 'native' && saved.vision.provider === 'managed' && saved.vision.model === 'vision-b', 'Save the exact selected registered identity')
    assert(saved.vision.endpoint === '' && saved.vision.credentialRef === '' && saved.vision.localOrigin === '' && saved.vision.reasoningEffort === null, 'Credentials and reasoning must use central settings')
    assert(saved.vision.useModelDefaults === true && !Object.hasOwn(saved.limits, 'maxVisionOutputTokens'), 'Native output defaults are inherited without a plugin override')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await settings.screenshot({ path: '.playwright-mcp/managed-models-desktop.png', scale: 'css' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(() => { const el = document.querySelector('.vc-workbench'); return el && el.clientWidth >= 280 && el.scrollWidth <= el.clientWidth + 1 })
    await settings.screenshot({ path: '.playwright-mcp/managed-models-narrow.png', scale: 'css' })
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await settings.screenshot({ path: '.playwright-mcp/managed-models-dark.png', scale: 'css' })
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), wasDark)
    await vision.getByRole('button', { name: '打开设置', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.vc-workbench'))
    assert(errors.length === 0, 'No browser render errors')
    return { loadingDisablesSave: true, manualConnectionInputs: 0, options: 2, selectedModel: saved.vision.model, tabSwitchReusesCatalog: true, removedModelDisablesSave: true, nativeBackend: saved.vision.backend, duplicateCredentials: false, centralReasoningDefaults: true, narrowOverflow: false, settingsNavigation: true, dataWritten: false, paidCalls: 0, pageErrors: errors }
  } finally {
    release()
    await page.unroute('**/api/visual-curator/data', handler)
    page.off('pageerror', onError)
    if (wasDark !== undefined) await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), wasDark)
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
}
