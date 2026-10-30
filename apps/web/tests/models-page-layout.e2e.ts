/** Keyless Models workspace loading, fixed actions, disclosures and built-in reset. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type Route } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
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
  const clientErrors: string[] = []
  const directory = '**/api/llm/listProviders'
  const shell = () => page.locator('[data-settings-page]')
  const models = () => shell().locator('[data-settings-section="models"]')
  const screenshotDirectory = process.env.DSH_MODELS_SCREENSHOT_DIR
  const captureProvider = async (name: string): Promise<void> => {
    if (screenshotDirectory === undefined) return
    await mkdir(screenshotDirectory, { recursive: true })
    await page.evaluate(async () => { await document.fonts.ready })
    await page.getByRole('region', { name: '添加模型提供商', exact: true }).screenshot({
      path: join(screenshotDirectory, `${name}.png`), animations: 'disabled',
    })
  }
  const captureFailure = async (): Promise<void> => {
    if (screenshotDirectory === undefined || page === undefined) return
    await mkdir(screenshotDirectory, { recursive: true })
    await writeFile(join(screenshotDirectory, 'failure.txt'), JSON.stringify({
      errors: tripwire.pageErrors, clientErrors, warnings: tripwire.warnings,
      aria: await page.locator('body').ariaSnapshot(),
    }, null, 2), 'utf8')
    await page.screenshot({ path: join(screenshotDirectory, 'failure.png'), animations: 'disabled' })
  }

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
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      // 目录重试场景主动返回 503，浏览器的该条资源诊断不属于未处理的页面错误。
      if (message.text().includes('503') && message.location().url.endsWith('/api/llm/listProviders')) return
      clientErrors.push(message.text())
    })
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await shell().getByRole('button', { name: '模型', exact: true }).click()
    } catch (error) {
      await captureFailure()
      throw error
    }
  }, 120_000)

  afterAll(async () => {
    release()
    await browser?.close()
    await scaffold?.close()
    if (home !== undefined && resolve(home).startsWith(resolve(join(tmpdir(), 'dsh-models-layout-')))) {
      await rm(home, { recursive: true, force: true })
    }
  })

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await captureFailure()
  })

  it('loads a model-first catalog with retry and a matching skeleton', async () => {
    await models().locator('[data-models-skeleton]').waitFor()
    expect(await models().getByRole('heading', { name: '模型与连接', exact: true }).count()).toBe(1)
    await compareOrRefreshGolden(expected('workspace-loading'), await captureStableAria(page,
      '[data-settings-section="models"]', scaffold.workspaceCwd), webSnapshotMode())
    requestMode = 'fail'
    release()
    await models().getByRole('button', { name: '重试', exact: true }).waitFor()
    requestMode = 'normal'
    await models().getByRole('button', { name: '重试', exact: true }).click()
    await models().getByRole('button', { name: '编辑 model-alpha', exact: true }).waitFor()
    const artwork = models().locator('img[alt=""][aria-hidden="true"]').first()
    await expect.poll(() => artwork.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(320)
    expect(await models().getByRole('tab', { name: '模型目录', exact: true }).getAttribute('aria-selected')).toBe('true')
    await compareOrRefreshGolden(expected('workspace-ready'), await captureStableAria(page,
      '[data-settings-section="models"]', scaffold.workspaceCwd), webSnapshotMode())
  })

  it('keeps wheel scrolling at the page edge across desktop and narrow settings', async () => {
    const viewport = page.viewportSize()
    try {
      for (const size of [{ width: 1680, height: 520 }, { width: 390, height: 640 }]) {
        await page.setViewportSize(size)
        const section = models()
        await section.evaluate((el) => { el.scrollTop = 0 })
        await expect.poll(() => section.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100)
        const box = await section.boundingBox()
        if (box === null) throw new Error('Models settings are not visible')
        expect(Math.abs(box.x + box.width - size.width)).toBeLessThan(1)
        await page.mouse.move(box.x + box.width / 2, box.y + box.height - 60)
        await page.mouse.wheel(0, 300)
        await expect.poll(() => section.evaluate(el => el.scrollTop), { timeout: 3000 }).toBeGreaterThan(50)
        await page.mouse.wheel(0, -300)
        await expect.poll(() => section.evaluate(el => el.scrollTop), { timeout: 3000 }).toBeLessThan(1)
      }
    } finally {
      if (viewport !== null) await page.setViewportSize(viewport)
      await models().evaluate((el) => { el.scrollTop = 0 })
    }
  })

  it('filters by name and provider and saves one model without removing siblings', async () => {
    const search = models().getByRole('searchbox', { name: '搜索模型名称或 ID' })
    await search.fill('alpha')
    expect(await models().getByRole('button', { name: '编辑 model-beta', exact: true }).count()).toBe(0)
    await models().getByRole('button', { name: '筛选提供商', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Fixture Gateway', exact: true }).click()
    const edit = models().getByRole('button', { name: '编辑 model-alpha', exact: true })
    await edit.click()
    const dialog = page.getByRole('dialog', { name: '模型配置', exact: true })
    const box = await dialog.boundingBox()
    expect(Math.abs(box!.x + box!.width / 2 - 840)).toBeLessThan(2)
    expect(await dialog.getByRole('region', { name: '基本信息', exact: true }).count()).toBe(1)
    expect(await dialog.getByRole('textbox', { name: 'API 密钥', exact: true }).count()).toBe(0)
    await dialog.getByRole('textbox', { name: '显示名称 1', exact: true }).fill('Alpha renamed')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => models().innerText()).toContain('Alpha renamed')
    const config = await readFile(join(home, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(config).toContain('model-beta')
    expect(config).toContain('Alpha renamed')
    await search.fill('')
    await models().getByRole('button', { name: '添加模型', exact: true }).click()
    await dialog.getByRole('textbox', { name: '模型 ID 3', exact: true }).fill('model-gamma')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await models().getByRole('button', { name: '编辑 model-gamma', exact: true }).waitFor()
  })

  it('retains drafts through reset cancellation and returns focus from a dialog', async () => {
    const providerTab = models().getByRole('tab', { name: '提供商', exact: true })
    await providerTab.focus()
    await page.keyboard.press('Enter')
    const edit = models().getByRole('button', { name: '编辑 DeepSeek (deepseek-official)', exact: true })
    await edit.click()
    const drawer = page.getByRole('dialog', { name: '提供商配置', exact: true })
    const key = drawer.getByRole('textbox', { name: 'API 密钥', exact: true })
    await key.fill('sk-unsaved-fixture')
    await drawer.getByRole('button', { name: '清除 DeepSeek (deepseek-official) 配置', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: '清除 DeepSeek (deepseek-official) 配置？', exact: true })
    await compareOrRefreshGolden(expected('workspace-reset'), await captureStableAria(page,
      '[role="dialog"][aria-modal="true"]', scaffold.workspaceCwd), webSnapshotMode())
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    expect(await key.inputValue()).toBe('sk-unsaved-fixture')
    await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'hidden' })
    expect(await edit.evaluate(el => document.activeElement === el)).toBe(true)
  })

  it('aligns provider cards with the catalog and stages model edits inside the provider dialog', async () => {
    const capture = async (name: string, selector: string): Promise<void> => {
      if (screenshotDirectory === undefined) return
      await mkdir(screenshotDirectory, { recursive: true })
      await page.evaluate(async () => { await document.fonts.ready })
      await page.locator(selector).screenshot({ path: join(screenshotDirectory, `${name}.png`), animations: 'disabled' })
    }
    await models().getByRole('tab', { name: '模型目录', exact: true }).click()
    const catalogArt = await models().locator('section:not([hidden]) img[width="104"]').boundingBox()
    const catalogTitle = await models().getByRole('heading', { name: /^模型目录/ }).boundingBox()
    await models().getByRole('tab', { name: '提供商', exact: true }).click()
    const providerArt = models().locator('section:not([hidden]) img[width="104"]')
    await expect.poll(() => providerArt.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(320)
    const artBox = await providerArt.boundingBox()
    const titleBox = await models().getByRole('heading', { name: /^提供商/ }).boundingBox()
    expect([artBox!.x, artBox!.y, artBox!.width, artBox!.height])
      .toEqual([catalogArt!.x, catalogArt!.y, catalogArt!.width, catalogArt!.height])
    expect(titleBox!.x).toBe(catalogTitle!.x)
    const card = models().getByRole('article', { name: 'Fixture Gateway', exact: true })
    expect(await card.innerText()).toContain('3 个模型')
    expect(await card.innerText()).toContain('由提供商管理认证')
    await compareOrRefreshGolden(expected('providers-ready'), await captureStableAria(page,
      '[data-settings-section="models"]', scaffold.workspaceCwd), webSnapshotMode())
    await capture('providers-light', '[data-settings-section="models"]')
    const edit = card.getByRole('button', { name: '编辑 Fixture Gateway (fixture-gateway)', exact: true })
    await edit.click()
    const dialog = page.getByRole('dialog', { name: '提供商配置', exact: true })
    const endpoint = dialog.getByRole('textbox', { name: 'API 地址', exact: true })
    const key = dialog.getByRole('textbox', { name: 'API 密钥', exact: true })
    await expect.poll(async () => (await endpoint.boundingBox())!.height).toBe(42)
    expect((await key.boundingBox())!.height).toBe(42)
    const table = dialog.getByRole('table', { name: '模型目录', exact: true })
    expect(await table.getByRole('columnheader').allTextContents()).toEqual(['模型 / ID', '输入与推理', '上下文窗口', '操作'])
    expect((await table.boundingBox())!.y).toBeGreaterThan((await key.boundingBox())!.y)
    const actions = dialog.locator('[data-provider-disclosure]')
    expect((await actions.boundingBox())!.y).toBeGreaterThan((await table.boundingBox())!.y)
    await compareOrRefreshGolden(expected('provider-settings'), await captureStableAria(page,
      '[role="dialog"][aria-modal="true"]', scaffold.workspaceCwd), webSnapshotMode())
    await capture('provider-settings-light', '[role="dialog"][aria-modal="true"]')
    await table.getByRole('button', { name: '模型选项 1', exact: true }).click()
    const modelDialog = page.getByRole('dialog', { name: '模型配置', exact: true })
    await modelDialog.getByRole('textbox', { name: '显示名称 1', exact: true }).fill('Alpha staged')
    await modelDialog.getByRole('button', { name: '完成', exact: true }).click()
    expect(await table.innerText()).toContain('Alpha staged')
    expect(await readFile(join(home, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')).not.toContain('Alpha staged')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    expect(await edit.evaluate(el => document.activeElement === el)).toBe(true)
    await edit.click()
    expect(await table.innerText()).not.toContain('Alpha staged')
    await table.getByRole('button', { name: '模型选项 1', exact: true }).click()
    await modelDialog.getByRole('textbox', { name: '显示名称 1', exact: true }).fill('Alpha provider saved')
    await modelDialog.getByRole('button', { name: '完成', exact: true }).click()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const saved = await readFile(join(home, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(saved).toContain('Alpha provider saved')
    expect(saved).toContain('model-beta')
    expect(saved).toContain('model-gamma')

    await shell().getByRole('button', { name: '外观主题', exact: true }).click()
    await shell().getByRole('button', { name: '深色', exact: true }).click()
    await shell().getByRole('button', { name: '模型', exact: true }).click()
    await models().getByRole('tab', { name: '提供商', exact: true }).click()
    await capture('providers-dark', '[data-settings-section="models"]')
    await models().getByRole('button', { name: '编辑 Fixture Gateway (fixture-gateway)', exact: true }).click()
    await capture('provider-settings-dark', '[role="dialog"][aria-modal="true"]')
    await page.setViewportSize({ width: 390, height: 900 })
    const saveBox = await dialog.getByRole('button', { name: '保存', exact: true }).boundingBox()
    expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(900)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    const scroll = table.locator('..')
    expect(await scroll.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
    await capture('provider-settings-mobile', '[role="dialog"][aria-modal="true"]')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await capture('providers-mobile', '[data-settings-section="models"]')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.setViewportSize({ width: 1680, height: 1000 })
    await shell().getByRole('button', { name: '外观主题', exact: true }).click()
    await shell().getByRole('button', { name: '浅色', exact: true }).click()
    await shell().getByRole('button', { name: '模型', exact: true }).click()
  })

  it('opens the provider setup page with a return action and matching artwork', async () => {
    const typography = async (selector: string) => models().locator(selector).first().evaluate((el) => {
      const style = getComputedStyle(el)
      return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight]
    })
    const overviewTitle = await typography('h1')
    const overviewTab = await typography('[role="tab"]')
    await models().getByRole('button', { name: '添加模型提供商', exact: true }).click()
    const dialog = page.getByRole('region', { name: '添加模型提供商', exact: true })
    await dialog.getByRole('heading', { name: '添加模型提供商', exact: true }).waitFor()
    expect(await dialog.getByRole('button', { name: '返回模型与连接', exact: true }).count()).toBe(0)
    expect(await typography('[data-provider-page] h1')).toEqual(overviewTitle)
    expect(await typography('[data-provider-page] [role="tab"]')).toEqual(overviewTab)
    expect(await page.getByRole('dialog', { name: '添加模型提供商', exact: true }).count()).toBe(0)
    const headerArtwork = dialog.locator('img[width="104"]')
    await expect.poll(() => headerArtwork.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(320)
    const headerArtBox = await headerArtwork.boundingBox()
    const headerTitleBox = await dialog.getByRole('heading', { name: '添加模型提供商', exact: true }).boundingBox()
    const introTitleBox = await dialog.getByRole('heading', { name: '服务与认证', exact: true }).boundingBox()
    const tabsBox = await dialog.getByRole('tablist', { name: '添加方式', exact: true }).boundingBox()
    const submitBox = await dialog.getByRole('button', { name: '添加提供商', exact: true }).boundingBox()
    expect(headerArtBox!.x + headerArtBox!.width).toBeLessThan(introTitleBox!.x)
    expect(headerArtBox!.y).toBeGreaterThan(tabsBox!.y + tabsBox!.height)
    expect(Math.abs(submitBox!.y - headerTitleBox!.y)).toBeLessThan(3)
    expect(submitBox!.x).toBeGreaterThan(introTitleBox!.x)
    expect(await shell().getByRole('button', { name: '打开配置文件', exact: true }).count()).toBe(0)
    expect((await dialog.getByRole('tablist', { name: '添加方式', exact: true }).boundingBox())!.height).toBeLessThanOrEqual(44)
    const providerBox = await dialog.getByRole('button', { name: '提供商', exact: true }).boundingBox()
    expect(providerBox!.height).toBe(42)
    const keyBox = await dialog.getByRole('textbox', { name: 'API 密钥', exact: true }).boundingBox()
    expect(Math.abs(keyBox!.y - providerBox!.y)).toBeLessThan(3)
    expect(keyBox!.x).toBeGreaterThan(providerBox!.x + providerBox!.width)
    expect(await dialog.getByRole('button', { name: '提供商', exact: true }).locator('img').getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    const nativeCatalogBox = await dialog.getByRole('region', { name: '模型目录', exact: true }).boundingBox()
    expect(nativeCatalogBox!.y).toBeGreaterThan(providerBox!.y + providerBox!.height)
    expect(Math.abs(nativeCatalogBox!.x - providerBox!.x)).toBeLessThan(2)
    const nativeTable = dialog.getByRole('table', { name: '模型目录', exact: true })
    expect(await nativeTable.getByRole('columnheader').allTextContents()).toEqual(['模型 / ID', '输入与推理', '上下文窗口', '操作'])
    const nativeOptions = await dialog.getByRole('button', { name: 'API 地址与模型选项', exact: true }).boundingBox()
    expect(nativeOptions!.y).toBeGreaterThan(nativeCatalogBox!.y + nativeCatalogBox!.height)
    await dialog.getByRole('button', { name: '提供商', exact: true }).click()
    const providerSearch = page.getByRole('searchbox', { name: '搜索提供商名称或 ID', exact: true })
    expect((await page.getByRole('menuitem').allTextContents()).slice(0, 2).map(name => name.toLowerCase())).toEqual(['deepseek', 'openai'])
    await providerSearch.fill('nonexistent-provider-fixture')
    expect(await page.getByRole('menuitem').count()).toBe(0)
    expect(await page.getByRole('status').textContent()).toBe('没有找到匹配的提供商')
    await providerSearch.fill('amazon-bedrock')
    expect(await page.getByRole('menu').evaluate(el => [...el.querySelectorAll('*')].every(child => child.scrollWidth <= child.clientWidth + 1))).toBe(true)
    await page.keyboard.press('Home')
    expect(await providerSearch.evaluate(el => document.activeElement === el)).toBe(true)
    await page.keyboard.press('ArrowDown')
    expect(await page.getByRole('menuitem', { name: 'amazon-bedrock', exact: true }).evaluate(el => document.activeElement === el)).toBe(true)
    await page.keyboard.press('Escape')
    expect(await dialog.getByRole('button', { name: '提供商', exact: true }).evaluate(el => document.activeElement === el)).toBe(true)
    await captureProvider('provider-catalog-light')
    await dialog.getByRole('tab', { name: '第三方模型提供商', exact: true }).focus()
    await page.keyboard.press('ArrowDown')
    expect(await dialog.getByRole('tab', { name: '自定义模型 API', exact: true }).getAttribute('aria-selected')).toBe('true')
    expect(await dialog.getByRole('textbox', { name: 'Provider ID', exact: true }).count()).toBe(0)
    await dialog.getByRole('button', { name: '高级选项', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Provider ID', exact: true }).fill('fixture-provider-dialog')
    expect(await dialog.getByRole('region', { name: '提供商信息', exact: true }).count()).toBe(1)
    expect(await dialog.getByRole('region', { name: '连接与认证', exact: true }).count()).toBe(1)
    const connectionBox = await dialog.getByRole('textbox', { name: 'API 地址', exact: true }).boundingBox()
    const customCatalogBox = await dialog.getByRole('region', { name: '模型目录', exact: true }).boundingBox()
    expect(customCatalogBox!.y).toBeGreaterThan(connectionBox!.y + connectionBox!.height)
    const customOptions = await dialog.getByRole('button', { name: '高级选项', exact: true }).boundingBox()
    expect(customOptions!.y).toBeGreaterThan(customCatalogBox!.y + customCatalogBox!.height)
    await dialog.getByRole('button', { name: '高级选项', exact: true }).click()
    await compareOrRefreshGolden(expected('provider-dialog'), await captureStableAria(page,
      '[data-provider-page]', scaffold.workspaceCwd), webSnapshotMode())
    await captureProvider('provider-custom-light')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    expect(await models().getByRole('button', { name: '添加模型提供商', exact: true }).evaluate(el => document.activeElement === el)).toBe(true)
    await shell().getByRole('button', { name: '外观主题', exact: true }).click()
    await shell().getByRole('button', { name: '深色', exact: true }).click()
    await shell().getByRole('button', { name: '模型', exact: true }).click()
    await models().getByRole('button', { name: '添加模型提供商', exact: true }).click()
    await captureProvider('provider-catalog-dark')
    await dialog.getByRole('tab', { name: '自定义模型 API', exact: true }).click()
    await captureProvider('provider-custom-dark')
    await page.setViewportSize({ width: 390, height: 900 })
    const cancelBox = await dialog.getByRole('button', { name: '取消', exact: true }).boundingBox()
    expect(cancelBox!.y + cancelBox!.height).toBeLessThanOrEqual(900)
    expect(await dialog.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    await dialog.getByRole('tablist', { name: '添加方式', exact: true }).scrollIntoViewIfNeeded()
    await captureProvider('provider-custom-mobile-top')
    await dialog.getByRole('button', { name: '取消', exact: true }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await captureProvider('provider-custom-mobile')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.setViewportSize({ width: 1680, height: 1000 })
    await shell().getByRole('button', { name: '外观主题', exact: true }).click()
    await shell().getByRole('button', { name: '浅色', exact: true }).click()
    await shell().getByRole('button', { name: '模型', exact: true }).click()
  })

  it('edits model drafts in a separate dialog before creating the provider', async () => {
    await models().getByRole('button', { name: '添加模型提供商', exact: true }).click()
    const dialog = page.getByRole('region', { name: '添加模型提供商', exact: true })
    await dialog.getByRole('tab', { name: '自定义模型 API', exact: true }).click()
    await dialog.getByRole('textbox', { name: '显示名称', exact: true }).fill('Compact fixture')
    await dialog.getByRole('textbox', { name: 'API 地址', exact: true }).fill('https://fixture.example/v1')
    await dialog.getByRole('button', { name: '高级选项', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Provider ID', exact: true }).fill('compact-fixture')
    await dialog.getByRole('button', { name: '高级选项', exact: true }).click()
    await dialog.getByRole('button', { name: '添加模型', exact: true }).click()
    const modelDialog = page.getByRole('dialog', { name: '模型配置', exact: true })
    await expect.poll(async () => (await modelDialog.boundingBox())?.width).toBe(720)
    expect(await modelDialog.getByRole('region', { name: '基本信息', exact: true }).count()).toBe(1)
    await modelDialog.getByRole('textbox', { name: '模型 ID 1', exact: true }).fill('model-compact')
    await modelDialog.getByRole('textbox', { name: '显示名称 1', exact: true }).fill('Compact model')
    await modelDialog.getByRole('textbox', { name: '上下文窗口 1', exact: true }).fill('128K')
    const inputHeights = await modelDialog.getByRole('textbox').evaluateAll(inputs => inputs.map((input) => {
      const control = input.parentElement!
      return Math.round(control.getBoundingClientRect().height)
    }))
    expect(inputHeights).toEqual([42, 42, 42, 42])
    const contextHelp = modelDialog.getByRole('button', { name: '上下文窗口说明', exact: true })
    await contextHelp.click()
    const helpBubble = page.getByRole('dialog', { name: '上下文窗口', exact: true })
    expect(await helpBubble.innerText()).toContain('支持 K、M 缩写')
    await page.keyboard.press('Escape')
    await helpBubble.waitFor({ state: 'hidden' })
    expect(await modelDialog.isVisible()).toBe(true)
    expect(await contextHelp.evaluate(el => document.activeElement === el)).toBe(true)
    await compareOrRefreshGolden(expected('model-draft'), await captureStableAria(page,
      '[role="dialog"][aria-modal="true"]', scaffold.workspaceCwd), webSnapshotMode())
    if (screenshotDirectory !== undefined) await modelDialog.screenshot({ path: join(screenshotDirectory, 'provider-model-dialog.png'), animations: 'disabled' })
    await modelDialog.getByRole('button', { name: '完成', exact: true }).click()
    await modelDialog.waitFor({ state: 'hidden' })
    expect(await dialog.getByRole('textbox', { name: '模型 ID 1', exact: true }).count()).toBe(0)
    const modelTable = dialog.getByRole('table', { name: '模型目录', exact: true })
    const modelRow = modelTable.getByRole('row', { name: /Compact model/ })
    expect(await modelRow.getByRole('cell').nth(2).textContent()).toBe('128K')
    await captureProvider('provider-custom-filled-light')
    await dialog.getByRole('button', { name: '模型选项 1', exact: true }).click()
    expect(await modelDialog.getByRole('textbox', { name: '上下文窗口 1', exact: true }).inputValue()).toBe('128K')
    await page.setViewportSize({ width: 390, height: 900 })
    expect(await modelDialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    const done = modelDialog.getByRole('button', { name: '完成', exact: true })
    const doneBox = await done.boundingBox()
    expect(doneBox!.y + doneBox!.height).toBeLessThanOrEqual(900)
    await page.keyboard.press('Escape')
    await modelDialog.waitFor({ state: 'hidden' })
    expect(await dialog.isVisible()).toBe(true)
    expect(await dialog.getByRole('button', { name: '模型选项 1', exact: true }).evaluate(el => document.activeElement === el)).toBe(true)
    await page.setViewportSize({ width: 1680, height: 1000 })
    await dialog.getByRole('button', { name: '创建提供商', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const config = await readFile(join(home, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(config).toContain('compact-fixture')
    expect(config).toContain('model-compact')
    expect(config).toContain('128000')
  })

  it('keeps overflow local and all dialog actions reachable at narrow widths', async () => {
    await models().getByRole('tab', { name: '模型目录', exact: true }).click()
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await models().getByRole('button', { name: '编辑 model-alpha', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '模型配置', exact: true })
      await dialog.getByRole('button', { name: '取消', exact: true }).scrollIntoViewIfNeeded()
      const box = await dialog.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
    expect(tripwire.pageErrors).toEqual([])
    expect(clientErrors).toEqual([])
  })
})
