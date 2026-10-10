/** Settings presentation over recorded history with only the native preload transport substituted. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { initialShortcutConfig } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'

const seed = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))

it.each(['web', 'windows', 'macos'] as const)('keeps the direct Settings entry and caption spacing on %s', async (platform) => {
  const scaffold = await launchWebScaffold({ developerTools: false })
  try {
    await scaffold.ctx.settings.mutate('ui-settings-account', [
      { op: 'set', path: ['step'], value: 'done' },
      { op: 'set', path: ['completion'], value: 'completed' },
    ])
    await seedSession(scaffold, await readFile(seed, 'utf8'), SessionId(`settings-${platform}`))
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
      if (platform !== 'web') {
        await page.addInitScript(({ device, shortcuts }) => {
          Object.assign(window, { dshDesktop: { protocolVersion: 1,
            shortcuts: { get: async () => shortcuts, edit: async () => { throw new Error('fixture does not edit shortcuts') },
              recording: async () => {}, subscribe: () => () => {} },
            keyboard: { subscribe: () => () => {}, closeWindow: async () => {} },
          } })
          const mark = () => {
            document.documentElement.dataset.platform = device === 'windows' ? 'win32' : 'darwin'
            if (device === 'windows') {
              document.documentElement.dataset.windowsTitlebar = ''
              document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '32px')
            }
          }
          if (document.documentElement === null) window.addEventListener('DOMContentLoaded', mark)
          else mark()
        }, { device: platform, shortcuts: initialShortcutConfig() })
      }
      const console = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const settings = page.getByRole('button', { name: 'Settings', exact: true })
      try { await settings.click() }
      catch (error) {
        process.stderr.write(JSON.stringify({ platform, body: (await page.locator('body').innerText()).slice(0,1800), errors: console.pageErrors }) + '\n')
        throw error
      }
      const panel = page.locator('[data-settings-page]')
      await panel.waitFor()
      const nav = panel.locator('nav')
      const expectedPadding = platform === 'macos' ? '54px' : '6px'
      expect(await nav.evaluate(node => getComputedStyle(node).paddingTop)).toBe(expectedPadding)
      expect(await page.locator('body').getAttribute('data-ds-palette')).toBe('official')
      expect(await page.getByRole('menu').count()).toBe(0)
      const labels = await nav.locator('[data-settings-nav-row]').allTextContents()
      expect(labels.some(label => label === 'Account')).toBe(platform !== 'web')
      await compareOrRefreshGolden(fileURLToPath(new URL(`./expected/desktop-settings/${platform}.txt`, import.meta.url)),
        `Settings\nPalette: official\nNavigation top: ${expectedPadding}\nAccount reachable: ${platform !== 'web'}`, webSnapshotMode())
      await nav.getByRole('button', { name: 'Collapse settings sidebar' }).click()
      await expect.poll(() => nav.evaluate(node => getComputedStyle(node).paddingTop))
        .toBe(platform === 'macos' ? '66px' : '18px')
      await page.setViewportSize({ width: 760, height: 900 })
      await expect.poll(() => nav.evaluate(node => getComputedStyle(node).paddingTop))
        .toBe(platform === 'macos' ? '60px' : '12px')
      expect(console.pageErrors).toEqual([])
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
