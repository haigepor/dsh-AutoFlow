/** Keyless Models workspace loading, fixed actions, disclosures and built-in reset. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type Route } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const expected = (name: string) => fileURLToPath(new URL(`./expected/models-settings/${name}.expected.md`, import.meta.url))

describe('web e2e: Models workspace layout and reset', () => {
  let home: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let release: () => void = () => {}
  let requestMode: 'delay' | 'normal' | 'fail' = 'delay'
  let tripwire: ReturnType<typeof watchConsole>
  const directory = '**/api/llm/listProviders'
  const shell = () => page.locator('[data-settings-page]')
  const models = () => shell().locator('[data-settings-section="models"]')

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-models-layout-'))
    await mkdir(join(home, 'profiles', 'scaffold'), { recursive: true })
    await writeFile(join(home, 'profiles', 'scaffold', 'cordis.patch.yml'), [
      '- id: llm-deepseek', '  config:', '    baseURL: https://fixture.example/anthropic',
      '- id: llm-pi-ai', '  config:', '    providers:', '      fixture-gateway:',
      '        displayName: Fixture Gateway', '        api: anthropic-messages',
      '        baseURL: https://fixture.example', '        models:',
      '          - id: model-alpha', '            name: Alpha',
      '          - id: model-beta', '            name: Beta', '',
    ].join('\n'), 'utf8')
    scaffold = await launchWebScaffold({ harnessHome: home, deepSeekMissingCredential: true,
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)) })
    browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const gate = new Promise<void>((done) => { release = done })
    await context.route(directory, async (route: Route) => {
      if (requestMode === 'delay') await gate
      if (requestMode === 'fail') { await route.fulfill({ status: 503, body: 'fixture directory unavailable' }); return }
      await route.continue()
    })
    page = await context.newPage()
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await shell().getByRole('button', { name: '模型', exact: true }).click()
  }, 120_000)

  afterAll(async () => {
    release()
    await browser?.close()
    await scaffold?.close()
    if (home !== undefined && resolve(home).startsWith(resolve(join(tmpdir(), 'dsh-models-layout-')))) {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('shows the real title and matching skeleton, then offers retry after an initial failure', async () => {
    await models().locator('[data-models-skeleton]').waitFor()
    expect(await models().getByRole('heading', { name: '模型', exact: true }).count()).toBe(1)
    await compareOrRefreshGolden(expected('workspace-loading'), await captureStableAria(page,
      '[data-settings-section="models"]', scaffold.workspaceCwd), webSnapshotMode())
    requestMode = 'fail'
    release()
    await models().getByRole('button', { name: '重试', exact: true }).waitFor()
    expect(await models().locator('[data-models-skeleton]').count()).toBe(0)
    requestMode = 'normal'
    await models().getByRole('button', { name: '重试', exact: true }).click()
    await models().getByRole('button', { name: '编辑 DeepSeek (deepseek-official)', exact: true }).waitFor()
    await compareOrRefreshGolden(expected('workspace-ready'), await captureStableAria(page,
      '[data-settings-section="models"]', scaffold.workspaceCwd), webSnapshotMode())
  })

  it('keeps provider geometry and the footer stable while the editor scrolls', async () => {
    const row = models().locator('[data-provider-item]').filter({ hasText: 'Fixture Gateway' })
    const geometry = () => row.evaluate(element => [...element.querySelectorAll('[class*="railProviderName"], [role="img"], [class*="rowTag"]')]
      .map((node) => { const box = node.getBoundingClientRect(); return [box.x, box.y, box.width, box.height] }))
    await page.mouse.move(900, 20)
    const before = await geometry()
    await row.hover()
    expect(await geometry()).toEqual(before)
    await row.getByRole('button', { name: /删除/ }).focus()
    expect(await geometry()).toEqual(before)
    await models().getByRole('button', { name: '编辑 DeepSeek (deepseek-official)', exact: true }).click()
    await models().getByRole('button', { name: '自定义设置', exact: true }).click()
    await models().getByRole('button', { name: '模型选项 1', exact: true }).click()
    await models().getByRole('button', { name: '模型选项 2', exact: true }).click()
    const scroller = models().locator('[class*="editorScroll"]')
    const footer = models().locator('[class*="editorActions"]')
    await expect.poll(() => scroller.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    const footerBefore = await footer.boundingBox()
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight })
    expect(await footer.boundingBox()).toEqual(footerBefore)
    const input = models().getByRole('textbox', { name: '上下文窗口 1', exact: true })
    await input.fill('128K')
    const toggle = models().getByRole('button', { name: '模型选项 1', exact: true })
    await toggle.click()
    expect(await models().getByRole('textbox', { name: '上下文窗口 1', exact: true }).count()).toBe(0)
    await toggle.click()
    expect(await input.inputValue()).toBe('128K')
    expect(await input.evaluate(el => el.closest('[class*="capacityControl"]')!.getBoundingClientRect().height)).toBeCloseTo(32, 0)
    const advanced = models().locator('[class*="modelAdvanced"]').first()
    const controls = await advanced.evaluate(el => [...el.querySelectorAll('[class*="capacityControl"], input[class*="input"], label[class*="modelChoice"]')]
      .filter(node => !node.closest('[class*="capacityControl"]') || node.matches('[class*="capacityControl"]'))
      .map((node) => { const box = node.getBoundingClientRect(); return { top: box.top, height: box.height } }))
    expect(controls.length).toBe(4)
    controls.forEach((control) => {
      expect(control.height).toBeCloseTo(32, 0)
      expect(control.top).toBeCloseTo(controls[0]!.top, 0)
    })
    const pane = models().locator('[class*="detail"]').first()
    const paneWidth = (await pane.boundingBox())!.width
    await models().getByRole('button', { name: '收起提供商列表', exact: true }).click()
    await expect.poll(async () => (await models().getByRole('complementary', { name: '提供商' }).boundingBox())!.width).toBeCloseTo(56, 0)
    expect((await pane.boundingBox())!.width).toBeGreaterThan(paneWidth + 180)
    expect(await models().getByRole('button', { name: '编辑 DeepSeek (deepseek-official)', exact: true }).isVisible()).toBe(true)
    expect(await models().locator('[class*="railProviderMark"]').first().evaluate(el => getComputedStyle(el).opacity)).toBe('1')
    expect(await models().getByRole('button', { name: '添加模型提供商', exact: true }).isVisible()).toBe(true)
    expect(await input.inputValue()).toBe('128K')
    await models().getByRole('button', { name: '展开提供商列表', exact: true }).click()
    await expect.poll(async () => (await pane.boundingBox())!.width).toBeCloseTo(paneWidth, 0)
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await footer.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect((await footer.boundingBox())!.y + (await footer.boundingBox())!.height).toBeLessThanOrEqual(1000)
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await models().locator('[class*="disclosure"]').first().evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s')
    expect(await models().locator('[data-rail-collapsed]').evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })

  it('cancels without dropping a draft, clears DeepSeek user overrides and retains its entry', async () => {
    const key = models().getByRole('textbox', { name: 'API 密钥', exact: true })
    await key.fill('sk-unsaved-fixture')
    await models().locator('[data-provider-item]').filter({ hasText: 'DeepSeek' }).hover()
    await models().getByRole('button', { name: '清除 DeepSeek (deepseek-official) 配置', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: '清除 DeepSeek (deepseek-official) 配置？', exact: true })
    await compareOrRefreshGolden(expected('workspace-reset'), await captureStableAria(page,
      '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    expect(await key.inputValue()).toBe('sk-unsaved-fixture')
    await models().getByRole('button', { name: '清除 DeepSeek (deepseek-official) 配置', exact: true }).click()
    await confirmation.getByRole('button', { name: '清除配置', exact: true }).click()
    await confirmation.waitFor({ state: 'hidden' })
    expect(await models().getByRole('button', { name: '编辑 DeepSeek (deepseek-official)', exact: true }).count()).toBe(1)
    expect(await models().getByRole('button', { name: '清除 DeepSeek (deepseek-official) 配置', exact: true }).isDisabled()).toBe(true)
    expect(await readFile(join(home, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')).not.toContain('https://fixture.example/anthropic')
    expect(await shell().getByRole('button', { name: '打开配置文件', exact: true }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  })

  it('shows the delete action continuously on touch and removes a custom provider without selecting it', async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 1000 }, hasTouch: true, isMobile: true,
      locale: ZH_BROWSER_LOCALE })
    try {
      const touch = await context.newPage()
      await touch.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await touch.getByRole('button', { name: '设置', exact: true }).click()
      const surface = touch.locator('[data-settings-page]')
      await surface.getByRole('button', { name: '模型', exact: true }).click()
      const row = surface.locator('[data-provider-item]').filter({ hasText: 'Fixture Gateway' })
      const remove = row.getByRole('button', { name: /删除/ })
      await remove.waitFor()
      expect(await touch.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
      expect(await row.locator('[class*="railAction"]').evaluate(el => getComputedStyle(el).opacity)).toBe('1')
      expect(await row.locator('[class*="rowTag"]').evaluate(el => getComputedStyle(el).opacity)).toBe('0')
      await remove.tap()
      const dialog = touch.getByRole('dialog')
      await dialog.getByRole('button', { name: '取消', exact: true }).tap()
      expect(await surface.getByRole('button', { name: '编辑 DeepSeek (deepseek-official)', exact: true }).getAttribute('aria-current')).toBe('true')
      await remove.tap()
      await touch.getByRole('dialog').getByRole('button', { name: /删除/, exact: false }).tap()
      await touch.getByRole('dialog').waitFor({ state: 'hidden' })
      await expect.poll(() => surface.locator('[data-provider-item]').filter({ hasText: 'Fixture Gateway' }).count(),
        { timeout: 10_000 }).toBe(0)
      expect(await surface.getByRole('button', { name: '编辑 DeepSeek (deepseek-official)', exact: true }).count()).toBe(1)
    } finally {
      await context.close()
    }
  })
})
