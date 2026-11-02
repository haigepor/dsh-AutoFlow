/** Collection-menu rename uses the production workbench with isolated storage replies. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const errors = [], onError = error => errors.push(error.message)
  page.on('pageerror', onError)
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.setViewportSize({ width: 1440, height: 900 })
    const trigger = page.locator('.vc-collection-trigger')
    await trigger.click()
    await page.getByRole('menuitem', { name: '重命名训练集', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '重命名训练集', exact: true })
    await dialog.waitFor()
    const original = await dialog.getByRole('textbox').inputValue()
    assert(original.length > 0, 'The current collection name must be prefilled')
    await dialog.getByRole('textbox').fill('  ')
    assert(await dialog.getByRole('button', { name: '重命名训练集', exact: true }).isDisabled(), 'Empty names must not be submitted')
    await dialog.getByRole('textbox').fill('重命名验收')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    assert(await page.evaluate(() => (window.incrementalFixture.state.renames ?? []).length) === 0, 'Closing a rename must not write it')
    await trigger.click()
    await page.getByRole('menuitem', { name: '重命名训练集', exact: true }).click()
    await dialog.getByRole('textbox').fill('重命名验收')
    await dialog.getByRole('textbox').press('Enter')
    await dialog.waitFor({ state: 'hidden' })
    assert((await trigger.innerText()).includes('重命名验收'), 'The menu trigger must update after the save acknowledgement')
    const saved = await page.evaluate(() => window.incrementalFixture.state.renames)
    assert(saved.length === 1 && saved[0].name === '重命名验收', 'Rename must submit the current collection once')
    assert(errors.length === 0, 'Renaming must not produce uncaught browser errors')
    const result = { prefilled: true, blankRejected: true, closeWritesNothing: true, savedFromKeyboard: true, headerUpdated: true, writes: saved.length, pageErrors: errors }
    const expected = await (await page.request.get(new URL('collection-rename-ui.expected.json', page.url()).href)).json()
    assert(JSON.stringify(result) === JSON.stringify(expected), 'Observable behavior must match its owner-local snapshot')
    return result
  } finally { page.off('pageerror', onError) }
}
