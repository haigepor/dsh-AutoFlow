/** One compact upper-right card changes from preparation to actual image progress and completion. */
async page => {
  const context = await page.context().browser().newContext(), test = await context.newPage(), errors = []
  const assert = (value, message) => { if (!value) throw new Error(message) }
  test.on('pageerror', error => errors.push(error.message))
  try {
    await test.setViewportSize({ width: 1920, height: 960 })
    await test.emulateMedia({ reducedMotion: 'reduce' })
    await test.goto('http://127.0.0.1:39089/?launch')
    const card = test.locator('[data-conversation-launch]')
    await card.waitFor()
    assert((await card.innerText()).includes('寻找符合当前风格的山林与湖泊图片'), 'The saved search brief must appear before the first Run')
    assert((await card.innerText()).includes('10'), 'The saved image target must be visible')
    const placement = await card.evaluate(node => {
      const bounds = node.getBoundingClientRect(), body = node.closest('[data-conversation-content]').getBoundingClientRect()
      return { overlay: !!node.closest('[data-conversation-body-overlay]'), composer: !!node.closest('[class*="composerStack"]'), width: bounds.width, height: bounds.height, right: body.right - bounds.right, top: bounds.top - body.top }
    })
    assert(placement.overlay && !placement.composer && placement.width <= 320 && placement.height < 220 && placement.right >= 12 && placement.right <= 20 && placement.top < 180, 'Saved requirements must use a compact upper-right card outside the composer')
    assert(await card.getByRole('button', { name: '任务详情', exact: true }).getAttribute('aria-expanded') === 'false', 'Preparation details must start collapsed')
    assert(await test.locator('[data-task-run]').count() === 0, 'Preparation must not fabricate a Run or image progress')
    await card.getByRole('button', { name: '停止任务', exact: true }).click()
    await test.waitForFunction(() => document.querySelector('[data-conversation-launch]')?.textContent.includes('已停止'))
    assert((await card.innerText()).includes('寻找符合当前风格'), 'Stopping must retain the saved requirements')
    const calls = await test.evaluate(() => window.dockFixture.state.calls)
    assert(calls.some(([operation, session]) => operation === 'search-launch-stop' && session === 'a'), 'Stopping must use this conversation’s launch')
    assert(!calls.some(([operation]) => operation === 'run-control'), 'A Run must not be invented for launch cancellation')
    await test.reload(); await card.waitFor()
    await test.evaluate(() => window.dockFixture.acceptLaunch())
    await card.getByText('检索准备中', { exact: true }).waitFor()
    await card.getByText('会话已启动，图片检索尚未开始', { exact: true }).waitFor()
    await card.getByRole('button', { name: '任务详情', exact: true }).click()
    assert(await card.getByRole('button', { name: '收起详情', exact: true }).getAttribute('aria-expanded') === 'true', 'Details must expand on request')
    await test.keyboard.press('Escape')
    assert(await card.getByRole('button', { name: '任务详情', exact: true }).evaluate(node => node === document.activeElement), 'Escape must collapse details and restore focus')
    const themeColors = []
    for (const dark of [false, true]) {
      await test.evaluate(value => window.dockFixture.theme(value), dark)
      themeColors.push(await card.evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor })))
    }
    assert(themeColors[0].color !== themeColors[1].color && themeColors[0].background !== themeColors[1].background, 'The compact card must follow both native themes')
    await test.evaluate(() => { window.savedLaunchCard = document.querySelector('[data-conversation-task]'); window.dockFixture.startSearch() })
    const running = test.locator('[data-task-run="search"]')
    await running.waitFor(); await running.locator('[data-result="selected"] strong').waitFor()
    assert(await test.locator('[data-conversation-task]').count() === 1 && await test.locator('[data-conversation-launch]').count() === 0, 'Actual Run feedback must replace preparation without a duplicate card')
    assert(await test.evaluate(() => window.savedLaunchCard === document.querySelector('[data-conversation-task]')), 'The transition must retain the card in place')
    await running.getByText('进行中', { exact: true }).waitFor()
    await test.evaluate(() => window.dockFixture.completeSearch())
    await running.getByText('已完成', { exact: true }).waitFor()
    await test.waitForFunction(() => document.querySelector('[data-result="selected"] strong')?.textContent === '10')
    await test.setViewportSize({ width: 390, height: 844 })
    assert(!await running.isVisible(), 'The task card must hide when there is no room beside the conversation')
    assert(await test.locator('body').evaluate(node => node.scrollWidth <= innerWidth + 1), 'The native narrow conversation must not overflow')
    await test.goto('http://127.0.0.1:39089/?launch'); await test.locator('[data-conversation-launch]').waitFor({ state: 'attached' })
    assert(!await card.isVisible(), 'Preparation must also hide when there is no room beside the conversation')
    await test.setViewportSize({ width: 1920, height: 960 }); await card.waitFor()
    assert(errors.length === 0, 'Preparation feedback must not throw browser errors')
    const result = { requirementsVisible: true, targetVisible: true, compactUpperRight: true, outsideComposer: true, detailsDisclosure: true, bothThemes: true, noFakeRun: true, inPlaceRunTransition: true, completedResults: true, narrowHidden: true, stopBeforeFirstRun: true, stoppedBriefRetained: true, errors }
    const expected = await (await test.request.get('http://127.0.0.1:39089/launch-preparation.expected.json')).json()
    assert(JSON.stringify(result) === JSON.stringify(expected), 'Launch preparation acceptance differs')
    return result
  } finally { await context.close() }
}
