/** Native installed-card and workbench acceptance on the real application; no model request is started. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const errors = [], modelRequests = []
  const captureError = error => errors.push(String(error))
  const captureRequest = request => {
    if (request.url().endsWith('/api/style-prompt/data') && request.method() === 'POST') {
      const action = request.postDataJSON()
      if (action.operation === 'analyze' || action.operation === 'generate') modelRequests.push(action.operation)
    }
  }
  page.on('pageerror', captureError); page.on('request', captureRequest)
  try {
    const welcome = page.getByRole('button', { name: '继续', exact: true })
    if (await welcome.isVisible()) await welcome.click()
    await page.getByRole('button', { name: '插件', exact: true }).click()
    const card = page.locator('[data-plugin-package="dsh-plugin-style-prompt"]')
    await card.waitFor()
    assert((await card.innerText()).includes('风格提示词'), 'The installed card uses the Chinese package title')
    await page.waitForFunction(() => [...document.querySelectorAll('[data-plugin-package="dsh-plugin-style-prompt"] img')].some(image => image.complete && image.naturalWidth > 0))
    const toggle = card.getByRole('switch')
    const initial = await toggle.getAttribute('aria-checked')
    if (initial !== 'true') await toggle.click()
    await page.waitForFunction(() => document.querySelector('[data-plugin-package="dsh-plugin-style-prompt"] [role="switch"]')?.getAttribute('aria-checked') === 'true')
    await page.screenshot({ path: '.artifacts/style-prompt/builtin-installed-3080.png' })
    const open = async () => {
      const navigation = page.getByRole('navigation', { name: '全局面板', exact: true })
      if (!(await navigation.getByRole('button', { name: '风格提示词', exact: true }).isVisible())) await navigation.getByRole('button', { name: '更多', exact: true }).click()
      await navigation.getByRole('button', { name: '风格提示词', exact: true }).click()
      await page.getByRole('main', { name: '风格提示词', exact: true }).waitFor()
    }
    await open()
    await page.waitForFunction(() => { const button = document.querySelector('.sp-upload button'); return button && !button.disabled })
    await page.getByLabel('选择图片', { exact: true }).setInputFiles('custom-plugins/workspace/dsh-plugin-style-prompt/tests/fixtures/reference.png')
    await page.waitForFunction(() => [...document.querySelectorAll('.sp-references img')].some(image => image.complete && image.naturalWidth > 0))
    assert(modelRequests.length === 0, 'Opening the shipped plugin and importing an image starts no paid request')
    await page.getByRole('button', { name: '插件', exact: true }).click()
    await toggle.click()
    await page.waitForFunction(() => document.querySelector('[data-plugin-package="dsh-plugin-style-prompt"] [role="switch"]')?.getAttribute('aria-checked') === 'false')
    await page.reload()
    await page.getByRole('button', { name: '插件', exact: true }).click()
    await card.waitFor()
    assert(await toggle.getAttribute('aria-checked') === 'false', 'A reload preserves the disabled choice')
    await toggle.click()
    await page.waitForFunction(() => document.querySelector('[data-plugin-package="dsh-plugin-style-prompt"] [role="switch"]')?.getAttribute('aria-checked') === 'true')
    await open()
    await page.locator('.sp-upload-art').evaluate(image => image.decode())
    await page.screenshot({ path: '.artifacts/style-prompt/builtin-workbench-3080.png' })
    assert(errors.length === 0, `No uncaught page errors: ${errors.join('; ')}`)
    return { initialEnabled: initial === 'true', finalEnabled: true, passed: ['installation-owned card', 'localized title and image', 'enable and open', 'local image preview without model calls', 'disable persists after reload', 're-enable workbench'], modelRequests: modelRequests.length, pageErrors: errors }
  } finally {
    page.off('pageerror', captureError); page.off('request', captureRequest)
  }
}
