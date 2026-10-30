/** Native Skills settings through the shipped composition and isolated local files. */
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  launchWebScaffold,
  watchConsole,
  captureStableAria,
  compareOrRefreshGolden,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh } from './support.ts'

let home: string
let scaffold: WebScaffold
let browser: Browser
let page: Page
let tripwire: ReturnType<typeof watchConsole>

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-web-skills-'))
  for (const name of ['web-directory', 'web-second']) {
    const document = `---\nname: ${name}\ndescription: 浏览器验收技能\n---\n\n# 浏览器技能\n\n读取输入并报告检查结果。\n`
    const bundle = join(home, 'skills', name)
    await mkdir(join(bundle, 'scripts'), { recursive: true })
    await writeFile(join(bundle, 'SKILL.md'), document, 'utf8')
    await writeFile(join(bundle, 'scripts/helper.js'), 'export const value = 1\n', 'utf8')
  }
  scaffold = await launchWebScaffold({
    harnessHome: home,
    profile: { packages: [] },
    extraOverlayPath: [
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      fileURLToPath(new URL('./mcp-settings.overlay.yml', import.meta.url)),
    ],
  })
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Skills技能', exact: true }).click()
  await page.getByRole('button', { name: '查看 web-directory', exact: true }).waitFor()
}, 120000)

afterAll(async () => {
  await browser?.close()
  await scaffold?.close()
  if (home !== undefined && resolve(home).startsWith(resolve(join(tmpdir(), 'dsh-web-skills-'))))
    await rm(home, { recursive: true, force: true })
})

it('creates a skill, previews three-column cards and opens real resource directories before recoverable deletion', async () => {
  const section = page.locator('[data-skill-settings]')
  const externalPath = join(home, 'external-skills')
  await mkdir(externalPath)
  await section.getByRole('button', { name: '来源目录', exact: true }).click()
  const sources = page.getByRole('dialog', { name: '来源目录', exact: true })
  await sources.getByRole('textbox', { name: '外部技能目录的绝对路径', exact: true }).fill(externalPath)
  await sources.getByRole('button', { name: '添加来源', exact: true }).click()
  await sources.getByText(externalPath, { exact: true }).waitFor()
  await sources.getByRole('button', { name: '移除登记', exact: true }).click()
  await sources.getByText(externalPath, { exact: true }).waitFor({ state: 'detached' })
  expect((await stat(externalPath)).isDirectory()).toBe(true)
  await sources.getByRole('button', { name: '关闭', exact: true }).last().click()
  await section.getByRole('tab', { name: '发现', exact: true }).click()
  await section.getByRole('tab', { name: '公共市场', exact: true }).waitFor()
  await section.getByRole('tab', { name: 'GitHub 仓库', exact: true }).click()
  await section.getByRole('textbox', { name: 'GitHub 仓库地址', exact: true }).waitFor()
  expect(await section.getByRole('button', { name: '查看仓库', exact: true }).isEnabled()).toBe(false)
  await section.getByRole('tab', { name: '全局技能', exact: true }).click()
  await section.getByRole('button', { name: '导入技能', exact: true }).click()
  const importing = page.getByRole('dialog', { name: '导入技能', exact: true })
  await importing.getByRole('button', { name: '选择文件夹', exact: true }).waitFor()
  await importing
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'SKILL.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('---\nname: web-created\ndescription: 通过真实页面导入\n---\n\n保留中文指令。\n'),
    })
  await importing.getByRole('button', { name: '导入技能', exact: true }).click()
  await section.getByRole('button', { name: '查看 web-created', exact: true }).waitFor()
  const cards = section.locator('[data-skill-card]').filter({ has: page.getByRole('button', { name: /^查看 web-/ }) })
  expect(await cards.count()).toBe(3)
  const boxes = await cards.evaluateAll(elements =>
    elements.map((element) => {
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width }
    }),
  )
  expect(boxes[0].y).toBe(boxes[1].y)
  expect(boxes[1].y).toBe(boxes[2].y)
  expect(boxes[0].x).toBeLessThan(boxes[1].x)
  await section.locator('img').evaluate(async (image) => {
    await (image as HTMLImageElement).decode()
  })
  await section.getByRole('button', { name: '查看 web-directory', exact: true }).click()
  const preview = page.getByRole('dialog', { name: 'web-directory', exact: true })
  await preview.getByRole('heading', { name: '浏览器技能', exact: true }).waitFor()
  expect(await preview.textContent()).toContain('读取输入并报告检查结果')
  expect(await preview.getByRole('button', { name: '查看完整详情', exact: true }).count()).toBe(0)
  await compareOrRefreshGolden(
    fileURLToPath(new URL('./expected/skills-settings-detail.expected.md', import.meta.url)),
    await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd),
    webSnapshotMode(),
  )
  await preview.getByRole('tab', { name: '目录结构', exact: true }).click()
  const structure = preview.getByRole('complementary', { name: '目录结构', exact: true })
  await structure.getByText('helper.js', { exact: true }).waitFor()
  await structure.locator('summary').click()
  expect(await structure.getByText('helper.js', { exact: true }).isVisible()).toBe(false)
  await structure.locator('summary').click()
  await preview.getByRole('tab', { name: '技能指令', exact: true }).click()
  await preview.getByRole('button', { name: '移入回收站', exact: true }).click()
  await page
    .getByRole('dialog', { name: '将技能移入回收站？', exact: true })
    .getByRole('button', { name: '移入回收站', exact: true })
    .click()
  await section.getByRole('heading', { name: 'Skills技能', exact: true }).waitFor()
  await section.getByRole('button', { name: '查看 web-directory', exact: true }).waitFor({ state: 'detached' })
  await section.getByRole('tab', { name: '回收站', exact: true }).click()
  await section.getByRole('button', { name: '恢复', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '恢复', exact: true }).click()
  await section.getByRole('tab', { name: '全局技能', exact: true }).click()
  await section.getByRole('button', { name: '查看 web-directory', exact: true }).waitFor()
  await page.setViewportSize({ width: 480, height: 900 })
  const narrow = await cards.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().y))
  expect(narrow[0]).toBeLessThan(narrow[1])
  expect(narrow[1]).toBeLessThan(narrow[2])
  await page.setViewportSize({ width: 1440, height: 1000 })
  await section.getByRole('button', { name: '新建技能', exact: true }).click()
  const creating = page.getByRole('dialog', { name: '新建技能', exact: true })
  await creating.getByRole('button', { name: '模型', exact: true }).waitFor()
  const workspaceChoice = creating.getByRole('button', { name: '执行工作区', exact: true })
  await workspaceChoice.click()
  const workspaceMenu = page.getByRole('menu')
  await workspaceMenu.waitFor()
  const anchorBox = await workspaceChoice.boundingBox()
  const menuBox = await workspaceMenu.boundingBox()
  expect(Math.abs(menuBox!.width - anchorBox!.width)).toBeLessThan(2)
  await page.keyboard.press('Escape')
  expect(await creating.isVisible()).toBe(true)
  await expect.poll(() => creating.getByRole('button', { name: '进入 AI 对话', exact: true }).isEnabled()).toBe(true)
  await creating.getByRole('button', { name: '进入 AI 对话', exact: true }).click()
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.waitFor()
  await expect.poll(() => composer.innerText()).toContain('我的需求：')
  expect(await composer.innerText()).toContain('skill-creator')
  expect(await page.locator('[data-skill-settings]').count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
