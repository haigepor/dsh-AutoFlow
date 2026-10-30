/** Exercise the built native feedback fixture without source or model network calls. */
async (page) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  await page.route('**/api/visual-curator/resource**', route => route.fulfill({
    status: 200, contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#34534a"/></svg>',
  }))
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload()
  await page.evaluate(() => { window.feedbackFixture.setMode('workbench'); window.feedbackFixture.setScenario('preview') })
  await page.locator('.vc-task-filters').getByRole('button', { name: /预览匹配/ }).waitFor()
  const measure = () => page.evaluate(() => {
    const top = document.querySelector('.vc-task-top'), header = top.querySelector('.vc-task-detail-header')
    return { viewport: innerWidth, topHeight: top.getBoundingClientRect().height, headerHeight: header.getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth }
  })
  const desktop = await measure()
  assert(desktop.headerHeight <= 40, 'desktop task header is no longer one compact row')
  assert(await page.locator('.vc-task-top .vc-task-progress-inline').count() === 1, 'target progress is duplicated')
  assert(await page.locator('.vc-task-top .vc-task-stats').count() === 0, 'secondary metrics occupy the task header')
  assert(await page.getByRole('button', { name: '打开预览', exact: true }).count() === 1, 'public preview action missing')
  assert(await page.getByRole('button', { name: '按其他用途裁剪', exact: true }).count() === 0, 'preview is presented as a crop source')
  assert(!await page.locator('.vc-task-top').innerText().then(text => text.includes('尚无交付回执')), 'preview mode shows original-file delivery')
  const details = page.getByRole('button', { name: '任务详情', exact: true })
  await details.click()
  await page.locator('.vc-task-information-menu').waitFor()
  assert((await page.locator('.vc-task-information-menu').innerText()).includes('去重链接'), 'source-link counts are missing from task details')
  const legacy = page.locator('.vc-task-information-menu details').filter({ hasText: '已保存警告' })
  assert(await legacy.locator('li').count() === 1, 'duplicate diagnostics were retained or unrelated warnings were lost')
  assert((await legacy.locator('li').textContent()).includes('图库关键词 forest'), 'unrelated source warning was discarded')
  await page.keyboard.press('Escape')
  assert(await details.getAttribute('aria-expanded') === 'false', 'Escape did not close task details')
  await page.setViewportSize({ width: 390, height: 844 })
  const mobile = await measure()
  await details.click()
  const box = await page.locator('.vc-task-information-menu').boundingBox()
  assert(box && box.x >= 0 && box.x + box.width <= 391, 'task details escape the mobile viewport')
  await page.keyboard.press('Escape')
  assert(!desktop.overflow && !mobile.overflow, 'horizontal overflow')
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.evaluate(() => window.feedbackFixture.setScenario('batches'))
  const batches = page.locator('[data-search-batch]')
  await batches.last().waitFor()
  assert(await batches.count() === 2, 'all task batches are not visible by default')
  await page.getByRole('button', { name: '任务批次', exact: true }).click()
  await page.getByRole('menuitem').last().click()
  assert(await batches.count() === 1 && await batches.first().getAttribute('data-search-batch') === 'batch-two', 'task batch filter mixed results')
  await batches.first().locator('.vc-result-preview').click()
  await page.locator('.vc-result-detail-modal').waitFor()
  await page.keyboard.press('Escape')
  await batches.first().getByRole('button', { name: '任务详情', exact: true }).click()
  await page.locator('.vc-search-batch-detail').waitFor()
  await page.locator('.vc-search-batch-detail').getByRole('button', { name: '全部批次', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-search-batch]').length === 2)
  await page.setViewportSize({ width: 390, height: 844 })
  assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'batch gallery overflowed a narrow viewport')
  const result = { compactDesktopHeader: true, singleProgress: true, secondaryMetricsDisclosed: true, uniqueWarningsRetained: true, detailsEscape: true, previewAction: true, noCropAction: true, noOriginalDelivery: true, mobileMenuInside: true, batchesAllByDefault: true, batchFilter: true, batchPreview: true, batchDetailsRetained: true, batchNarrow: true, horizontalOverflow: false, errors }
  const expected = await page.evaluate(async () => (await fetch('preview-search-ui.expected.json')).json())
  assert(JSON.stringify(result) === JSON.stringify(expected), 'preview UI differs from its saved expected output: ' + JSON.stringify(result))
  return { result, measurements: { desktop, mobile } }
}
