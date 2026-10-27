/** Default-loaded entry controls activate through the real Web profile and Loader. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession,
  watchConsole, webSnapshotMode, type WebScaffold, type WebConsoleTripwire,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/entry-customization', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))

describe('default navigation entry customization', () => {
  let scaffold: WebScaffold
  let browser: Browser | undefined
  let page: Page
  let tripwire: WebConsoleTripwire

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    })
    const sessionId = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'entry-customization-web-e2e')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.addInitScript((id) => {
      if (localStorage.getItem('dsh.sessions.current') === null) {
        localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
      }
    }, sessionId)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 30_000 })
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('keeps navigation outside More and offers only browsing and creation after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'entry-customization'))
    const nav = page.getByRole('navigation', { name: 'Global panels' })
    const tasks = nav.getByRole('button', { name: 'Automation tasks', exact: true })
    const more = nav.getByRole('button', { name: 'More', exact: true })
    await tasks.waitFor()
    await tasks.click()
    await page.getByRole('heading', { name: 'Automation tasks', exact: true }).waitFor()
    for (const reload of [false, true]) {
      if (reload) {
        await page.reload({ waitUntil: 'load' })
        await tasks.click()
        await page.getByRole('heading', { name: 'Automation tasks', exact: true }).waitFor()
      }
      await tasks.waitFor()
      const captureNav = () => captureStableAria(page, 'nav[aria-label="Global panels"]', scaffold.workspaceCwd)
      const collapsed = reload ? '' : await captureNav()
      await more.click()
      const menu = nav.getByRole('menu', { name: 'More' })
      await menu.getByRole('menuitem', { name: 'Browse other plugins', exact: true }).waitFor()
      expect(await menu.getAttribute('id')).toBe(await more.getAttribute('aria-controls'))
      expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['Browse other plugins', 'Create your plugin'])
      expect(await menu.getByRole('separator').count()).toBe(0)
      expect(await tasks.getAttribute('aria-current')).toBe('page')
      if (!reload) {
        const expanded = await captureNav()
        await tasks.click()
        expect(await more.getAttribute('aria-expanded')).toBe('true')
        await more.click()
        await menu.waitFor({ state: 'hidden' })
        const recollapsed = await captureNav()
        await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'more.expected.md'),
          `Collapsed\n${collapsed}\nExpanded\n${expanded}\nCollapsed again\n${recollapsed}`, webSnapshotMode())
        await more.click()
      }
      await menu.getByRole('menuitem', { name: 'Browse other plugins', exact: true }).click()
      await menu.waitFor({ state: 'hidden' })
      expect(await nav.getByRole('button', { name: 'Plugins', exact: true }).getAttribute('aria-current')).toBe('page')
      await tasks.click()
      await page.getByRole('heading', { name: 'Automation tasks', exact: true }).waitFor()
    }
    await more.click()
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expect.poll(() => more.getAttribute('aria-expanded')).toBe('false')
    expect(await page.getByRole('menu').count()).toBe(0)
    await more.click()
    const railMenu = page.getByRole('menu')
    await railMenu.getByRole('menuitem', { name: 'Browse other plugins', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await railMenu.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await assertFixtureInventory(SNAPSHOT_DIR, ['more.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
