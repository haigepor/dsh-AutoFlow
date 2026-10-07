/** Keyless browser coverage for compact inventory navigation and retained disclosures. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/plugin-inventory-polish', import.meta.url))
const mode = webSnapshotMode()

describe('web e2e: compact plugin inventory', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  beforeAll(async () => {
    scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)) })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(page, 'zh')
    await page.locator('[data-settings-page]').getByRole('button', { name: '内置插件', exact: true }).click()
    await page.getByRole('searchbox', { name: '搜索插件' }).waitFor()
  }, 120_000)
  afterAll(async () => { await browser?.close(); await scaffold?.close() })

  it('starts both groups folded with compact tabs and search', async () => {
    const settings = page.locator('[data-settings-page]')
    for (const name of ['会话插件', '全局插件']) {
      expect(await settings.getByRole('button', { name, exact: true }).getAttribute('aria-expanded')).toBe('false')
    }
    expect(await settings.locator('[data-plugin-module]').count()).toBe(0)
    expect(await settings.getByRole('searchbox', { name: '搜索插件' }).evaluate(el => el.getBoundingClientRect().height)).toBe(36)
    // 单个标签贡献直接显示页面；真实 3080 同时含市场贡献时检查双标签布局。
    expect(await settings.getByRole('tablist').count()).toBe(0)
    await compareOrRefreshGolden(join(EXPECTED, 'folded.expected.md'), await captureStableAria(page, '[data-settings-page]', scaffold.workspaceCwd), mode)
  })

  it('animates group reversal and retains details while isolating collapsed focus', async () => {
    const group = page.locator('[data-plugin-scope="preset"]')
    const toggle = group.getByRole('button', { name: '会话插件', exact: true })
    await toggle.click()
    const heights = await group.locator('[data-plugin-module] > button').evaluateAll(es => es.map(el => el.getBoundingClientRect().height))
    expect(heights.length).toBeGreaterThan(10)
    expect(new Set(heights)).toEqual(new Set([64]))
    expect(await group.locator('[data-plugin-module] > button code').count()).toBe(0)
    const card = group.locator('[data-plugin-module="@deepseek-ai/dsh-tool-fs"]')
    const geometry = await card.getByRole('button').evaluate((el) => {
      const outer = el.getBoundingClientRect()
      const children = [...el.children].map(child => child.getBoundingClientRect())
      return { height: outer.height, centers: children.map(box => box.top + box.height / 2 - outer.top - outer.height / 2) }
    })
    expect(geometry.height).toBe(64)
    geometry.centers.forEach((offset) => { expect(Math.abs(offset)).toBeLessThan(1) })
    await card.getByRole('button').click()
    const details = card.locator('[id^="plugin-details-"]')
    expect(await details.evaluate(el => getComputedStyle(el).transitionDuration)).toContain('0.25s')
    const cardIdentity = await card.getAttribute('data-plugin-entry')
    await toggle.click()
    const id = await toggle.getAttribute('aria-controls')
    expect(await group.locator(`[id="${id}"]`).evaluate(el => el instanceof HTMLElement && el.inert)).toBe(true)
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    await toggle.click()
    expect(await card.getAttribute('data-plugin-entry')).toBe(cardIdentity)
    expect(await card.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await details.evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await toggle.click()
  })

  it('searches localized copy across scopes and records the rendered details', async () => {
    const search = page.getByRole('searchbox', { name: '搜索插件' })
    await search.fill('读取文件和图片')
    expect(await page.getByRole('button', { name: '会话插件', exact: true }).getAttribute('aria-expanded')).toBe('true')
    expect(await page.getByRole('button', { name: '全局插件', exact: true }).getAttribute('aria-expanded')).toBe('true')
    expect(await page.locator('[data-plugin-module]:visible').count()).toBeGreaterThan(0)
    const card = page.locator('[data-plugin-scope="preset"] [data-plugin-module]').first()
    if (await card.getByRole('button').getAttribute('aria-expanded') !== 'true') await card.getByRole('button').click()
    await compareOrRefreshGolden(join(EXPECTED, 'search.expected.md'), await captureStableAria(page, '[data-settings-page]', scaffold.workspaceCwd), mode)
    await search.fill('no-plugin-has-this-name')
    await page.getByText('没有匹配的插件。', { exact: true }).waitFor()
    await search.fill('')
    expect(await page.getByRole('button', { name: '会话插件', exact: true }).getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps narrow light and dark layouts within the viewport without console failures', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: '会话插件', exact: true }).click()
    for (const dark of [false, true]) {
      await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    expect(tripwire.pageErrors).toEqual([])
  })
})
