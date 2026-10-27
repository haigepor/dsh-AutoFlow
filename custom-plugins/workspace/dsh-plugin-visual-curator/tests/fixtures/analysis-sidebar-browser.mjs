/** Read-only Playwright MCP acceptance against the retained nine-image QA transcript. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const dark = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
  const modal = page.locator('.vc-analysis-modal'), links = modal.locator('.vc-process-batch-link')
  const runId = '5ad84fa870ceaf9085a66fcaf2f118770eb6666857627103fb263115ea8eefe0'
  const countRequests = async () => {
    const response = await page.request.post(new URL('/api/visual-curator/data', page.url()).href, { data: { operation: 'analysis-detail', args: { runId } } })
    return (await response.json()).value.requests.length
  }
  const aligned = async index => {
    await page.waitForFunction(index => {
      const modal = document.querySelector('.vc-analysis-modal'), link = modal?.querySelectorAll('.vc-process-batch-link')[index]
      const target = link && document.getElementById(link.getAttribute('aria-controls')), feed = modal?.querySelector('.vc-chat-feed')
      if (!target || !feed || feed.hidden || link.getAttribute('aria-current') !== 'step') return false
      const anchor = target.querySelector('.vc-chat-message') ?? target
      const offset = anchor.getBoundingClientRect().top - feed.getBoundingClientRect().top
      return offset >= 12 && offset <= 20 && document.activeElement === target
    }, index, { timeout: 10000 })
  }
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await links.first().waitFor()
    const before = await countRequests(), count = await links.count()
    const art = modal.locator('.vc-process-context-heading img')
    await page.waitForFunction(() => { const img = document.querySelector('.vc-process-context-heading img'); return img?.complete && img.naturalWidth > 0 })
    assert(await art.evaluate(img => img.clientWidth === 64), 'Decorative artwork must stay compact')
    for (let index = 0; index < count; index++) {
      await links.nth(index).click()
      await aligned(index)
      assert(await modal.locator('.vc-process-batch-link[aria-current=step]').count() === 1, 'Exactly one response must be selected')
    }
    const summaryCollapsed = await modal.locator('.vc-process-disclosure').getAttribute('data-open') === null
    assert(summaryCollapsed, 'Summary navigation must reveal the final answer with the process collapsed')
    await modal.getByRole('tab', { name: '运行日志', exact: true }).click()
    await links.nth(1).click()
    await aligned(1)
    assert(await modal.getByRole('tab', { name: '模型对话', exact: true }).getAttribute('aria-selected') === 'true', 'Batch selection must leave the log view')
    await modal.locator('.vc-process-context').evaluate(el => { el.scrollTop = 0 })
    await modal.screenshot({ path: '.playwright-mcp/analysis-sidebar-v2-light.png', scale: 'css' })
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await modal.screenshot({ path: '.playwright-mcp/analysis-sidebar-v2-dark.png', scale: 'css' })
    await page.setViewportSize({ width: 390, height: 844 })
    assert(!await modal.locator('.vc-process-context').isVisible(), 'Narrow dialogs need the compact navigation menu')
    const picker = modal.locator('.vc-process-mobile-nav').getByRole('button', { name: '批次导航', exact: true })
    await picker.click()
    await page.getByRole('menuitem', { name: /批次 2 · 已完成/ }).click()
    await aligned(3)
    const overflow = await modal.evaluate(el => el.scrollWidth > el.clientWidth)
    assert(!overflow, 'Narrow navigation must not overflow')
    await modal.screenshot({ path: '.playwright-mcp/analysis-sidebar-v2-mobile.png', scale: 'css' })
    assert(await countRequests() === before, 'Navigation must never dispatch another model request')
    return { targets: count, selectedAndFocused: count, artworkLoaded: true, summaryCollapsed, logToResponse: true, narrowPicker: true, narrowOverflow: overflow, modelRequestsUnchanged: true, actualDataWritten: false }
  } finally {
    await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark)
    await page.setViewportSize({ width: 1440, height: 900 })
  }
}
