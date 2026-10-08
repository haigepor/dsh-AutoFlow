/** AFP's installed client and Host composition without a profile-local package. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('opens and configures builtin AFP without installing a profile copy', async () => {
  const scaffold = await launchWebScaffold({
    profile: { packages: [], bundles: ['dsh-plugin-afp'] },
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 960 } })
  const tripwire = watchConsole(page)
  const profileDir = join(scaffold.harnessHome, 'profiles', 'scaffold')
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  expect(manifest.dependencies).not.toHaveProperty('dsh-plugin-afp')
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'AFP 图片策展', exact: true }).click()
  await page.getByRole('heading', { name: 'AFP 工作台' }).waitFor()
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/afp-builtin/workbench.expected.md', import.meta.url)),
    await captureStableAria(page, 'main', scaffold.workspaceCwd), webSnapshotMode())
  await page.getByRole('button', { name: '插件', exact: true }).click()
  const card = page.locator('[data-plugin-package="dsh-plugin-afp"]')
  await card.waitFor()
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/afp-builtin/card.expected.md', import.meta.url)),
    await captureStableAria(page, '[data-plugin-package="dsh-plugin-afp"]', scaffold.workspaceCwd), webSnapshotMode())
  const toggle = card.getByRole('switch')
  await toggle.click()
  await expect.poll(() => page.getByRole('button', { name: 'AFP 图片策展', exact: true }).count()).toBe(0)
  const disabled = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
  expect(disabled.dsh.profile.bundles).not.toContain('dsh-plugin-afp')
  await page.reload()
  await page.locator('[class*="frame"]').first().waitFor()
  expect(await page.getByRole('button', { name: 'AFP 图片策展', exact: true }).count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
