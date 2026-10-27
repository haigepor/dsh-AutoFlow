/** Keyless Playwright MCP scenario for an existing collection with at least three remote references and one saved import task; all task mutations are intercepted. Compare returned fields with reference-preview-ui.expected.json. */
async page => {
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  let releaseImage, releaseList, releaseAppend, latestTask, cancelled = false, seededSnapshot = false, completed = 60, stage = 'initial'
  const gate = new Promise(resolve => { releaseImage = resolve })
  const listGate = new Promise(resolve => { releaseList = resolve })
  const appendGate = new Promise(resolve => { releaseAppend = resolve })
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#769b86"/></svg>'
  const originalDark = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
  const dataHandler = async route => {
    const input = route.request().postDataJSON()
    if (input.operation === 'snapshot' && !seededSnapshot) {
      seededSnapshot = true
      const response = await route.fetch(), body = await response.json()
      body.value.images = []
      return route.fulfill({ response, json: body })
    }
    if (input.operation !== 'references-list') return route.continue()
    await listGate
    if (input.args.pageToken) await appendGate
    const response = await route.fetch(), body = await response.json()
    body.value.images.slice(0, 2).forEach((image, index) => { image.thumbnailPath = `/api/visual-curator/resource?imageVersionId=${encodeURIComponent(image.imageVersionId)}&preview=thumbnail&fixturePreview=${index}` })
    await route.fulfill({ response, json: body })
  }
  const galleryHandler = async route => {
    const input = route.request().postDataJSON()
    if (input.operation === 'gallery-reference-stop') {
      cancelled = true
      return route.fulfill({ json: { ok: true, value: { ...latestTask, status: 'cancelled', completed } } })
    }
    if (input.operation !== 'gallery-reference-tasks') return route.continue()
    const response = await route.fetch(), body = await response.json()
    if (body.value.tasks[0]) { latestTask = { ...body.value.tasks[0], status: cancelled ? 'cancelled' : 'running', phase: 'saving', total: 218, completed, registered: 25, failed: 0 }; body.value.tasks = [latestTask] }
    await route.fulfill({ response, json: body })
  }
  const imageHandler = async route => {
    const url = new URL(route.request().url()), fixture = url.searchParams.get('fixturePreview')
    if (fixture === null) return route.continue()
    if (fixture === '0' && !url.searchParams.has('previewRetry')) return route.abort('failed')
    if (fixture === '1') await gate
    await route.fulfill({ contentType: 'image/svg+xml', body: svg })
  }
  await page.route('**/api/visual-curator/data', dataHandler)
  await page.route('**/api/visual-curator/gallery', galleryHandler)
  await page.route('**/api/visual-curator/resource**', imageHandler)
  try {
    await page.reload()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('button', { name: '训练图片工作台', exact: true }).click()
    stage = 'list-skeleton'
    await page.locator('.vc-gallery-skeleton .vc-reference-grid').first().waitFor()
    const skeletonCards = await page.locator('.vc-gallery-skeleton .vc-reference-grid .vc-gallery-skeleton-card').count()
    assert(skeletonCards > 0, 'Initial list must show matching skeleton cards')
    await page.locator('.vc-workbench').screenshot({ path: '.playwright-mcp/reference-list-skeleton.png', scale: 'css' })
    releaseList()
    const first = page.locator('.vc-reference-preview').nth(0), second = page.locator('.vc-reference-preview').nth(1)
    stage = 'failed-preview'
    await page.waitForFunction(() => document.querySelector('.vc-reference-preview')?.getAttribute('data-preview-state') === 'failed')
    assert(await second.getAttribute('data-preview-state') === 'loading', 'Pending image must show loading state')
    const failedOpacity = await first.locator('.vc-image-preview > img').evaluate(el => getComputedStyle(el).opacity)
    assert(failedOpacity === '0', 'Broken native image must not remain visible')
    assert(await first.getByRole('button').count() === 0, 'Failed preview must have no per-card retry button')
    assert(await first.locator('.vc-preview-unavailable').evaluate(el => el.complete && el.naturalWidth > 0), 'Failed preview must use the generated illustration')
    const status = page.locator('.vc-gallery-task-status[data-active="true"]')
    stage = 'import-status'
    await status.waitFor()
    const compactHeight = await status.evaluate(el => el.getBoundingClientRect().height)
    assert(compactHeight >= 58 && compactHeight <= 60, 'Desktop import card must stay compact at about 58px')
    const toolbarGap = await status.evaluate(el => document.querySelector('.vc-reference-toolbar').getBoundingClientRect().top - el.getBoundingClientRect().bottom)
    assert(toolbarGap >= 12 && toolbarGap <= 13, 'Import card must leave a 12px gap before the image toolbar')
    const bar = status.getByRole('progressbar')
    assert(await bar.getAttribute('aria-valuenow') === '60' && await bar.getAttribute('aria-valuemax') === '218', 'Animation must report real committed counts')
    const animation = await status.locator('.vc-gallery-import-art img').evaluate(el => ({ name: getComputedStyle(el).animationName, loaded: el.complete && el.naturalWidth > 0 }))
    assert(animation.name === 'vc-import-float' && animation.loaded, 'Generated illustration must load and animate')
    await page.locator('.vc-workbench').screenshot({ path: '.playwright-mcp/import-animation-and-preview-error.png', scale: 'css' })
    stage = 'retry-preview'
    const healthySrc = await page.locator('.vc-reference-preview').nth(2).locator('.vc-image-preview > img').getAttribute('src')
    await page.locator('.vc-command-actions').getByRole('button', { name: '刷新', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.vc-reference-preview')?.getAttribute('data-preview-state') === 'ready')
    assert(await page.locator('.vc-reference-preview').nth(2).locator('.vc-image-preview > img').getAttribute('src') === healthySrc, 'Top refresh must retain successful preview URLs')
    releaseImage()
    await page.waitForFunction(() => document.querySelectorAll('.vc-reference-preview')[1]?.getAttribute('data-preview-state') === 'ready')
    stage = 'append-loading'
    const sentinel = page.locator('.vc-reference-panel .vc-gallery-load-more')
    await sentinel.scrollIntoViewIfNeeded()
    await page.waitForFunction(() => document.querySelector('.vc-reference-panel .vc-gallery-load-more')?.getAttribute('aria-busy') === 'true')
    const appendSkeletonCards = await sentinel.locator('.vc-gallery-skeleton-card').count()
    assert(appendSkeletonCards === 0, 'Append loading must not add placeholder cards below the reference grid')
    const priorCards = await page.locator('.vc-reference-preview').count()
    releaseAppend()
    await page.waitForFunction(count => document.querySelectorAll('.vc-reference-preview').length > count, priorCards)
    await page.locator('.vc-reference-toolbar').scrollIntoViewIfNeeded()
    stage = 'progress-update'
    completed = 90
    await page.waitForFunction(() => document.querySelector('.vc-gallery-task-status [role="progressbar"]')?.getAttribute('aria-valuenow') === '90')
    const layouts = []
    for (const width of [1280, 1440, 1680, 1920, 390]) {
      await page.setViewportSize({ width, height: 900 })
      layouts.push(await page.locator('.vc-reference-grid').first().evaluate((el, viewport) => { const cards = [...el.children].slice(0, 7).map(card => card.getBoundingClientRect()); return { viewport, columns: getComputedStyle(el).gridTemplateColumns.split(' ').length, overflow: el.scrollWidth > el.clientWidth, equalWidths: Math.max(...cards.map(card => card.width)) - Math.min(...cards.map(card => card.width)) < 1 } }, width))
    }
    assert(layouts.slice(0, 4).every(layout => layout.columns >= 5 && layout.columns <= 7 && layout.equalWidths && !layout.overflow), 'Desktop must show 5-7 equal-width cards')
    assert(layouts[4].columns === 2 && !layouts[4].overflow, 'Narrow grid must keep two usable columns')
    const narrow = await page.locator('.vc-workbench').evaluate(el => ({ width: el.clientWidth, overflow: el.scrollWidth > el.clientWidth }))
    assert(!narrow.overflow, 'Narrow import animation must not overflow')
    await page.locator('.vc-workbench').screenshot({ path: '.playwright-mcp/import-animation-mobile.png', scale: 'css' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await page.locator('.vc-workbench').screenshot({ path: '.playwright-mcp/import-animation-dark.png', scale: 'css' })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert(await status.locator('.vc-gallery-import-art img').evaluate(el => getComputedStyle(el).animationName) === 'none', 'Reduced motion must stop artwork animation')
    stage = 'cancel'
    await status.getByRole('button', { name: '取消引用', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.vc-gallery-task-status')?.getAttribute('data-task-status') === 'cancelled')
    assert(await page.locator('.vc-gallery-import-art').count() === 0, 'Cancelled import must remove the animation')
    return { compactHeight, toolbarGap, topRefreshRecovered: true, noCardRetryButtons: true, skeletonCards, appendSkeletonCards, pendingRecovered: true, progress: [60, 90], total: 218, animation, reducedMotion: true, layouts, narrow, cancelIntercepted: cancelled, realDataWritten: false }
  } catch (error) { throw new Error(`${stage}: ${error.message}`) } finally {
    releaseImage(); releaseList(); releaseAppend()
    await page.unrouteAll({ behavior: 'wait' })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), originalDark)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.reload()
    await page.getByRole('button', { name: '训练图片工作台', exact: true }).click()
  }
}
