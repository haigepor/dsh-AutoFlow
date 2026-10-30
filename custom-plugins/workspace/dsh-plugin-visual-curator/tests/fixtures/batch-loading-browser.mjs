async (page) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/visual-curator/resource**', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#526956"/></svg>' }))
  await page.goto(page.url())
  await page.evaluate(() => { window.feedbackFixture.setMode('workbench'); window.feedbackFixture.setScenario('batches'); window.feedbackFixture.setBatchLoading('initial') })
  const skeletons = page.locator('.vc-search-batch-skeleton'), result = {}
  await skeletons.first().waitFor()
  result.initialCards = await skeletons.count()
  result.unknownCounts = await page.locator('.vc-search-batches-summary').evaluate(element => element.querySelectorAll('.vc-search-batches-count').length === 2 && !element.textContent.includes('0'))
  result.columns = []; result.noOverflow = true
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const geometry = await skeletons.first().evaluate(element => ({ columns: getComputedStyle(element.parentElement).gridTemplateColumns.split(' ').length, fits: document.documentElement.scrollWidth <= innerWidth && element.closest('.vc-search-batches-scroll').scrollWidth <= element.closest('.vc-search-batches-scroll').clientWidth }))
    result.columns.push(geometry.columns); result.noOverflow &&= geometry.fits
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  result.reducedMotion = await page.locator('.vc-search-batch-skeleton-title').first().evaluate(element => getComputedStyle(element, '::after').animationName === 'none')
  await page.evaluate(() => window.feedbackFixture.theme(false))
  result.lightTheme = await skeletons.first().evaluate(element => getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)')
  await page.evaluate(() => window.feedbackFixture.setBatchLoading('ready'))
  await page.locator('[data-search-batch]').first().waitFor()
  const card = await page.locator('[data-search-batch]').first().elementHandle()
  await page.evaluate(() => window.feedbackFixture.setBatchLoading('refresh'))
  result.retainedOnRefresh = await card.evaluate(element => element.isConnected) && await skeletons.count() === 0
  await page.evaluate(() => window.feedbackFixture.setBatchLoading('stale-error'))
  await page.getByRole('alert').waitFor()
  result.retainedOnFailure = await card.evaluate(element => element.isConnected) && await skeletons.count() === 0
  await page.evaluate(() => window.feedbackFixture.setBatchLoading('error'))
  await page.locator('[data-search-batch]').waitFor({ state: 'detached' })
  result.errorWithoutFalseZero = await page.locator('.vc-search-batches-summary').evaluate(element => element.textContent.includes('—') && !element.textContent.includes('0'))
  await page.evaluate(() => window.feedbackFixture.setBatchLoading('empty'))
  await page.getByText('当前分组暂无找图或裁剪批次。', { exact: true }).waitFor()
  result.emptyHasRealZero = await page.locator('.vc-search-batches-summary').evaluate(element => element.querySelector('strong').textContent === '0')
  result.errors = errors
  const expected = await page.evaluate(async () => (await fetch('batch-loading-ui.expected.json')).json())
  if (Object.keys(result).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => JSON.stringify(result[key]) !== JSON.stringify(value))) throw new Error(JSON.stringify({ expected, actual: result }))
  return result
}
