/** Keyless recorded-session coverage for the two AutoFlow Better Sidebar bundles. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const SIDEBAR = fileURLToPath(new URL('../../../custom-plugins/workspace/dsh-better-sidebar/', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/better-sidebar-upgrade/jsonl.expected.md', import.meta.url))
const TITLE = 'Better Sidebar upgrade fixture'

describe('web e2e: Better Sidebar v0.28.2 with its AutoFlow companion', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let console: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./better-sidebar-upgrade.overlay.yml', import.meta.url)),
      profile: { packages: [{ dir: SIDEBAR, enabled: true }, { dir: join(SIDEBAR, 'updater'), enabled: true }] },
    })
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'better-sidebar-upgrade-fixture')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: TITLE })
    await writeFile(join(scaffold.workspaceCwd, 'events.jsonl'), '{"status":"ready","count":1}\n{"status":"done","count":2}\n', 'utf8')
    await writeFile(join(scaffold.workspaceCwd, 'large.log'), 'sidebar paged preview\n'.repeat(260_000), 'utf8')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    console = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const row = page.getByRole('treeitem').filter({ has: page.getByText(TITLE, { exact: true }) })
    await row.waitFor({ timeout: 30_000 })
    await row.click()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('loads every lazy artifact over the authenticated Host and previews recorded JSONL files', async () => {
    for (const name of ['editor', 'locale', 'mermaid', 'terminal']) {
      const response = await page.request.head(new URL(`/sidebar/bundle/${name}.js`, scaffold.authenticatedUrl).href)
      expect(response.status(), name).toBe(200)
      expect(Number(response.headers()['content-length']), name).toBeGreaterThan(0)
    }
    const expand = page.getByRole('button', { name: 'Open right sidebar', exact: true })
    if (await expand.count() > 0) await expand.click()
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await page.getByRole('button', { name: 'events.jsonl', exact: true }).dblclick()
    const record = page.getByRole('button', { name: '{status: "ready", count: 1}', exact: true })
    await record.waitFor({ timeout: 15_000 })
    await record.click()
    await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, 'ol[class*="largeFileList"]', scaffold.workspaceCwd), webSnapshotMode())
    expect(console.pageErrors).toEqual([])
  })

  it('pages a file above 5 MiB without an editable document and keeps local Git selectors', async () => {
    const path = page.getByPlaceholder('File path (relative to the session directory or absolute), Enter to open')
    await path.fill('large.log')
    await path.press('Enter')
    await page.getByRole('link', { name: /download/iu }).waitFor()
    await page.getByText(/File is too large/iu).waitFor()
    expect(await page.locator('.cm-editor:visible').count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Edit', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'New tab', exact: true }).click()
    await page.getByRole('button', { name: 'Git', exact: true }).click()
    const git = page.locator('[data-dsh-changes-header]').getByRole('tab', { name: 'Git', exact: true })
    await git.waitFor()
    expect(await git.getAttribute('id')).toMatch(/^changes-lens-/u)
    const controls = await git.getAttribute('aria-controls')
    expect(await page.locator('[role="tabpanel"]').evaluateAll((panels, id) => panels.some(panel => panel.id === id), controls)).toBe(true)
    expect(await page.locator('[data-dsh-changes-header]').evaluate(element => getComputedStyle(element).height)).toBe('40px')
    expect(console.pageErrors).toEqual([])
  })

  it('persists four independent task preferences through companion CSS saves and a reload', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Side card', exact: true }).click()
    await page.getByRole('button', { name: 'Tasks Settings', exact: true }).click()
    for (const name of ['Auto-fold settled leaf tasks', 'Auto-fold idle teammates']) {
      const [response] = await Promise.all([
        page.waitForResponse(response => response.url().includes('/sidebar/api/settings.update')),
        page.getByRole('dialog').getByRole('switch', { name, exact: true }).click(),
      ])
      expect(await response.text()).toContain('"ok":true')
    }
    await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click()
    await page.locator('.bs-settings-advanced summary').click()
    await page.locator('.bs-settings-css-body .cm-content[contenteditable=true]').click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.insertText('\n/* browser preference regression */\n')
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/sidebar/api/settings.update') && response.status() === 200),
      page.locator('.bs-settings-css-actions button').last().click(),
    ])
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Side card', exact: true }).click()
    await page.getByRole('button', { name: 'Tasks Settings', exact: true }).click()
    for (const [name, checked] of [
      ['Auto-fold settled leaf tasks', 'false'], ['Auto-fold fully finished branches only', 'true'],
      ['Auto-fold idle teammates', 'false'], ['Auto-collapse the background jobs drawer', 'true'],
    ]) {
      expect(await page.getByRole('dialog').getByRole('switch', { name: name!, exact: true }).getAttribute('aria-checked')).toBe(checked)
    }
    expect(console.pageErrors).toEqual([])
  })
})
