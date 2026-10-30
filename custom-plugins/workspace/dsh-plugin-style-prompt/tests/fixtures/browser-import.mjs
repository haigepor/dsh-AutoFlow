/** Playwright MCP exercises native File/DataTransfer events on the installed scratch-profile package. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const errors = [], modelRequests = []
  const errorListener = error => errors.push(String(error))
  const requestListener = request => {
    if (request.url().endsWith('/api/style-prompt/data') && request.method() === 'POST') {
      const action = request.postDataJSON()
      if (action.operation === 'analyze' || action.operation === 'generate') modelRequests.push(action.operation)
    }
  }
  page.on('pageerror', errorListener); page.on('request', requestListener)
  const viewport = page.viewportSize(), dark = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
  try {
    await page.reload()
    if (!(await page.getByRole('button', { name: '风格提示词', exact: true }).isVisible())) await page.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('button', { name: '风格提示词', exact: true }).click()
    await page.waitForFunction(() => ![...document.querySelectorAll('.sp-upload button')].some(button => button.disabled))
    const zone = page.getByRole('group', { name: '导入参考图片', exact: true })
    await page.setViewportSize({ width: 1440, height: 1000 })
    for (const enabled of [false, true]) {
      await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), enabled)
      await page.locator('.sp-input-card > section').first().screenshot({ path: `.artifacts/style-prompt/reference-import-${enabled ? 'dark' : 'light'}.png` })
      await page.locator('.sp-dimensions-art').evaluate(image => image.decode())
      await page.locator('.sp-dimensions').screenshot({ path: `.artifacts/style-prompt/dimensions-${enabled ? 'dark' : 'light'}-qa.png` })
    }
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    const pixels = await zone.locator('img').evaluate(async image => Array.from(new Uint8Array(await (await fetch(image.currentSrc)).arrayBuffer())))
    const transfer = specs => page.evaluateHandle(({ specs, pixels }) => {
      const value = new DataTransfer()
      // 合成拖放的数据仓库不接受原生光标状态写入，只记录处理器请求的反馈值。
      let requestedEffect = 'none'
      Object.defineProperty(value, 'dropEffect', { get: () => requestedEffect, set: next => { requestedEffect = next } })
      for (const spec of specs) value.items.add(new File([spec.size === undefined ? Uint8Array.from(pixels) : new Uint8Array(spec.size)], spec.name, { type: spec.type ?? 'image/webp' }))
      return value
    }, { specs, pixels })
    const valid = await transfer([{ name: 'drag-a.webp' }, { name: 'drag-b.webp' }])
    await zone.dispatchEvent('dragenter', { dataTransfer: valid })
    await zone.dispatchEvent('dragover', { dataTransfer: valid })
    assert(await zone.getAttribute('data-dragging') === 'true', 'File drag highlights the import area')
    assert(await valid.evaluate(value => value.dropEffect) === 'copy', 'Eligible local files request copy feedback')
    await zone.locator('img').dispatchEvent('dragenter', { dataTransfer: valid })
    await zone.locator('img').dispatchEvent('dragleave', { dataTransfer: valid })
    assert(await zone.getAttribute('data-dragging') === 'true', 'Moving across child elements keeps the highlight')
    await zone.screenshot({ path: '.artifacts/style-prompt/reference-import-drag.png' })
    await zone.dispatchEvent('drop', { dataTransfer: valid }); await valid.dispose()
    assert(await zone.getAttribute('data-dragging') === 'false', 'Drop clears the highlight')
    await page.waitForFunction(() => document.querySelectorAll('.sp-references img').length === 2 && [...document.querySelectorAll('.sp-references img')].every(image => image.complete && image.naturalWidth > 0))
    const original = await page.locator('.sp-references figcaption').allTextContents()
    for (const [specs, message] of [
      [[{ name: 'valid.png' }, { name: 'text.txt', type: 'text/plain' }], '请选择 PNG'],
      [Array.from({ length: 5 }, (_, index) => ({ name: `excess-${index}.png` })), '每次最多选择'],
      [[{ name: 'empty.png', size: 0 }], '包含空文件'],
      [[{ name: 'large.png', size: 8 * 1024 * 1024 + 1 }], '每张图片不能超过'],
    ]) {
      const rejected = await transfer(specs)
      await zone.dispatchEvent('drop', { dataTransfer: rejected }); await rejected.dispose()
      assert((await page.locator('.sp-import-error').innerText()).includes(message), `Import reports ${message}`)
      assert(JSON.stringify(await page.locator('.sp-references figcaption').allTextContents()) === JSON.stringify(original), 'Rejected batches preserve the selected references')
    }
    assert(modelRequests.length === 0, 'Importing and rejecting files dispatches no analysis or generation request')
    const again = await transfer([{ name: 'drag-a.webp' }, { name: 'drag-b.webp' }])
    await zone.dispatchEvent('drop', { dataTransfer: again }); await again.dispose()
    assert(await page.locator('.sp-import-error').count() === 0, 'A valid import clears the previous issue')
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      // 等待应用侧栏完成响应式收起，再检查插件在实际可用宽度内的布局。
      await page.waitForFunction(() => { const element = document.querySelector('.sp-workbench'); return element && element.scrollWidth <= element.clientWidth + 1 })
      const geometry = await page.locator('.sp-workbench').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }))
      assert(geometry.scroll <= geometry.width + 1, `Import fits ${width}px viewport`)
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('button', { name: '项目视觉模型', exact: true }).click()
    await page.getByRole('menuitem', { name: /Style Prompt · Keyless fixture/ }).click()
    const dimensions = page.locator('.sp-dimensions')
    const options = dimensions.getByRole('button')
    assert(await options.count() === 9 && await dimensions.locator('[aria-pressed="true"]').count() === 9, 'All nine dimensions start selected')
    const color = dimensions.getByRole('button', { name: '色彩', exact: true })
    await color.focus(); await page.keyboard.press('Space')
    assert(await color.getAttribute('aria-pressed') === 'false' && (await dimensions.locator('.sp-dimensions-title').innerText()).includes('8 / 9'), 'Space toggles a dimension and updates the count')
    await page.keyboard.press('Space')
    assert(await color.getAttribute('aria-pressed') === 'true', 'Space can select the dimension again')
    for (const option of await options.all()) await option.click()
    assert(await dimensions.locator('[aria-pressed="true"]').count() === 0 && await page.getByRole('button', { name: '分析风格', exact: true }).isDisabled(), 'No selected dimension prevents analysis')
    await dimensions.getByRole('button', { name: '媒介', exact: true }).click()
    await color.click()
    assert(modelRequests.length === 0, 'Changing dimensions starts no model request')
    await page.evaluate(async () => { await fetch('/api/style-prompt/test-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'waiting' }) }) })
    const submitted = page.waitForRequest(request => request.url().endsWith('/api/style-prompt/data') && request.method() === 'POST' && request.postDataJSON().operation === 'analyze')
    await page.getByRole('button', { name: '分析风格', exact: true }).click()
    assert(JSON.stringify((await submitted).postDataJSON().input.dimensions) === JSON.stringify(['medium', 'color']), 'The API receives only the selected dimensions')
    await page.getByRole('button', { name: '停止任务', exact: true }).waitFor()
    assert(await options.evaluateAll(buttons => buttons.every(button => button.disabled)), 'A running task locks all dimension options')
    await color.evaluate(button => button.click())
    assert(await dimensions.locator('[aria-pressed="true"]').count() === 2, 'Disabled dimension options retain their selection')
    const blocked = await transfer([{ name: 'ignored.png' }])
    await zone.dispatchEvent('dragenter', { dataTransfer: blocked }); await zone.dispatchEvent('dragover', { dataTransfer: blocked })
    assert(await blocked.evaluate(value => value.dropEffect) === 'none', 'An active task refuses a new drag')
    await zone.dispatchEvent('drop', { dataTransfer: blocked }); await blocked.dispose()
    assert(JSON.stringify(await page.locator('.sp-references figcaption').allTextContents()) === JSON.stringify(original), 'An active task keeps its selected files')
    await page.getByRole('button', { name: '停止任务', exact: true }).click()
    await page.getByRole('button', { name: '停止任务', exact: true }).waitFor({ state: 'hidden' })
    for (const option of await options.all()) if (await option.getAttribute('aria-pressed') === 'false') await option.click()
    assert(errors.length === 0, `No uncaught page errors: ${errors.join('; ')}`)
    return { passed: ['transparent artwork in light and dark', 'file drag feedback', 'nested drag stability', 'multi-image drop previews', 'format/count/empty/size rejection', 'atomic selection preservation', 'no model call on import', 'responsive import', 'dimension keyboard and count', 'empty selection blocks analysis', 'selected dimensions reach the API', 'dimension selection locks during analysis', 'disabled drop during analysis'], pageErrors: errors }
  } finally {
    const stop = page.getByRole('button', { name: '停止任务', exact: true })
    if (await stop.isVisible() && await stop.isEnabled()) { await stop.click(); await stop.waitFor({ state: 'hidden' }) }
    await page.evaluate(async () => { await fetch('/api/style-prompt/test-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'success' }) }) })
    page.off('pageerror', errorListener); page.off('request', requestListener)
    await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark)
    if (viewport) await page.setViewportSize(viewport)
  }
}
