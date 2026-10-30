/** Keyless visual consistency checks for Models, MCP and built-in plugin loading placeholders. */
import { fileURLToPath } from 'node:url'
import type { Locator } from 'playwright'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/settings-skeleton-style/loading.expected.json', import.meta.url))

/**
 * Read the material and motion of a decorative placeholder, independently of its page geometry.
 * @param bar - One visible skeleton bar.
 * @returns Resolved base color, corners and sheen animation.
 */
function appearance(bar: Locator) {
  return bar.evaluate((element) => {
    const base = getComputedStyle(element)
    const sheen = getComputedStyle(element, '::after')
    return {
      fill: base.backgroundColor, radius: base.borderRadius, opacity: base.opacity,
      gradient: sheen.backgroundImage, duration: sheen.animationDuration,
      easing: sheen.animationTimingFunction, iterations: sheen.animationIterationCount,
    }
  })
}

it('matches the Models skeleton material and sheen while retaining each page layout', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  const tripwire = watchConsole(page)
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<undefined>>>()
  const pages = [
    { label: '模型', id: 'models', api: 'llm/listProviders', skeleton: '[data-models-skeleton]', bar: 'span' },
    { label: 'MCP 服务', id: 'mcp', api: 'mcpSettings/list', skeleton: '[data-mcp-skeleton="list"]', bar: 'span' },
    { label: '内置插件', id: 'plugins', api: 'pluginInventory/list', skeleton: '[role="status"]', bar: '[aria-hidden="true"] span' },
  ]
  for (const entry of pages) {
    const gate = Promise.withResolvers<undefined>()
    gates.set(entry.api, gate)
    await page.route(`**/api/${entry.api}`, async (route) => { await gate.promise; await route.continue() })
  }
  onTestFinished(() => { for (const gate of gates.values()) gate.resolve(undefined) })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await openSettings(page, 'zh')
  const shell = page.locator('[data-settings-page]')
  const references = new Map<string, Awaited<ReturnType<typeof appearance>>>()
  const facts: object[] = []
  for (const entry of pages) {
    await shell.getByRole('button', { name: entry.label, exact: true }).click()
    const section = page.locator(`[data-settings-section="${entry.id}"]`)
    const skeleton = section.locator(entry.skeleton)
    await skeleton.waitFor()
    const bar = skeleton.locator(entry.bar).first()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' })
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
      const style = await appearance(bar)
      expect(style.duration).toBe('1.8s')
      expect(style.easing).toBe('ease-in-out')
      expect(style.iterations).toBe('infinite')
      expect(style.opacity).toBe('1')
      if (entry.id === 'models') references.set(colorScheme, style)
      else expect(style).toEqual(references.get(colorScheme))
      facts.push({ page: entry.id, theme: colorScheme, matchesModels: true, duration: style.duration })
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await skeleton.getByRole('button').count()).toBe(0)
      facts.push({ page: entry.id, width, fits: true, placeholderControls: 0 })
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await skeleton.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0)
    facts.push({ page: entry.id, reducedMotion: 'static' })
    gates.get(entry.api)!.resolve(undefined)
    await skeleton.waitFor({ state: 'detached' })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  }
  await compareOrRefreshGolden(EXPECTED, JSON.stringify(facts, null, 2), webSnapshotMode())
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
