/** Keyless page scenario; model starts and task controls are intercepted, and no persisted records are changed. */
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message) }
  let phase = 'idle', styleId, holdPause = false, releasePause, pauseEntered, snapshots = 0, detailReads = 0, starts = 0
  const commands = [], gate = new Promise(resolve => { releasePause = resolve }), entered = new Promise(resolve => { pauseEntered = resolve })
  const runId = 'analysis-controls-ui-fixture', originalDark = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
  const task = () => ({ runId, styleId, name: '分析交互验收', status: phase, observed: 0, total: 218, model: 'Fixture Vision', reasoningEffort: 'low', attempts: 1, startedAt: '2026-10-26T00:00:00.000Z', phase: 'analyzing', autoResume: phase === 'running' })
  const run = status => ({ runId, styleId, kind: 'analyze', taskBrief: '', status, counts: { observed: 0 }, results: [], warnings: [] })
  const data = async route => {
    const input = route.request().postDataJSON()
    if (input.operation === 'snapshot') {
      snapshots++
      const response = await route.fetch(), body = await response.json(), style = body.value.styles.find(item => !item.archived)
      styleId = style.styleId
      delete style.modelProfile
      if (phase === 'idle') delete style.analysis
      else style.analysis = { runId, status: phase, stale: false, stage: 'analyzing', observed: 0, total: 218, model: 'Fixture Vision', samples: [] }
      body.value.styles = [style]; body.value.runs = phase === 'idle' ? [] : [run(phase)]; body.value.workspaceRevision = 'analysis-control-fixture'
      return route.fulfill({ response, json: body })
    }
    if (input.operation === 'reference-analyze') { starts++; phase = 'running'; return route.fulfill({ json: { ok: true, value: { runId, status: phase } } }) }
    if (input.operation === 'run-get' && input.args.runId === runId) return route.fulfill({ json: { ok: true, value: run(phase) } })
    if (input.operation === 'run-control' && input.args.runId === runId) {
      commands.push(input.args.command)
      assert(input.args.waitForCompletion === false, 'Page controls must request an immediate acknowledgement')
      if (input.args.command === 'pause') {
        if (holdPause) { pauseEntered(); await gate; return route.fulfill({ json: { ok: true, value: run('pausing') } }) }
        phase = 'paused'; return route.fulfill({ json: { ok: true, value: run('pausing') } })
      }
      phase = input.args.command === 'resume' ? 'running' : 'cancelling'
      return route.fulfill({ json: { ok: true, value: run(phase) } })
    }
    if (input.operation === 'analysis-detail') { detailReads++; return route.continue() }
    return route.continue()
  }
  const gallery = async route => {
    const input = route.request().postDataJSON()
    if (input.operation === 'gallery-reference-tasks') return route.fulfill({ json: { ok: true, value: { tasks: [], analyses: phase === 'idle' ? [] : [task()], workspaceRevision: 'analysis-control-fixture' } } })
    return route.continue()
  }
  const image = route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#81958b"/></svg>' })
  await page.route('**/api/visual-curator/data', data)
  await page.route('**/api/visual-curator/gallery', gallery)
  await page.route('**/api/visual-curator/resource**', image)
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.reload()
    await page.getByRole('button', { name: '训练图片工作台', exact: true }).click()
    const start = Date.now()
    await page.locator('.vc-profile-dock').getByRole('button', { name: '开始视觉分析', exact: true }).click()
    await page.locator('.vc-profile-dock .vc-profile-state[data-analyzing="true"]').waitFor()
    const feedbackMs = Date.now() - start
    assert(await page.locator('.vc-library-status').count() === 0, 'Gallery must not repeat analysis state')
    assert(await page.getByRole('dialog').count() === 0 && detailReads === 0, 'Starting analysis must not automatically mount or request process details')
    const art = page.locator('.vc-profile-dock .vc-profile-analysis-art img')
    await page.waitForFunction(() => { const image = document.querySelector('.vc-profile-dock .vc-profile-analysis-art img'); return image?.complete && image.naturalWidth > 0 })
    const before = await art.screenshot({ path: '.playwright-mcp/analysis-animation-frame-a.png', scale: 'css' })
    await page.waitForTimeout(950)
    const after = await art.screenshot({ path: '.playwright-mcp/analysis-animation-frame-b.png', scale: 'css' })
    assert(!before.equals(after), 'Generated multi-stage animation must advance')
    await page.locator('.vc-workbench').screenshot({ path: '.playwright-mcp/analysis-sidebar-desktop.png', scale: 'css' })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.waitForFunction(() => { const art = document.querySelector('.vc-profile-dock .vc-profile-analysis-art'); return art?.querySelector('img').currentSrc === art?.querySelector('source').srcset })
    const stillBefore = await art.screenshot()
    await page.waitForTimeout(950)
    assert(stillBefore.equals(await art.screenshot()), 'Reduced motion must use a static poster')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.locator('.vc-profile-dock').getByRole('button', { name: '收起', exact: true }).click()
    assert(await page.locator('.vc-profile-dock-toggle').getAttribute('aria-expanded') === 'false', 'Sidebar must collapse')
    assert((await page.locator('.vc-profile-dock-toggle').innerText()).includes('分析'), 'Collapsed sidebar entry must retain a compact status badge')
    await page.locator('.vc-profile-dock-toggle').click()
    await page.setViewportSize({ width: 390, height: 900 })
    await page.locator('.vc-profile-modal-toggle').click()
    const modal = page.locator('.vc-profile-modal')
    assert(await modal.locator('.vc-profile-state[data-analyzing="true"]').count() === 1, 'Narrow sidebar dialog must own one state block')
    assert(await modal.evaluate(el => el.scrollWidth <= el.clientWidth), 'Narrow sidebar must not overflow')
    await modal.screenshot({ path: '.playwright-mcp/analysis-sidebar-mobile.png', scale: 'css' })
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await page.locator('.vc-workbench').screenshot({ path: '.playwright-mcp/analysis-sidebar-dark.png', scale: 'css' })
    await page.locator('.vc-task-toggle').click()
    const detail = page.locator('.vc-task-detail')
    await detail.getByRole('button', { name: '暂停', exact: true }).click()
    await detail.getByRole('button', { name: '继续', exact: true }).waitFor({ timeout: 15000 })
    await detail.getByRole('button', { name: '继续', exact: true }).click()
    await detail.getByRole('button', { name: '暂停', exact: true }).waitFor()
    holdPause = true
    await detail.getByRole('button', { name: '暂停', exact: true }).click()
    await entered
    assert(await detail.getByRole('button', { name: /暂停/ }).isDisabled(), 'Pending pause must show immediate disabled feedback')
    await detail.getByRole('button', { name: '取消', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.vc-task-actions')?.textContent.includes('正在取消'))
    assert(commands.join(',') === 'pause,resume,pause,cancel', 'Cancel must pass a still-pending pause')
    assert(await page.locator('.vc-command-actions').getByRole('button', { name: '刷新', exact: true }).isEnabled(), 'Task controls must not lock unrelated page actions')
    releasePause()
    await page.waitForTimeout(100)
    assert((await detail.innerText()).includes('正在取消'), 'Late pause receipt must not undo cancellation')
    phase = 'cancelled'
    await page.waitForFunction(() => document.querySelector('.vc-task-detail-header')?.textContent.includes('已取消'), {}, { timeout: 15000 })
    return { singleSidebarState: true, starts, detailsLoadedAtStart: detailReads, animationAdvanced: true, reducedMotion: true, narrowOverflow: false, collapsedBadge: true, controls: commands, cancelWhilePausing: true, latePauseSuppressed: true, unrelatedActionsEnabled: true, feedbackMs, snapshots, realDataWritten: false }
  } finally {
    releasePause()
    await page.unrouteAll({ behavior: 'wait' })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), originalDark)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.reload()
    await page.getByRole('button', { name: '训练图片工作台', exact: true }).click()
  }
}
