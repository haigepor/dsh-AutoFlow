/** Observe painted content and real wheel scrolling across the Host's bounded JSON tails. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const errors = [], onError = error => errors.push(error.message)
  page.on('pageerror', onError)
  try {
    await page.setViewportSize({ width: 1680, height: 960 })
    await page.reload()
    await page.waitForFunction(() => !!window.analysisStreamStability)
    const dialog = page.locator('.vc-analysis-modal'), feed = dialog.locator('.vc-chat-feed'), raw = dialog.locator('.vc-chat-raw')
    await raw.getByRole('button').first().click()
    await raw.locator('pre.shiki').waitFor()
    await raw.evaluate(async element => { await Promise.allSettled(element.getAnimations({ subtree: true }).filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished)) })
    if (new URL(page.url()).searchParams.get('case') === 'locale') {
      const result = await page.evaluate(async () => {
        const feed = document.querySelector('.vc-chat-feed'), source = feed.querySelector('.vc-chat-raw pre')
        const paint = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
        window.analysisStreamStability.append(3600); await paint()
        window.analysisStreamStability.append(500); await paint()
        const rawText = source.textContent, chinese = feed.querySelector('.vc-native-answer').textContent
        window.analysisStreamStability.locale('en'); await paint()
        const english = feed.querySelector('.vc-native-answer').textContent
        const endGap = feed.scrollHeight - feed.clientHeight - feed.scrollTop
        window.analysisStreamStability.locale('zh'); await paint()
        return { chinese, english, restored: feed.querySelector('.vc-native-answer').textContent, rawTextRetained: source.textContent === rawText, rawSourceRetained: source === feed.querySelector('.vc-chat-raw pre'), followsLatest: endGap < 64 && feed.scrollHeight - feed.clientHeight - feed.scrollTop < 64 }
      })
      assert(result.chinese.includes('图片 01') && result.english.includes('Image 01') && result.english.includes('Color'), 'A stable translator must update retained-source headings and field labels when its locale changes')
      assert(!result.english.includes('图片 01') && result.restored === result.chinese, 'Switching back must restore the current labels without changing received observations')
      assert(result.english.includes('Visible observation 00') && result.rawTextRetained && result.rawSourceRetained && result.followsLatest, 'Locale changes must preserve actual observation text, the raw source node and latest-output following')
      assert(!errors.length, `Page errors: ${errors.join('; ')}`)
      return { stableTranslatorLocaleRefresh: true, receivedTextRetained: true, rawSourceRetained: true, followsLatest: true, errors }
    }
    const retention = await page.evaluate(async () => {
      const feed = document.querySelector('.vc-chat-feed'), source = feed.querySelector('.vc-chat-raw pre')
      const frames = [], initialTextLength = feed.querySelector('.vc-native-answer').textContent.length
      let previousTop = feed.scrollTop, maxBackwardPx = 0
      for (let update = 0; update < 30; update++) {
        const output = window.analysisStreamStability.append(333)
        // Sample after the rendering opportunity, including ResizeObserver's measurements.
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
        maxBackwardPx = Math.max(maxBackwardPx, previousTop - feed.scrollTop)
        previousTop = feed.scrollTop
        frames.push({ position: output.position, sameSource: source === feed.querySelector('.vc-chat-raw pre'), readableLength: feed.querySelector('.vc-native-answer')?.textContent.length ?? 0, endGap: feed.scrollHeight - feed.clientHeight - feed.scrollTop })
      }
      return { frames, initialTextLength, maxBackwardPx, viewportHeight: feed.clientHeight, exactRaw: source.textContent === window.analysisStreamStability.raw(), retentionNotice: !!feed.querySelector('.vc-chat-retention') }
    })
    await dialog.screenshot({ path: `.playwright-mcp/analysis-stream-stability-${page.url().includes('/baseline/') ? 'baseline' : 'candidate'}.png`, scale: 'css', animations: 'disabled' })
    assert(retention.frames.every(frame => frame.sameSource && frame.readableLength >= retention.initialTextLength), `Retained streaming output must keep its readable prefix and code surface: ${JSON.stringify(retention)}`)
    assert(retention.maxBackwardPx < retention.viewportHeight, `A bounded tail must not jump backward by a viewport: ${retention.maxBackwardPx}px`)
    assert(retention.frames.every(frame => frame.endGap < 64), `The latest output must remain followed after each painted update: ${JSON.stringify(retention.frames)}`)
    assert(retention.exactRaw && retention.retentionNotice, 'Raw bytes and the existing retention notice must remain available')
    await feed.hover()
    await page.mouse.wheel(0, -900)
    await page.waitForFunction(() => { const feed = document.querySelector('.vc-chat-feed'); return feed.scrollHeight - feed.clientHeight - feed.scrollTop > 400 })
    const readingTop = await feed.evaluate(element => element.scrollTop)
    await page.evaluate(async () => { for (let update = 0; update < 4; update++) { window.analysisStreamStability.append(333); await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))) } })
    assert(Math.abs(await feed.evaluate(element => element.scrollTop) - readingTop) < 3, 'Real wheel scrolling must preserve the historical reading position during streaming')
    await dialog.getByRole('button', { name: '回到最新输出', exact: true }).click()
    await page.waitForFunction(() => { const feed = document.querySelector('.vc-chat-feed'); return feed.scrollHeight - feed.clientHeight - feed.scrollTop < 64 })
    await page.evaluate(() => window.analysisStreamStability.fail())
    await page.waitForFunction(() => document.querySelector('.vc-chat-message')?.getAttribute('aria-busy') === 'false')
    assert(await raw.locator('pre').count() === 1 && (await dialog.locator('.vc-native-answer').innerText()).length >= retention.initialTextLength, 'Failure must retain the already received readable prefix and exact raw tail with its failed source state')
    await page.evaluate(() => window.analysisStreamStability.complete())
    await page.waitForFunction(() => document.querySelector('.vc-native-answer')?.textContent.includes('Visible observation 47'))
    assert(await dialog.locator('.vc-chat-message[aria-busy="false"]').count() === 1 && await dialog.locator('.vc-native-answer').count() === 1, 'Settlement must expose one complete saved result with its completed source state')
    await page.evaluate(() => window.analysisStreamStability.openFresh())
    assert(await dialog.locator('.vc-native-answer').count() === 0, 'A new task with no readable fields must not inherit the previous response prefix')
    await page.evaluate(() => window.analysisStreamStability.writeFresh())
    await page.waitForFunction(() => document.querySelector('.vc-native-answer')?.textContent.includes('Fresh response stays independent.'))
    assert(!(await dialog.locator('.vc-native-answer').innerText()).includes('Visible observation'), 'An untruncated response must render its own fields when earlier retention was reported')
    for (const dark of [true, false]) {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.evaluate(dark => window.analysisStreamStability.theme(dark), dark)
      assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1) && await feed.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Retained source must fit narrow light and dark layouts')
    }
    assert(!errors.length, `Page errors: ${errors.join('; ')}`)
    const result = { retainedCharacters: 12000, paintedUpdates: 34, rawCodeSurfaceRetained: true, readablePrefixRetained: true, exactRawText: true, retentionNotice: true, followsLatest: true, wheelReadingPositionRetained: true, failedSourceRetained: true, completeSavedResult: true, freshResponseIndependent: true, narrowThemes: ['dark', 'light'], errors }
    const expected = await (await page.request.get(new URL('./analysis-stream-stability-ui.expected.json', page.url()).href)).json()
    assert(JSON.stringify(result) === JSON.stringify(expected), 'Streaming behavior must match the owner-local snapshot')
    return { ...result, maxBackwardPx: retention.maxBackwardPx }
  } finally { page.off('pageerror', onError) }
}
