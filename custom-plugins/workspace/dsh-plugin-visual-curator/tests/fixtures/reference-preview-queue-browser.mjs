/** Slow controlled media exercises real native preview factories and the shared image lane. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }, errors = [], waits = new Set(), failed = new Set()
  if (new URL(page.url()).searchParams.has('real-network')) {
    await page.setViewportSize({ width: 1000, height: 700 }); await page.reload()
    await page.waitForFunction(() => window.previewFixture.stats().calls.length >= 2)
    const initial = await page.evaluate(() => window.previewFixture.stats())
    assert(initial.active === 2 && initial.maxActive === 2, 'The real HTTP server must hold exactly two slow image requests')
    const measured = await page.evaluate(async () => {
      const start = performance.now(), response = await fetch(`/metadata.json?probe=${Date.now()}`)
      if (!(await response.json()).ready) throw new Error('Metadata was unavailable')
      const timing = performance.getEntriesByType('resource').findLast(entry => entry.name.includes('/metadata.json?probe='))
      return { elapsedMs: performance.now() - start, activeImages: window.previewFixture.stats().active, ...(timing ? { queuedMs: timing.requestStart - timing.startTime, ttfbMs: timing.responseStart - timing.requestStart } : {}) }
    })
    assert(measured.activeImages === 2, 'Metadata must finish before either real slow image response releases its connection')
    await page.waitForFunction(() => document.querySelectorAll('[data-preview-state="ready"]').length >= 2)
    const stats = await page.evaluate(() => window.previewFixture.stats())
    assert(stats.maxActive === 2, 'The real HTTP image lane must retain its connection ceiling')
    await page.evaluate(() => window.previewFixture.dispose())
    return { realHttp: true, metadataDuringSlowImages: true, sharedFactories: true, maxActive: stats.maxActive, measurements: measured }
  }
  let hold = true
  const pixel = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#597663"/></svg>'
  const media = async route => {
    if (hold) await new Promise(resolve => waits.add(resolve))
    const path = new URL(route.request().url()).pathname
    const status = path.endsWith('/photo-8.svg') && !failed.has(path) ? 503 : 200
    failed.add(path)
    try { await route.fulfill({ status, contentType: 'image/svg+xml', body: pixel }) }
    catch (error) { if (!route.request().failure()) throw error }
  }
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/qa-media/**', media)
  try {
    await page.setViewportSize({ width: 1000, height: 700 }); await page.reload()
    await page.waitForFunction(() => window.previewFixture.stats().calls.length === 2)
    const initial = await page.evaluate(() => window.previewFixture.stats())
    assert(initial.maxActive === 2 && initial.calls.some(src => src.includes('photo-0.svg')) && initial.calls.some(src => src.includes('photo-1.svg')), 'Different factories must share exactly two active image fetches')
    assert(initial.calls.every(src => !/photo-(8|9|1[0-5])\.svg/.test(src)), 'Images outside the scrolling viewport must not start')
    const metadataMs = await page.evaluate(async () => { const start=performance.now(), response=await fetch('/metadata.json'); if (!(await response.json()).ready) throw new Error('Metadata was unavailable'); return performance.now()-start })
    assert(await page.evaluate(() => window.previewFixture.stats().active) === 2, 'Metadata must complete while the two slow images remain pending')
    await page.locator('#preview-scroll').evaluate(element => { element.scrollTop=element.scrollHeight })
    await page.waitForFunction(() => window.previewFixture.stats().cancelled >= 2 && window.previewFixture.stats().calls.length >= 4)
    hold = false; for (const release of waits) release(); waits.clear()
    await page.waitForFunction(() => document.querySelectorAll('[data-preview-state="failed"]').length === 1 && window.previewFixture.stats().active === 0)
    await page.getByRole('button', { name: '刷新失败图片', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[data-preview-state="failed"]') && window.previewFixture.stats().active === 0)
    const retried = await page.evaluate(() => window.previewFixture.stats())
    assert(retried.calls.some(src => src.includes('photo-8.svg?previewRetry=1')), 'Only an explicit refresh may retry the failed image')
    assert(retried.maxActive === 2, 'Scrolling and retries must retain the shared connection ceiling')
    await page.getByRole('button', { name: '卸载列表', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.vc-reference-preview') && window.previewFixture.stats().urls === 0)
    await page.evaluate(() => window.previewFixture.reactivate())
    await page.waitForFunction(() => document.querySelectorAll('[data-preview-state="ready"]').length >= 4 && window.previewFixture.stats().active === 0)
    assert(await page.evaluate(() => window.previewFixture.stats().maxActive) === 2, 'Re-enabling the same module must retain its queue limit')
    const result = { sharedFactories: true, maxImageRequests: 2, metadataDuringSlowImages: true, offscreenDeferred: true, scrollCancelsDownloads: true, failedImageRetry: true, leasesReleasedOnUnmount: true, reactivation: true, noEmptyImageRequests: true, errors }
    assert(errors.length === 0, 'Preview loading must not produce page errors')
    const expected = await page.evaluate(async () => (await fetch('/expected.json')).json())
    assert(JSON.stringify(result) === JSON.stringify(expected), 'Preview queue acceptance differs from its saved expectation')
    return { result, measurements: { metadataMs, initialActive: initial.active, maxActive: retried.maxActive, cancelled: retried.cancelled } }
  } finally {
    hold = false; for (const release of waits) release()
    await page.evaluate(() => window.previewFixture?.dispose())
    await page.unroute('**/qa-media/**', media)
  }
}
