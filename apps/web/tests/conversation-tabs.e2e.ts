/** View navigation disclosure through the shipped Web composition and a recorded turn. */
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, selectedSessionFixture, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const FIXTURE_DIR = fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome', import.meta.url))
const EXPECTED_DIR = fileURLToPath(new URL('./expected/conversation-tabs', import.meta.url))
const MODE = webSnapshotMode()

describe('conversation view tabs disclosure', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      developerTools: true,
      replayFixture: join(FIXTURE_DIR, 'session.v3.jsonl'),
      replayOverride: join(FIXTURE_DIR, 'replay.override.json'),
      // 此用例借用模型回放，只验证导航；持久化输出由 lifecycle-chrome 用例覆盖。
      compareReplaySession: false,
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const fixture = await selectedSessionFixture(join(FIXTURE_DIR, 'session.v3.jsonl'))
    const [prompt] = fixtureUserPrompts(await readFile(fixture, 'utf8'))
    if (prompt === undefined) throw new Error('view tabs fixture has no user prompt')
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompt)
    await input.press('Enter')
    await settled
    if (MODE === 'refresh') await mkdir(EXPECTED_DIR, { recursive: true })
  })

  afterAll(async () => {
    try { await browser?.close() }
    finally { await scaffold?.close() }
  })

  it('reclaims header height while retaining the selected view and keyboard access to the toggle', async () => {
    const header = page.locator('[data-slot="conversation.header"] > header')
    const toggle = header.getByRole('button', { name: /^(Collapse|Expand) view tabs$/ })
    const tabs = header.getByRole('tablist')
    await toggle.waitFor()
    await header.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    const selected = header.locator('[role="tab"][aria-selected="true"]')
    const selectedName = await selected.innerText()
    const expandedHeight = await header.evaluate(element => element.getBoundingClientRect().height)
    const expanded = `${await toggle.ariaSnapshot()}\n${await tabs.ariaSnapshot()}`
    await compareOrRefreshGolden(join(EXPECTED_DIR, 'expanded.expected.md'), expanded, MODE)
    expect(await toggle.evaluate(element => element.nextElementSibling?.tagName)).toBe('NAV')
    const disclosureId = await toggle.getAttribute('aria-controls')
    if (disclosureId === null) throw new Error('view tabs toggle has no controlled disclosure')
    const disclosure = page.locator(`[id="${disclosureId}"]`)

    await toggle.click()
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await disclosure.getAttribute('inert')).toBe('')
    expect(await disclosure.getAttribute('aria-hidden')).toBe('true')
    await expect.poll(() => disclosure.evaluate(element => element.getBoundingClientRect().height)).toBe(0)
    const collapsedHeight = await header.evaluate(element => element.getBoundingClientRect().height)
    expect(expandedHeight - collapsedHeight).toBeGreaterThan(20)
    expect(await selected.getAttribute('aria-selected')).toBe('true')
    const collapsed = await toggle.ariaSnapshot()
    await compareOrRefreshGolden(join(EXPECTED_DIR, 'collapsed.expected.md'), collapsed, MODE)

    await toggle.focus()
    await toggle.press('Enter')
    await tabs.waitFor({ state: 'visible' })
    await expect.poll(() => header.evaluate(element => element.getBoundingClientRect().height)).toBe(expandedHeight)
    expect(await selected.innerText()).toBe(selectedName)
    expect(await disclosure.getAttribute('inert')).toBeNull()
    await toggle.press('Space')
    await toggle.press('Enter')
    await expect.poll(() => header.evaluate(element => element.getBoundingClientRect().height)).toBe(expandedHeight)

    await page.setViewportSize({ width: 640, height: 800 })
    const geometry = await toggle.boundingBox()
    expect(geometry).not.toBeNull()
    expect(geometry!.x).toBeGreaterThanOrEqual(0)
    expect(geometry!.x + geometry!.width).toBeLessThanOrEqual(640)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await disclosure.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    expect(await toggle.locator('span').first().evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    await toggle.click()
    await expect.poll(() => disclosure.evaluate(element => element.getBoundingClientRect().height)).toBe(0)
    await toggle.click()
    await tabs.waitFor({ state: 'visible' })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
