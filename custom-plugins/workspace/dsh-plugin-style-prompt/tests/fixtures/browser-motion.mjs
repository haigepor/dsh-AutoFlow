/** Playwright MCP checks disclosure motion on the populated keyless profile after browser-flow.mjs. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const errors = [], requests = []
  const onError = error => errors.push(String(error))
  const onRequest = request => {
    if (request.url().endsWith('/api/style-prompt/data') && request.method() === 'POST' && ['analyze', 'generate'].includes(request.postDataJSON().operation)) requests.push(request.postDataJSON().operation)
  }
  page.on('pageerror', onError); page.on('request', onRequest)
  const toggle = page.getByRole('button', { name: '历史记录', exact: true })
  const closed = () => page.waitForFunction(() => { const body = document.querySelector('.sp-history-body'); return body && body.getBoundingClientRect().height < 0.5 && body.getAttribute('aria-hidden') === 'true' })
  const sample = () => page.evaluate(async () => {
    const body = document.querySelector('.sp-history-body')
    const trigger = document.querySelector('.sp-history-toggle')
    const values = []
    trigger.click()
    let inertAtFirstFrame = false
    await new Promise(resolve => {
      const start = performance.now()
      const frame = time => {
        if (!values.length) inertAtFirstFrame = body.hasAttribute('inert')
        values.push({ height: body.getBoundingClientRect().height, opacity: Number(getComputedStyle(body).opacity) })
        if (time - start < 550) requestAnimationFrame(frame)
        else resolve()
      }
      requestAnimationFrame(frame)
    })
    return { values, inertAtFirstFrame }
  })
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click()
    await closed()
    assert(await toggle.getAttribute('aria-controls') === await page.locator('.sp-history-body').getAttribute('id'), 'The toggle identifies its controlled panel')
    const opening = await sample()
    const height = opening.values.at(-1).height
    assert(height > 0 && opening.values.some(value => value.height > 1 && value.height < height - 1), 'Opening passes through intermediate heights')
    assert(opening.values.some(value => value.opacity > 0 && value.opacity < 1), 'Opening fades the history content in')
    const closing = await sample()
    assert(closing.inertAtFirstFrame, 'Closing removes history controls from keyboard navigation before the first animation frame')
    assert(closing.values.some(value => value.height > 1 && value.height < height - 1) && closing.values.at(-1).height < 0.5, 'Closing animates back to zero height')
    await toggle.focus(); await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.sp-history-toggle')?.getAttribute('aria-expanded') === 'true')
    await page.keyboard.press('Space'); await closed()
    await page.evaluate(async () => {
      const trigger = document.querySelector('.sp-history-toggle')
      trigger.click()
      await new Promise(resolve => requestAnimationFrame(resolve))
      trigger.click()
      await new Promise(resolve => requestAnimationFrame(resolve))
      trigger.click()
    })
    await page.waitForFunction(() => document.querySelector('.sp-history-body')?.getAttribute('aria-hidden') === 'false')
    assert(await toggle.getAttribute('aria-expanded') === 'true', 'A rapid reversal ends in the last requested state')
    await toggle.click(); await closed()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert(await page.locator('.sp-history-body').evaluate(element => getComputedStyle(element).transitionDuration.split(',').every(duration => parseFloat(duration) === 0)), 'Reduced motion disables the content transition')
    assert(await toggle.locator('svg').evaluate(element => parseFloat(getComputedStyle(element).transitionDuration) === 0), 'Reduced motion disables the arrow transition')
    await toggle.click()
    await page.waitForFunction(() => document.querySelector('.sp-history-body')?.getBoundingClientRect().height > 0)
    await toggle.click(); await closed()
    assert(await page.locator('.sp-history li button').count() === 0, 'Closed history unmounts its controls')
    const rule = page.locator('.sp-rule').first()
    const evidence = rule.getByRole('button', { name: '可见依据', exact: true })
    const selected = await page.locator('.sp-rules input:checked').count()
    await evidence.click()
    await rule.getByText('英文表述', { exact: true }).waitFor()
    assert(await rule.locator('.sp-rule-support dd[lang="en"]').isVisible(), 'Rule details retain the English description')
    assert(await page.locator('.sp-rules input:checked').count() === selected, 'Expanding evidence preserves rule selection')
    await evidence.click()
    assert(await page.getByRole('button', { name: '分析风格', exact: true }).count() === 1, 'The analysis action omits the API implementation label')
    assert(errors.length === 0 && requests.length === 0, 'Disclosures cause no uncaught errors or model requests')
    return { passed: ['height and opacity opening', 'animated closing', 'inert closing content', 'keyboard toggle', 'rapid reversal', 'reduced motion', 'closed controls unmount', 'rule evidence and English details', 'selection preserved', 'concise analysis action', 'no model request'], historyHeight: height, openingFrames: opening.values.length, closingFrames: closing.values.length, pageErrors: errors }
  } finally {
    await page.emulateMedia({ reducedMotion: null })
    page.off('pageerror', onError); page.off('request', onRequest)
  }
}
