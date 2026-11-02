/** Keyless browser regression for grouped navigation and cross-page settings search. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/settings-navigation/navigation.expected.md', import.meta.url))
const HEADING_EXPECTED = fileURLToPath(new URL('./expected/settings-navigation/headings.expected.md', import.meta.url))
const ROWS_EXPECTED = fileURLToPath(new URL('./expected/settings-navigation/appearance-rows.expected.md', import.meta.url))

it('groups settings, finds an unmounted page setting, and keeps the rail and content insets usable', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  const browser = await chromium.launch().catch(async (error: unknown) => {
    try { await scaffold.close() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Settings navigation startup failed')
    }
    throw error
  })
  onTestFinished(async () => {
    const failures: unknown[] = []
    try { await browser.close() } catch (error) { failures.push(error) }
    try { await scaffold.close() } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'Settings navigation cleanup failed')
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE })
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const shell = page.locator('[data-settings-page]')
  await shell.getByRole('heading', { name: '偏好设置', exact: true }).waitFor()
  await compareOrRefreshGolden(EXPECTED,
    await captureStableAria(page, '[data-settings-page] nav', scaffold.workspaceCwd), webSnapshotMode())

  await shell.getByRole('button', { name: '外观主题', exact: true }).hover()
  await shell.getByRole('heading', { name: '模型与智能体', exact: true }).hover()
  expect(await shell.locator('[data-glide-active], [data-glide-placed]').count()).toBe(0)

  const search = shell.getByRole('searchbox', { name: '搜索设置项' })
  await search.fill('字体')
  expect(await page.locator('#appearance-font-heading').count()).toBe(0)
  await shell.getByRole('button', { name: '字体 外观主题', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('appearance-font-heading')
  expect(await page.locator('[data-settings-found]').textContent()).toBe('字体')

  await search.fill('语言')
  await shell.getByRole('button', { name: '语言 通用设置', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe('语言')
  await search.fill('不存在的设置项')
  await shell.getByText('未找到匹配的设置项', { exact: true }).waitFor()
  await search.press('Escape')
  expect(await search.inputValue()).toBe('')
  expect(await shell.count()).toBe(1)

  await shell.getByRole('button', { name: '折叠设置侧栏' }).click()
  await expect.poll(() => shell.getByRole('searchbox').count()).toBe(0)
  await shell.getByRole('button', { name: '搜索设置项', exact: true }).click()
  await expect.poll(() => search.evaluate(element => document.activeElement === element)).toBe(true)

  const insets: string[] = []
  const headingStyles: string[] = []
  const headingAria: string[] = []
  const headingGap = (fromHeader = false) => shell.locator('[data-settings-section]').evaluate((element, measureHeader) => {
    const heading = element.querySelector('h1')!
    const header = heading.closest('[data-settings-page-header]')
    const headingBlock = measureHeader ? header?.parentElement ?? heading : header ?? heading
    const body = headingBlock.nextElementSibling
    const firstBox = (candidate: Element): Element | undefined => {
      const style = getComputedStyle(candidate)
      if (style.position === 'absolute' || style.position === 'fixed') return undefined
      if (style.display === 'contents') {
        return Array.from(candidate.children).map(firstBox).find(child => child !== undefined)
      }
      return candidate.getBoundingClientRect().height > 0 ? candidate : undefined
    }
    const anchor = measureHeader ? headingBlock : heading
    for (let candidate = body; candidate !== null; candidate = candidate.nextElementSibling) {
      const content = firstBox(candidate)
      if (content !== undefined) return Math.round(content.getBoundingClientRect().top
        + (measureHeader ? parseFloat(getComputedStyle(content).paddingTop) : 0)
        - anchor.getBoundingClientRect().bottom)
    }
    throw new Error('The settings heading has no visible content below it')
  }, fromHeader)
  for (const name of ['通用设置', '外观主题', '模型', '内置插件', 'Agent 预设']) {
    await shell.getByRole('button', { name, exact: true }).click()
    await shell.getByRole('region', { name, exact: true }).waitFor()
    await expect.poll(() => shell.locator('[data-settings-section] [aria-busy="true"]').count(), { timeout: 15_000 }).toBe(0)
    const shellFooterCount = name === '模型' ? 0 : 1
    expect(await shell.locator('footer').getByRole('button', { name: '打开配置文件', exact: true }).count()).toBe(shellFooterCount)
    expect(await shell.locator('footer').count()).toBe(shellFooterCount)
    insets.push(await shell.locator('[data-settings-section]').evaluate((element) => {
      const style = getComputedStyle(element)
      return `${style.paddingInlineStart} ${style.paddingInlineEnd} ${style.paddingBlockStart}`
    }))
    headingStyles.push(await shell.locator('[data-settings-section] h1').evaluate((element) => {
      const style = getComputedStyle(element)
      return `${style.fontSize} ${style.fontWeight} ${style.lineHeight} ${style.margin}`
    }))
    expect(await shell.locator('[data-settings-page-header] p, [data-settings-page-header] > [aria-hidden]').count()).toBe(name === '模型' ? 1 : 0)
    expect(await headingGap(name === '模型')).toBe(name === '模型' ? 42 : 24)
    if (name === '外观主题') {
      const row = shell.locator('section[aria-labelledby="appearance-mode-heading"]')
      const selector = row.getByRole('button', { name: '跟随系统', exact: true })
      await shell.locator('[data-appearance-settings] > header button').focus()
      await page.keyboard.press('Tab')
      expect(await selector.evaluate(element => element.matches(':focus-visible'))).toBe(true)
      const presentation = await row.evaluate((element) => {
        const style = getComputedStyle(element)
        const button = element.querySelector('button')!
        const title = element.querySelector('h2')!
        return {
          layout: style.display, padding: style.padding,
          height: Math.round(element.getBoundingClientRect().height),
          controlHeight: Math.round(button.getBoundingClientRect().height),
          titleFont: getComputedStyle(title).fontSize,
          titleWeight: getComputedStyle(title).fontWeight,
        }
      })
      expect(presentation).toMatchObject({ layout: 'flex', padding: '16px 0px', height: 93, controlHeight: 60, titleFont: '14px', titleWeight: '400' })
      const rows = shell.locator('[data-appearance-settings] > section')
      expect(await rows.count()).toBe(5)
      expect(await rows.evaluateAll(elements => new Set(elements.map(element => Math.round(
        (element.querySelector('[role="group"]') ?? element.querySelector('button'))!.getBoundingClientRect().right,
      ))).size)).toBe(1)
      await compareOrRefreshGolden(ROWS_EXPECTED,
        `${JSON.stringify(presentation, null, 2)}\n\n${await captureStableAria(page, '[data-appearance-settings]', scaffold.workspaceCwd)}`, webSnapshotMode())
      expect(await row.getByRole('button').count()).toBe(3)
      for (const mode of ['浅色', '深色', '跟随系统']) {
        const card = row.getByRole('button', { name: mode, exact: true })
        await card.click()
        await expect.poll(() => card.getAttribute('aria-pressed')).toBe('true')
        expect(await page.getByRole('menu').count()).toBe(0)
      }
      const paletteRow = shell.locator('section[aria-labelledby="appearance-palette-heading"]')
      expect(await paletteRow.getByRole('button').count()).toBe(2)
      expect(await paletteRow.locator('svg[data-preview-palette]').count()).toBe(2)
      for (const preset of ['鸢尾紫', '蓝灰']) {
        const card = paletteRow.getByRole('button', { name: preset, exact: true })
        await card.click()
        await expect.poll(() => card.getAttribute('aria-pressed')).toBe('true')
        expect(await page.getByRole('menu').count()).toBe(0)
      }
      await shell.locator('[data-appearance-settings]').getByRole('button', { name: '字体', exact: true }).click()
      await page.evaluate(() => document.fonts.ready)
      const fontFamilies = await page.getByRole('menu').locator('[data-font]').evaluateAll(elements =>
        elements.map(element => getComputedStyle(element).fontFamily))
      expect(new Set(fontFamilies).size).toBe(5)
      expect(fontFamilies[1]).toContain('Source Sans 3')
      expect(fontFamilies[2]).toContain('IBM Plex Serif')
      expect(fontFamilies[3]).toContain('JetBrains Mono')
      expect(fontFamilies[4]).toContain('IBM Plex Sans Condensed')
      await page.keyboard.press('Escape')
      expect(await page.getByRole('menu').count()).toBe(0)
    }
    headingAria.push(`## ${name}\n${await captureStableAria(page, '[data-settings-section] h1', scaffold.workspaceCwd)}`)
  }
  expect(new Set(insets)).toEqual(new Set(['32px 32px 24px']))
  expect(new Set(headingStyles)).toEqual(new Set(['26px 600 36px 0px 0px 24px']))
  await compareOrRefreshGolden(HEADING_EXPECTED, headingAria.join('\n\n'), webSnapshotMode())
  await page.setViewportSize({ width: 390, height: 844 })
  for (const name of ['通用设置', '外观主题', '模型', '内置插件', 'Agent 预设']) {
    await shell.getByRole('button', { name, exact: true }).click()
    await shell.getByRole('region', { name, exact: true }).waitFor()
    expect(await headingGap(name === '模型')).toBe(name === '模型' ? 42 : 24)
    expect(await shell.locator('[data-settings-section]').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
}, 120_000)
