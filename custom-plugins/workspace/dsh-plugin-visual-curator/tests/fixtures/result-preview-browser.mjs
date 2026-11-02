/** Simulate failed image requests at the actual result dialog, then recover by explicit retry. */
async page => {
  const errors = [], assert = (value, message) => { if (!value) throw new Error(message) }
  page.on('pageerror', error => errors.push(error.message))
  let primaryReady = false, thumbnailReady = true
  const requests = []
  await page.route('**/api/visual-curator/resource**', route => {
    const url = new URL(route.request().url()), thumbnail = url.searchParams.get('preview') === 'thumbnail'
    requests.push({ thumbnail, retry: url.searchParams.get('previewRetry') })
    if (thumbnail ? !thumbnailReady : !primaryReady) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#34534a"/></svg>' })
  })
  await page.setViewportSize({ width: 1360, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.reload()
  await page.evaluate(() => { window.feedbackFixture.setMode('workbench'); window.feedbackFixture.setScenario('preview') })
  await page.locator('.vc-result-card').first().getByRole('button', { name: '查看详情', exact: true }).click()
  const dialog = page.locator('.vc-result-detail-modal'), frame = dialog.locator('[data-result-preview]')
  await frame.locator('.vc-result-preview-fallback').waitFor()
  assert(await frame.getAttribute('data-preview-fallback') === 'true' && await frame.locator('img').evaluate(node => node.complete && node.naturalWidth > 0), 'Failed full preview must fall back to the authorized thumbnail')
  const height = (await frame.boundingBox()).height
  assert(height >= 160, 'Unavailable preview must retain a visible image stage')
  for (const dark of [false, true]) {
    await page.evaluate(value => window.feedbackFixture.theme(value), dark)
    const background = await dialog.evaluate(node => getComputedStyle(node, '::before').backgroundColor)
    const alpha = background.match(/(?:,|\/)\s*([\d.]+)\s*\)$/)?.[1]
    assert(!alpha || Number(alpha) >= 0.9, 'Result dialog must use a mostly opaque surface in both themes')
  }
  primaryReady = true
  await dialog.getByRole('button', { name: '重试完整预览', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-result-preview]')?.getAttribute('data-result-preview') === 'ready' && !document.querySelector('[data-result-preview]')?.hasAttribute('data-preview-fallback'))
  assert(requests.some(request => !request.thumbnail && request.retry === '1'), 'Retry must perform a fresh primary image request')
  assert(Math.abs((await frame.boundingBox()).height - height) < 1, 'Preview recovery must keep the stage stable')
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
  primaryReady = false; thumbnailReady = false
  await page.locator('.vc-task-filters').getByRole('button', { name: /全部结果/ }).click()
  await page.locator('.vc-result-card').nth(1).getByRole('button', { name: '查看详情', exact: true }).click()
  await dialog.getByRole('alert').waitFor()
  assert((await frame.boundingBox()).height >= 160 && !await frame.locator('a').isVisible(), 'Both failures must show feedback instead of a collapsed broken image')
  primaryReady = true
  await dialog.getByRole('button', { name: '重试', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-result-preview]')?.getAttribute('data-result-preview') === 'ready')
  await page.setViewportSize({ width: 390, height: 844 })
  assert(await dialog.evaluate(node => node.getBoundingClientRect().left >= 0 && node.getBoundingClientRect().right <= innerWidth), 'Recovered dialog must fit narrow screens')
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
  const result = { reachableFromResult: true, thumbnailFallback: true, clearFallbackNotice: true, freshPrimaryRetry: true, stableImageStage: true, bothFailuresReported: true, explicitRetryRecovers: true, mostlyOpaqueThemes: true, narrowFits: true, errors }
  const expected = await page.evaluate(async () => (await fetch('result-preview-ui.expected.json')).json())
  assert(JSON.stringify(result) === JSON.stringify(expected), 'Result preview UI output differs')
  return result
}
