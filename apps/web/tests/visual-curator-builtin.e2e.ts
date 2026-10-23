/** Visual Curator uses the native plugin detail page beside AFP. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { PLUGIN_TOGGLE_SETTLE_MS, ZH_BROWSER_LOCALE } from './support.ts'

type BundleManifest = { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }

it('shows native Visual Curator details and artwork without mounting the removed workbench', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [], bundles: ['dsh-plugin-afp'] } })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 960 } })
  const tripwire = watchConsole(page), settle = { timeout: PLUGIN_TOGGLE_SETTLE_MS }
  const manifest = async (): Promise<BundleManifest> =>
    JSON.parse(await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'package.json'), 'utf8')) as BundleManifest
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: '插件', exact: true }).click()
  const card = page.locator('[data-plugin-package="dsh-plugin-visual-curator"]')
  await card.waitFor()
  const toggle = card.getByRole('switch')
  await expect.poll(() => toggle.getAttribute('aria-checked'), settle).toBe('false')
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-checked'), settle).toBe('true')
  await card.getByRole('button', { name: /视觉策展/ }).click()
  await page.getByRole('heading', { name: '视觉策展', exact: true }).waitFor()
  const detail = page.locator('[data-plugin-detail="dsh-plugin-visual-curator"]')
  await expect.poll(() => detail.locator('img').first().evaluate(image => (image as HTMLImageElement).naturalWidth), settle).toBe(512)
  expect(await detail.locator('[data-feature-group="skill"]').getByRole('switch').count()).toBe(6)
  expect(await detail.locator('[data-feature-group="script"]').getByRole('switch').count()).toBe(3)
  const pages = detail.locator('[data-feature-group="ui"]').getByRole('switch')
  expect(await pages.count()).toBe(3)
  expect(await pages.evaluateAll(elements => elements.every(element => element.getAttribute('aria-checked') === 'false'))).toBe(true)
  expect(await page.locator('.vc-root, [data-plugin-config]').count()).toBe(0)
  expect(await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '视觉策展', exact: true }).count()).toBe(0)
  expect(await page.getByRole('tab', { name: '找图与裁图', exact: true }).count()).toBe(0)
  expect(await page.locator('style[data-visual-curator]').count()).toBe(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => detail.evaluate(element => element.scrollWidth <= element.clientWidth), settle).toBe(true)
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('button', { name: '插件', exact: true }).click()
  await card.waitFor()
  await card.getByRole('switch').click()
  await expect.poll(() => card.getByRole('switch').getAttribute('aria-checked'), settle).toBe('false')
  await page.reload()
  await page.getByRole('button', { name: '插件', exact: true }).click()
  await card.waitFor()
  expect(await card.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  await card.getByRole('switch').click()
  await expect.poll(() => card.getByRole('switch').getAttribute('aria-checked'), settle).toBe('true')
  const saved = await manifest()
  expect(saved.dependencies).not.toHaveProperty('dsh-plugin-visual-curator')
  expect(saved.dsh.profile.bundles).toContain('dsh-plugin-visual-curator')
  expect(saved.dsh.profile.bundles).toContain('dsh-plugin-afp')
  await page.getByRole('button', { name: 'AFP 图片策展', exact: true }).click()
  await page.getByRole('heading', { name: 'AFP 工作台', exact: true }).waitFor()
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
