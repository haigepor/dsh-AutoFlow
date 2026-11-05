/** Shared history disclosure remains accessible with regular and reduced motion. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const toggle = async () => {
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '运行记录与历史', exact: true }).click()
  }
  if (await page.locator('.sp-canvas-history').getAttribute('aria-hidden') === 'false') await toggle()
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion })
    await toggle()
    await page.waitForFunction(() => document.querySelector('.sp-canvas-history')?.getAttribute('aria-hidden') === 'false')
    assert(await page.locator('.sp-canvas-history').evaluate(element => element.getBoundingClientRect().height > 0), 'Opening reveals retained history')
    await toggle()
    assert(await page.locator('.sp-canvas-history').getAttribute('aria-hidden') === 'true', 'Closing immediately leaves accessibility navigation')
    assert(await page.locator('.sp-canvas-history').evaluate(element => element.hasAttribute('inert')), 'Closed history cannot receive focus')
    await page.waitForFunction(() => document.querySelector('.sp-canvas-history')?.getBoundingClientRect().height < 1)
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  return { passed: ['top-menu history entry', 'disclosure visibility', 'closed focus containment', 'reduced motion'], bottomBar: await page.locator('.sp-canvas-bottom').count() }
}
