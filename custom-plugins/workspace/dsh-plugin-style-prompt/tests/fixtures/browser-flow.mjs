/** Run through Playwright MCP on an authenticated scratch profile with browser-model.ts mounted. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const errors = []
  const capture = error => errors.push(String(error))
  page.on('pageerror', capture)
  const base = new URL(page.url()).origin
  const originalViewport = page.viewportSize()
  const originalDark = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
  try {
    const notice = page.getByRole('button', { name: '继续', exact: true })
    if (await notice.isVisible()) await notice.click()
    if (!(await page.getByRole('button', { name: '风格提示词', exact: true }).isVisible())) await page.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('button', { name: '风格提示词', exact: true }).click()
    await page.getByRole('button', { name: '项目视觉模型', exact: true }).click()
    await page.getByRole('menuitem', { name: /Style Prompt · Keyless fixture/ }).click()
    await page.getByLabel('选择图片', { exact: true }).setInputFiles('custom-plugins/workspace/dsh-plugin-style-prompt/tests/fixtures/reference.png')
    await page.getByRole('button', { name: '分析风格', exact: true }).click()
    await page.getByRole('heading', { name: '柔和纸面', exact: true }).waitFor()
    assert(await page.locator('.sp-rules input:checked').count() === 2, 'Transferable rules selected')
    assert(await page.locator('.sp-references img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), 'Native reference preview decodes')
    await page.getByLabel('新主体或场景 · 中文', { exact: true }).fill('街角咖啡店')
    await page.getByLabel('希望改变的内容 · 中文', { exact: true }).fill('横向街景，店面偏右，重新安排背景和留白')
    await page.getByRole('button', { name: '生成 3 个差异变体 · 调用 API', exact: true }).click()
    await page.locator('.sp-results').waitFor()
    assert(await page.locator('.sp-results .sp-prompt').count() === 5, 'Reusable style, full prompt and three variants rendered')
    assert(!(await page.locator('.sp-results').innerText()).includes('戴红帽子的猫'), 'Original content stays out of new prompts')
    const jsonDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载 JSON 与参考图配置', exact: true }).click()
    await (await jsonDownload).saveAs('.artifacts/style-prompt/qa-export.json')
    const markdownDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载 Markdown', exact: true }).click()
    await (await markdownDownload).saveAs('.artifacts/style-prompt/qa-export.md')

    const layouts = []
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      // 侧栏宽度会随视口异步调整，几何检查使用调整完成后的可用空间。
      await page.waitForFunction(() => { const element = document.querySelector('.sp-workbench'); return element && element.scrollWidth <= element.clientWidth + 1 })
      for (const dark of [false, true]) {
        await page.evaluate(enabled => document.body.toggleAttribute('data-ds-dark-theme', enabled), dark)
        const geometry = await page.locator('.sp-workbench').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }))
        assert(geometry.scrollWidth <= geometry.width + 1, `No horizontal overflow at ${width}px`)
        layouts.push({ width, dark, ...geometry })
      }
      await page.locator('.sp-workbench').evaluate(element => { element.scrollTop = 0 })
      await page.screenshot({ path: `.artifacts/style-prompt/${width === 1440 ? 'desktop' : 'mobile'}.png` })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByLabel('新主体或场景 · 中文', { exact: true }).focus()
    await page.keyboard.press('Tab')
    assert(await page.getByLabel('希望改变的内容 · 中文', { exact: true }).evaluate(element => document.activeElement === element), 'Keyboard follows the form fields')

    await page.evaluate(async base => { await fetch(`${base}/api/style-prompt/test-control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'waiting' }) }) }, base)
    await page.getByRole('button', { name: '分析风格', exact: true }).click()
    await page.getByRole('button', { name: '停止任务', exact: true }).waitFor()
    await page.getByRole('button', { name: '停止任务', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.sp-error')?.textContent.includes('任务已停止'))
    await page.evaluate(async base => { await fetch(`${base}/api/style-prompt/test-control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'invalid' }) }) }, base)
    await page.getByRole('button', { name: '分析风格', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.sp-error')?.textContent.includes('返回的数据不完整'))
    assert(await page.locator('.sp-workbench').count() === 1, 'Invalid model output keeps the workbench mounted')
    await page.evaluate(async base => { await fetch(`${base}/api/style-prompt/test-control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'success' }) }) }, base)
    await page.reload()
    await page.getByRole('button', { name: '风格提示词', exact: true }).click()
    await page.getByRole('button', { name: '历史记录', exact: true }).click()
    const saved = page.locator('.sp-history button').filter({ hasText: '柔和纸面' }).filter({ hasText: '已完成' }).first()
    await saved.waitFor(); await saved.click()
    await page.getByRole('heading', { name: '柔和纸面', exact: true }).waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll('.sp-references a img')].every(image => image.complete && image.naturalWidth > 0))
    assert(await page.locator('.sp-references a img').count() > 0, 'Saved references use the authenticated image route')
    assert(errors.length === 0, `No uncaught page errors: ${errors.join('; ')}`)
    return { passed: ['native image analysis', 'selected style rules', 'three text-only variants', 'JSON download', 'Markdown download', 'light/dark desktop/mobile', 'keyboard navigation', 'explicit cancellation', 'invalid output', 'saved history after reload'], layouts, pageErrors: errors }
  } finally {
    page.off('pageerror', capture)
    await page.evaluate(enabled => document.body.toggleAttribute('data-ds-dark-theme', enabled), originalDark)
    if (originalViewport) await page.setViewportSize(originalViewport)
  }
}
