/** Native dataset UI over isolated saved packages; the model action callback and model workflow have separate coverage. */
async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  await page.goto('http://127.0.0.1:43719')
  await page.getByRole('tab', { name: '数据集', exact: true }).click()
  const currentRows = await page.locator('[data-dataset-row]').count()
  await page.getByRole('button', { name: '模型整理生成', exact: true }).click()
  const organizationActions = await page.evaluate(() => window.datasetQa.organizationStarts())
  await page.getByRole('button', { name: /展开历史版本/ }).click()
  const historicalRows = await page.locator('[data-dataset-row]').count()
  await page.getByRole('button', { name: '详情', exact: true }).first().click()
  await page.getByRole('tab', { name: '逐图观察', exact: true }).click()
  await page.getByRole('button', { name: /反例参考 · 4/ }).click()
  await page.getByText('模型建议 · 待确认', { exact: true }).first().waitFor({ state: 'visible' })
  const negativeRows = await page.locator('.vc-dataset-sample').count()
  assert(negativeRows > 0, 'Changing roles must keep the sample virtualizer attached')
  await page.getByRole('button', { name: /正例参考 · 4/ }).click()
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.vc-dataset-sample')]
    return rows.length > 0 && rows.every(row => row.querySelector('.vc-row')?.textContent === '正例参考')
  })
  const positiveRows = await page.locator('.vc-dataset-sample').count()
  await page.setViewportSize({ width: 393, height: 852 })
  const dark = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, background: getComputedStyle(document.body).backgroundColor }))
  await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
  const light = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, background: getComputedStyle(document.body).backgroundColor }))
  assert(!dark.overflow && !light.overflow, 'Dataset details must fit the narrow viewport in both themes')
  assert(dark.background !== light.background, 'Both native themes must be exercised')
  const result = { currentRows, historicalRows, organizationActions, negativeSamplesRendered: negativeRows > 0, positiveSamplesRendered: positiveRows > 0, narrowThemesFit: true, reasonsRemainModelSuggestions: true }
  const expected = await (await page.request.get('http://127.0.0.1:43719/dataset-organization-ui.expected.json')).json()
  assert(JSON.stringify(result) === JSON.stringify(expected), 'Dataset organization UI differs from the recorded scenario')
  return result
}
