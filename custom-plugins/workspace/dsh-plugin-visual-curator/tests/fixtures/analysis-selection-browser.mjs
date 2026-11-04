/** Real components exercise role selection, historical package admission and pinned complete rows. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const errors = [], onError = error => errors.push(error.message)
  page.on('pageerror', onError)
  try {
    const expected = await page.evaluate(async () => (await fetch('/analysis-selection-ui.expected.json')).json())
    const selections = []
    for (const status of ['running', 'paused']) {
      await page.reload()
      await page.evaluate(status => window.incrementalFixture.configureRoleWorkflow(status), status)
      const find = page.getByRole('button', { name: '按此画像找图', exact: true })
      assert(await find.isEnabled(), `${status}: completed datasets must stay reachable`)
      await find.click()
      const dialog = page.getByRole('dialog', { name: '按此画像找图', exact: true })
      await dialog.getByRole('button', { name: '请选择已完成的完整数据集', exact: true }).click()
      await page.getByRole('menuitem', { name: /v7/ }).click()
      const start = dialog.getByRole('button', { name: '开始找图', exact: true })
      assert(await start.isEnabled(), `${status}: selecting a completed version must allow search`)
      await start.click()
      const submitted = await page.evaluate(() => window.incrementalFixture.state.searchLaunches.at(-1))
      assert(submitted.modelProfileId === expected.historicalProfileId && submitted.datasetId === expected.historicalDatasetId, 'Search must use the selected historical version')
      selections.push(status)
      await dialog.getByRole('button', { name: '关闭', exact: true }).last().click()
    }
    await page.reload()
    await page.evaluate(() => { window.incrementalFixture.configureRoleWorkflow('paused'); window.incrementalFixture.showProfile() })
    const inspector = page.getByRole('button', { name: '风格画像', exact: true })
    if (await inspector.getAttribute('aria-expanded') !== 'true') await inspector.click()
    await page.locator('.vc-profile-actions').getByRole('button', { name: '重新分析', exact: true }).click()
    const scope = page.getByRole('dialog', { name: '选择本次分析范围', exact: true })
    await scope.getByRole('button', { name: `仅正例 ${expected.positiveCount}`, exact: true }).click()
    assert((await scope.locator('.vc-analysis-scope-option').last().innerText()).includes(`${expected.positiveCount}`), 'Positive selection uses its own count')
    await scope.getByRole('button', { name: `仅反例 ${expected.negativeCount}`, exact: true }).click()
    assert((await scope.locator('.vc-analysis-scope-option').first().innerText()).includes(`${expected.negativeCount}`), 'Negative selection uses its own count')
    for (const [width, height, dark] of [[1440, 900, true], [760, 780, false], [420, 900, true]]) {
      await page.setViewportSize({ width, height })
      await page.evaluate(dark => window.incrementalFixture.theme(dark), dark)
      assert(await scope.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `Role selection must fit ${width}px`)
    }
    await scope.locator('.vc-analysis-scope-option').first().click()
    const launch = await page.evaluate(() => window.incrementalFixture.state.launches.at(-1))
    assert(launch.analysisScope === expected.selectedAnalysisScope && launch.analysisMode === 'pending', 'Analysis must submit its selected role and reuse policy')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.reload(); await page.evaluate(() => window.incrementalFixture.configureRoleWorkflow('running'))
    await page.getByRole('tab', { name: '数据集', exact: true }).click()
    const row = page.locator('[data-dataset-row]').first()
    assert((await row.innerText()).includes(expected.pinnedLabel), 'The first full package must be labelled as the previous complete dataset during new analysis')
    assert(errors.length === 0, `Browser runtime errors: ${errors.join('; ')}`)
    return { role: launch.analysisScope, historicalSelections: selections, finalRowLabel: expected.pinnedLabel, widths: [1440, 760, 420], runtimeErrors: errors }
  } finally { page.off('pageerror', onError) }
}
