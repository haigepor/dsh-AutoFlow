/** Keyless plugin update controls over the real Host Remote and Web composition. */
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import type { BundleInfo, BundleUpdateInfo } from '@deepseek-ai/dsh-plugin-manager'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'

it('checks remote plugin updates, requires explicit automatic permission and reports restart after installation', async () => {
  const scaffold = await launchWebScaffold({ extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)) })
  const browser = await chromium.launch()
  const name = 'dsh-update-fixture'
  let update: BundleUpdateInfo = { name, repository: 'example/plugins', automatic: false, status: 'unchecked', restartRequired: false }
  const fixture = (): BundleInfo => ({ name, version: '1.0.0', installed: true, removable: false, optional: false,
    enabled: true, rows: [], overrides: [], update })
  const original = scaffold.ctx.pluginManager.listBundles.bind(scaffold.ctx.pluginManager)
  const listing = vi.spyOn(scaffold.ctx.pluginManager, 'listBundles').mockImplementation(async () => [...await original(), fixture()])
  const check = vi.spyOn(scaffold.ctx.pluginManager, 'checkBundleUpdates').mockImplementation(async () => {
    update = { ...update, status: 'available', version: '1.1.0' }
    return [update]
  })
  const automatic = vi.spyOn(scaffold.ctx.pluginManager, 'setBundleAutoUpdate').mockImplementation(async (_name, enabled) => {
    update = { ...update, automatic: enabled }
  })
  const install = vi.spyOn(scaffold.ctx.pluginManager, 'updateBundle').mockImplementation(async () => {
    update = { ...update, restartRequired: true, status: 'current' }
    return { target: name, stage: 'install', changed: true, application: 'restart-required' }
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    const console = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
    await page.locator(`[data-plugin-package="${name}"]`).getByRole('button', { name: `查看 ${name}` }).click()
    const section = page.locator('[data-plugin-updates]')
    await section.getByText('发现新版本 v1.1.0').waitFor()
    await section.locator('summary').click()
    expect(install).not.toHaveBeenCalled()
    expect(await section.getByRole('switch', { name: '自动下载安装' }).getAttribute('aria-checked')).toBe('false')
    await section.getByRole('switch', { name: '自动下载安装' }).click()
    await expect.poll(() => automatic.mock.calls).toEqual([[name, true]])
    await section.getByRole('button', { name: '检查更新' }).click()
    await expect.poll(() => check.mock.calls.length).toBeGreaterThan(1)
    const before = await captureStableAria(page, '[data-plugin-updates]', scaffold.workspaceCwd)
    await section.getByRole('button', { name: '立即更新' }).click()
    await section.getByText('新版本已安装，重启后生效').waitFor()
    const restartDialog = page.getByRole('dialog', { name: '插件已更新，需要重启' })
    await restartDialog.waitFor()
    await restartDialog.getByRole('button', { name: '稍后重启' }).click()
    expect(install).toHaveBeenCalledTimes(1)
    expect(await section.getByRole('button', { name: '立即更新' }).count()).toBe(0)
    const after = await captureStableAria(page, '[data-plugin-updates]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(fileURLToPath(new URL('./expected/plugin-updates/', import.meta.url)), 'updates.expected.md'),
      `# Available\n\n${before}\n\n# Restart required\n\n${after}`.trimEnd(), webSnapshotMode())
    const artifacts = join(scaffold.harnessHome, 'screenshots')
    await mkdir(artifacts, { recursive: true })
    await page.screenshot({ path: join(artifacts, 'plugin-updates.png') })
    await writeFile(join(artifacts, 'updates-status.txt'), after, 'utf8')
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  } finally {
    listing.mockRestore(); check.mockRestore(); automatic.mockRestore(); install.mockRestore()
    await browser.close()
    await scaffold.close()
  }
})
