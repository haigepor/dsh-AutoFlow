/** Keyless real-Host coverage for archive settings, shared pin state and restoration. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, pinBrowserClock, pinHostClock } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/archive-settings/page.expected.md', import.meta.url))

it('finds, pins, archives and restores sessions through the native settings page', async () => {
  const hostClock = pinHostClock()
  onTestFinished(() => { hostClock.mockRestore() })
  const scaffold = await launchWebScaffold({
    profile: { packages: [] },
    extraOverlayPath: [
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      fileURLToPath(new URL('./archive-settings.overlay.yml', import.meta.url)),
    ],
  })
  onTestFinished(() => scaffold.close())
  const text = await readFile(SEED, 'utf8')
  const seedOptions = { createdAt: Date.UTC(2026, 0, 15, 12) }
  const alpha = await seedSession(scaffold, text, 'archive-settings-alpha', undefined, seedOptions)
  const beta = await seedSession(scaffold, text, 'archive-settings-beta', undefined, seedOptions)
  const gamma = await seedSession(scaffold, text, 'archive-settings-gamma', undefined, seedOptions)
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'Archive project')
  await workspace.attachSession(alpha)
  await workspace.attachSession(gamma)
  for (const [sessionId, title] of [[alpha, 'Alpha archived'], [beta, 'Beta archived'], [gamma, 'Gamma active']] as const) {
    await scaffold.ctx.sessionController.rename({ sessionId, title })
  }
  await scaffold.ctx.workspaceRegistry.archiveSession(alpha)
  await scaffold.ctx.workspaceRegistry.archiveSession(beta)
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await pinBrowserClock(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.locator('[data-dsh-boot]').waitFor({ state: 'detached' })
  const current = page.locator(`[data-row-key="session:${gamma}"]`)
  await current.click()
  await expect.poll(() => current.getAttribute('aria-selected')).toBe('true')
  const creation = Promise.withResolvers<undefined>()
  const attached = Promise.withResolvers<undefined>()
  let hostCreateMs = 0
  const createStarted = performance.now()
  const attach = workspace.attachSession.bind(workspace)
  const attachment = vi.spyOn(workspace, 'attachSession').mockImplementationOnce(async (sessionId) => {
    hostCreateMs = performance.now() - createStarted
    attached.resolve(undefined)
    await creation.promise
    await attach(sessionId)
  })
  await page.locator(`[data-row-key="workspace:${workspace.id}"]`).hover()
  const newSession = page.locator('button[aria-label="New session in Archive project"]')
  await newSession.click()
  try {
    await page.locator('[data-workspace-opening]').waitFor()
    const feedbackMs = performance.now() - createStarted
    await attached.promise
    console.info('archive-actions latency (isolated Host, ms):', { feedback: Math.round(feedbackMs), createBeforeAttachment: Math.round(hostCreateMs) })
    expect(await newSession.getAttribute('aria-busy')).toBe('true')
    expect(await newSession.isDisabled()).toBe(true)
    // A later user navigation wins while the Host completes the admitted creation.
    await current.click()
  } finally {
    creation.resolve(undefined)
    attachment.mockRestore()
  }
  await expect.poll(() => newSession.isDisabled()).toBe(false)
  await expect.poll(() => page.locator('[data-workspace-opening]').count()).toBe(0)
  expect(await current.getAttribute('aria-selected')).toBe('true')
  const shell = page.locator('[data-settings-page]')
  const panel = page.locator('[data-archive-settings]')
  const openSettings = async (): Promise<void> => {
    await page.locator('[data-dsh-boot]').waitFor({ state: 'detached' })
    if (await shell.count() === 0) {
      const launcher = page.getByRole('button', { name: 'Settings', exact: true })
      await launcher.waitFor()
      if (await shell.count() === 0) await launcher.click()
    }
    await shell.getByRole('button', { name: 'Archived sessions', exact: true }).click()
    await panel.getByRole('heading', { name: 'Archived sessions', exact: true }).waitFor()
  }
  await openSettings()
  await expect.poll(() => panel.locator('[data-archive-row]').count()).toBe(2)
  await expect.poll(() => panel.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
  expect(await shell.getByRole('button', { name: 'Open configuration file', exact: true }).count()).toBe(0)
  await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[data-archive-settings]', scaffold.workspaceCwd), webSnapshotMode())

  const screenshotDirectory = process.env.DSH_ARCHIVE_SCREENSHOT_DIR
  const capture = async (name: string): Promise<void> => {
    if (screenshotDirectory === undefined) return
    await mkdir(screenshotDirectory, { recursive: true })
    await page.screenshot({ path: join(screenshotDirectory, `${name}.png`), animations: 'disabled' })
  }
  await capture('archive-light')
  const groupToggle = panel.getByRole('button', { name: 'Expand or collapse Archive project', exact: true })
  const collapse = page.locator(`[id="${await groupToggle.getAttribute('aria-controls')}"]`)
  expect(await collapse.evaluate(element => getComputedStyle(element).transitionDuration)).toContain('0.3s')
  await groupToggle.click()
  await expect.poll(() => collapse.boundingBox().then(box => box?.height ?? 0)).toBe(0)
  expect(await collapse.getAttribute('aria-hidden')).toBe('true')
  await groupToggle.click()
  await panel.getByRole('button', { name: 'Delete Alpha archived', exact: true }).waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await collapse.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await panel.getByRole('checkbox', { name: 'Select Alpha archived', exact: true }).check()
  await panel.getByRole('searchbox', { name: 'Search session titles' }).fill('Beta')
  await expect.poll(() => panel.locator('[data-archive-row]').count()).toBe(1)
  expect(await panel.getByRole('button', { name: 'Restore selected', exact: true }).isEnabled()).toBe(false)
  await panel.getByRole('searchbox').fill('')

  await panel.getByRole('button', { name: 'Favorite Beta archived', exact: true }).click()
  await panel.getByRole('button', { name: 'Unfavorite Beta archived', exact: true }).waitFor()
  const favoriteReloadStart = tripwire.warnings.length
  await page.reload({ waitUntil: 'load' })
  await openSettings()
  acknowledgeReloadConnectionLoss(tripwire, favoriteReloadStart)
  await panel.getByRole('button', { name: 'Favorites only', exact: true }).click()
  await expect.poll(() => panel.locator('[data-archive-row]').count()).toBe(1)
  expect(await panel.locator('[data-archive-row]').getAttribute('data-archive-row')).toBe(beta)
  await panel.getByRole('button', { name: 'Unfavorite Beta archived', exact: true }).click()
  await panel.getByRole('heading', { name: 'No sessions match your filters', exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await panel.getByRole('button', { name: 'Favorite Beta archived', exact: true }).click()

  await panel.getByRole('button', { name: 'Workspace: All Workspaces', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Archive project', exact: true }).click()
  await expect.poll(() => panel.locator('[data-archive-row]').count()).toBe(1)
  expect(await panel.locator('[data-archive-row]').getAttribute('data-archive-row')).toBe(alpha)
  await panel.getByRole('button', { name: 'Workspace: Archive project', exact: true }).click()
  await page.getByRole('menuitem', { name: 'All Workspaces', exact: true }).click()

  await panel.getByRole('button', { name: 'Last updated: All time', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Custom dates', exact: true }).click()
  const dateDialog = page.getByRole('dialog', { name: 'Custom dates', exact: true })
  await dateDialog.getByLabel('Start date', { exact: true }).fill('2099-01-01')
  await dateDialog.getByLabel('End date', { exact: true }).fill('2000-01-01')
  expect(await dateDialog.getByRole('button', { name: 'Apply', exact: true }).isEnabled()).toBe(false)
  await dateDialog.getByLabel('End date', { exact: true }).fill('2099-12-31')
  await dateDialog.getByRole('button', { name: 'Apply', exact: true }).click()
  await panel.getByRole('heading', { name: 'No sessions match your filters', exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click()

  await panel.getByRole('checkbox', { name: 'Select current results', exact: true }).check()
  await panel.getByRole('button', { name: 'Restore selected', exact: true }).click()
  await expect.poll(() => [...scaffold.ctx.workspaceRegistry.archivedSessionIds]).toEqual([])
  await panel.getByRole('heading', { name: 'No archived sessions yet', exact: true }).waitFor()
  await panel.getByRole('tab', { name: /^Unarchived/ }).click()
  await expect.poll(() => panel.locator('[data-archive-row]').count()).toBe(3)
  await panel.getByRole('checkbox', { name: 'Select Alpha archived', exact: true }).check()
  await panel.getByRole('checkbox', { name: 'Select Beta archived', exact: true }).check()
  await panel.getByRole('button', { name: 'Archive selected', exact: true }).click()
  await expect.poll(() => [...scaffold.ctx.workspaceRegistry.archivedSessionIds].sort()).toEqual([alpha, beta])
  await panel.getByRole('tab', { name: /^Archived/ }).click()

  await shell.getByRole('button', { name: 'Appearance theme', exact: true }).click()
  await shell.getByRole('button', { name: 'Dark', exact: true }).click()
  await shell.getByRole('button', { name: 'Archived sessions', exact: true }).click()
  await panel.getByRole('heading', { name: 'Archived sessions', exact: true }).waitFor()
  await panel.getByRole('checkbox', { name: 'Select current results', exact: true }).check()
  await capture('archive-dark')
  await page.setViewportSize({ width: 390, height: 844 })
  const width = await panel.evaluate(element => ({ content: element.scrollWidth, available: element.clientWidth }))
  expect(width.content).toBeLessThanOrEqual(width.available + 1)
  await panel.getByRole('button', { name: 'Workspace: All Workspaces', exact: true }).click()
  const menu = page.getByRole('menu')
  const box = await menu.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(391)
  await menu.press('Escape')
  await capture('archive-mobile-dark')
  await panel.getByRole('button', { name: 'Clear selection', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await panel.locator(`[data-archive-row="${alpha}"]`).getByRole('button', { name: 'Restore and open', exact: true }).click()
  await expect.poll(() => scaffold.ctx.workspaceRegistry.archivedSessionIds.includes(alpha)).toBe(false)
  await expect.poll(() => page.locator('[data-settings-page]').count()).toBe(0)
  await expect.poll(() => page.locator(`[data-row-key="session:${alpha}"]`).getAttribute('aria-selected')).toBe('true')
  const warningStart = tripwire.warnings.length
  await page.reload({ waitUntil: 'load' })
  await openSettings()
  acknowledgeReloadConnectionLoss(tripwire, warningStart)
  await expect.poll(() => panel.locator('[data-archive-row]').count()).toBe(1)
  expect(await panel.locator('[data-archive-row]').getAttribute('data-archive-row')).toBe(beta)
  expect(await panel.getByRole('button', { name: 'Unfavorite Beta archived', exact: true }).getAttribute('aria-pressed')).toBe('true')
  const deleteDialog = page.getByRole('dialog', { name: 'Permanently delete sessions', exact: true })
  await panel.getByRole('button', { name: 'Delete Beta archived', exact: true }).click()
  await deleteDialog.waitFor()
  expect(await scaffold.ctx.sessionPersistence.stat(beta)).toBeDefined()
  await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await deleteDialog.waitFor({ state: 'detached' })
  await panel.getByRole('button', { name: 'Delete Beta archived', exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Delete Beta archived', exact: true }).click()
  const cleanup = Promise.withResolvers<undefined>()
  const cleanupEntered = Promise.withResolvers<undefined>()
  const remove = scaffold.ctx.sessionProjectionCache.remove.bind(scaffold.ctx.sessionProjectionCache)
  const removal = vi.spyOn(scaffold.ctx.sessionProjectionCache, 'remove').mockImplementationOnce(async (...args) => {
    cleanupEntered.resolve(undefined)
    await cleanup.promise
    await remove(...args)
  })
  await deleteDialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()
  try {
    await cleanupEntered.promise
    expect(await deleteDialog.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
    expect(await deleteDialog.getByRole('status').textContent()).toContain('0/1')
    await expect.poll(() => scaffold.ctx.sessionPersistence.stat(beta)).toBeUndefined()
    await expect.poll(() => panel.locator(`[data-archive-row="${beta}"]`).count()).toBe(0)
  } finally {
    cleanup.resolve(undefined)
    removal.mockRestore()
  }
  await deleteDialog.waitFor({ state: 'detached' })
  await expect.poll(() => scaffold.ctx.sessionPersistence.stat(beta)).toBeUndefined()
  await panel.getByRole('heading', { name: 'No archived sessions yet', exact: true }).waitFor()
  expect(await scaffold.ctx.sessionPersistence.stat(alpha)).toBeDefined()
  const deletionReload = tripwire.warnings.length
  await page.reload({ waitUntil: 'load' })
  await openSettings()
  acknowledgeReloadConnectionLoss(tripwire, deletionReload)
  await panel.getByRole('heading', { name: 'No archived sessions yet', exact: true }).waitFor()
  expect(scaffold.ctx.settings.describe().find(row => row.ns === 'ui-settings-archive')?.value)
    .toMatchObject({ favoriteSessionIds: [] })
  await panel.getByRole('tab', { name: /^Unarchived/ }).click()
  await expect.poll(() => panel.locator('[data-archive-row]').count()).toBe(2)
  await panel.getByRole('checkbox', { name: 'Select current results', exact: true }).check()
  await panel.getByRole('button', { name: 'Archive selected', exact: true }).click()
  await expect.poll(() => [...scaffold.ctx.workspaceRegistry.archivedSessionIds].sort()).toEqual([alpha, gamma])
  expect(await shell.count()).toBe(1)
  const batchIds = []
  for (let index = 0; index < 36; index++) {
    const sessionId = await seedSession(scaffold, text, `archive-settings-batch-${index}`, undefined, seedOptions)
    await scaffold.ctx.sessionController.rename({ sessionId, title: `Batch archived ${index}` })
    await scaffold.ctx.workspaceRegistry.archiveSession(sessionId)
    batchIds.push(sessionId)
  }
  await panel.getByRole('button', { name: 'Refresh list', exact: true }).click()
  await panel.getByRole('tab', { name: /^Archived/ }).click()
  await expect.poll(() => panel.locator('[data-archive-row]').count()).toBe(38)
  await panel.getByRole('checkbox', { name: 'Select current results', exact: true }).check()
  await panel.getByRole('button', { name: 'Delete selected', exact: true }).click()
  await deleteDialog.waitFor()
  expect(await deleteDialog.textContent()).toContain('38 selected sessions')
  const batchRelease = Promise.withResolvers<undefined>()
  const batchEntered = Promise.withResolvers<undefined>()
  let deletionCount = 0
  const batchCleanup = vi.spyOn(scaffold.ctx.sessionProjectionCache, 'remove').mockImplementation(async (...args) => {
    if (++deletionCount === 2) {
      batchEntered.resolve(undefined)
      await batchRelease.promise
    }
    await remove(...args)
  })
  const batchStarted = performance.now()
  await deleteDialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()
  try {
    await batchEntered.promise
    expect(await deleteDialog.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1')
    expect(await deleteDialog.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('38')
    expect(await deleteDialog.getByRole('status').textContent()).toContain('1/38')
  } finally {
    batchRelease.resolve(undefined)
    batchCleanup.mockRestore()
  }
  await deleteDialog.waitFor({ state: 'detached' })
  console.info('archive-actions deletion (isolated Host):', { records: 38, milliseconds: Math.round(performance.now() - batchStarted) })
  const deletedIds = [alpha, beta, gamma, ...batchIds]
  await expect.poll(async () => (await scaffold.ctx.sessionPersistence.list())
    .filter(row => deletedIds.includes(row.header.id))).toEqual([])
  await expect.poll(async () => (await scaffold.ctx.sessionQuery.listSessions())
    .filter(row => deletedIds.includes(row.header.id))).toEqual([])
  await panel.getByRole('heading', { name: 'No archived sessions yet', exact: true }).waitFor()
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
}, 180_000)
