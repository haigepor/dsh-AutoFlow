/** Real dialog acceptance against the synthetic 75-batch long-list fixture. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  let target = page.context().pages().find(candidate => candidate.url() === 'http://127.0.0.1:3911/')
  if (!target) target = await page.context().newPage()
  const errors = [], onError = error => errors.push(error.message)
  target.on('pageerror', onError)
  try {
    await target.setViewportSize({ width: 1680, height: 960 })
    await target.goto('http://127.0.0.1:3911/')
    await target.waitForFunction(() => !!window.analysisLongList)
    const dialog = target.locator('.vc-analysis-modal'), feed = target.locator('.vc-chat-feed')
    await target.waitForFunction(() => document.querySelectorAll('.vc-request-exchange').length > 0)
    assert(await dialog.locator('.vc-request-exchange').count() <= 10, 'Long transcripts must mount a bounded set of model exchanges')
    const columns = await dialog.evaluate(element => { const chat = element.querySelector('.vc-chat-panels').getBoundingClientRect(), nav = element.querySelector('.vc-process-navigation-rail').getBoundingClientRect(), info = element.querySelector('.vc-process-context').getBoundingClientRect(); return chat.right <= nav.left + 1 && nav.right <= info.left + 1 && info.right <= element.getBoundingClientRect().right })
    assert(columns, 'Batch navigation and model information must occupy independent columns, with model information last')
    for (let growth = 0; growth < 5; growth++) {
      await target.evaluate(() => window.analysisLongList.grow())
      await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert(await feed.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop < 64), 'Following the latest response must survive changing measured row heights')
    }
    for (const index of [0, 37, 74]) {
      await dialog.locator('.vc-process-navigation nav').getByRole('button').nth(index).click()
      await target.waitForFunction(index => { const message = document.querySelector(`[data-exchange-sequence="${index}"] .vc-chat-message`), scroller = document.querySelector('.vc-chat-feed'); if (!message || !scroller) return false; return Math.abs(message.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16) < 3 }, index, { timeout: 4000 })
    }
    await dialog.locator('.vc-process-navigation nav').getByRole('button').nth(37).click()
    await target.waitForFunction(() => { const row = document.querySelector('[data-exchange-sequence="37"] .vc-chat-message'), scroller = document.querySelector('.vc-chat-feed'); return row && Math.abs(row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16) < 3 })
    await feed.dispatchEvent('wheel', { deltaY: 140 }); await feed.evaluate(element => { element.scrollTop += 140 })
    await target.waitForTimeout(100)
    const reading = await feed.evaluate(element => element.scrollTop)
    await target.evaluate(() => window.analysisLongList.grow())
    await target.waitForTimeout(100)
    assert(await feed.evaluate((element, reading) => Math.abs(element.scrollTop - reading) < 3, reading), 'Reading a historical response must not jump to the live tail')
    await target.evaluate(() => window.analysisLongList.reportUsage(9999))
    assert((await dialog.locator('.vc-process-context .vc-context-usage').innerText()).includes('9,999'), 'Updated reported usage must appear while the dialog stays open')
    await dialog.getByRole('button', { name: '回到最新输出', exact: true }).click()
    await target.waitForFunction(() => { const feed = document.querySelector('.vc-chat-feed'); return feed.scrollHeight - feed.clientHeight - feed.scrollTop < 64 })
    await target.screenshot({ path: '.playwright-mcp/analysis-long-list-desktop.png', animations: 'disabled' })
    for (const dark of [true, false]) {
      await target.setViewportSize({ width: 390, height: 844 })
      await target.evaluate(dark => window.analysisLongList.theme(dark), dark)
      const fits = await dialog.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && element.scrollWidth <= element.clientWidth + 1 })
      assert(fits, 'Narrow light and dark dialogs must fit the viewport')
      assert(await dialog.locator('.vc-process-mobile-context').isVisible() && await dialog.locator('.vc-process-navigation-rail').isHidden() && await dialog.locator('.vc-process-context').isHidden(), 'Narrow dialogs must retain model context and batch navigation through their compact surfaces')
    }
    assert(errors.length === 0, 'Long transcript interactions must not raise browser errors')
    const result = { batches: 75, images: 300, boundedMountedRows: true, separateNavigationAndInformation: true, modelInformationFarRight: true, batchJumps: [1, 38, 75], liveContextUpdatedWithoutReopen: true, historicalScrollRetained: true, dynamicTailFollow: true, latestOutputWorks: true, narrowThemes: ['dark', 'light'], errors }
    const expected = await (await target.request.get('http://127.0.0.1:3911/analysis-long-list-ui.expected.json')).json()
    assert(JSON.stringify(result) === JSON.stringify(expected), 'Long-list observable behavior must match its owner-local snapshot')
    return result
  } finally { target.off('pageerror', onError) }
}
