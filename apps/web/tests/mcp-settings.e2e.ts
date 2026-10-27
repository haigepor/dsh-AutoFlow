/** Settings-driven MCP management through the shipped Web composition and real HTTP MCP transport. */
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, watch } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, captureStableAria, compareOrRefreshGolden, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { startHttpMcpFixture, type HttpMcpFixture } from '../../../packages/mcp/mcp-client/tests/http-fixture.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

let home: string
let scaffold: WebScaffold
let browser: Browser
let page: Page
let server: HttpMcpFixture
let tripwire: ReturnType<typeof watchConsole>
const screenshotDirectory = process.env.DSH_MCP_SCREENSHOT_DIR
const expected = (name: string) => fileURLToPath(new URL(`./expected/mcp-settings/${name}.expected.md`, import.meta.url))

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-web-mcp-'))
  server = await startHttpMcpFixture()
  scaffold = await launchWebScaffold({ harnessHome: home, deepSeekMissingCredential: true, profile: { packages: [] },
    extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), fileURLToPath(new URL('./mcp-settings.overlay.yml', import.meta.url))] })
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  page = await context.newPage()
  tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'MCP 服务', exact: true }).click()
  await page.getByText('还没有 MCP 服务', { exact: true }).waitFor()
  if (process.env.DSH_MCP_INSPECT_PATH !== undefined) await writeFile(process.env.DSH_MCP_INSPECT_PATH, scaffold.authenticatedUrl, 'utf8')
}, 120000)

afterAll(async () => {
  const inspect = process.env.DSH_MCP_INSPECT_PATH
  if (inspect !== undefined && scaffold !== undefined && !existsSync(`${inspect}.done`)) {
    await writeFile(inspect, scaffold.authenticatedUrl, 'utf8')
    await new Promise<void>((resolve) => {
      const finish = (): void => { clearTimeout(timer); watcher.close(); resolve() }
      const watcher = watch(dirname(inspect), (_event, file) => { if (file === `${basename(inspect)}.done`) finish() })
      const timer = setTimeout(finish, 180000)
    })
  }
  await browser?.close()
  await scaffold?.close()
  await server?.close()
  if (home !== undefined && resolve(home).startsWith(resolve(join(tmpdir(), 'dsh-web-mcp-')))) await rm(home, { recursive: true, force: true })
}, 210000)

async function capture(name: string): Promise<void> {
  if (screenshotDirectory === undefined) return
  await mkdir(screenshotDirectory, { recursive: true })
  await page.evaluate(async () => { await document.fonts.ready })
  await page.screenshot({ path: join(screenshotDirectory, `${name}.png`), animations: 'disabled' })
}

it('adds, edits, reconnects and disables a server from MCP settings', async () => {
  const section = page.locator('[data-mcp-settings]')
  expect(await page.getByRole('button', { name: '打开配置文件', exact: true }).count()).toBe(0)
  await section.getByRole('button', { name: '了解 MCP 配置生效方式', exact: true }).click()
  await page.getByRole('dialog', { name: '连接外部工具和数据源', exact: true }).waitFor()
  expect(await page.getByRole('dialog').textContent()).toContain('添加、编辑或启停服务后')
  await capture('mcp-help-light')
  await page.keyboard.press('Escape')
  await section.getByRole('button', { name: '添加 MCP', exact: true }).first().click()
  await section.getByRole('textbox', { name: /^服务器名称/ }).fill('web_demo')
  await section.getByRole('button', { name: '连接方式', exact: true }).click()
  await page.getByRole('menu').waitFor()
  await capture('mcp-transport-light')
  await page.getByRole('menuitem', { name: '远程服务', exact: true }).click()
  await section.getByLabel('服务 URL', { exact: true }).fill(server.url)
  await section.getByRole('button', { name: '添加一项', exact: true }).click()
  await section.getByRole('textbox', { name: '名称', exact: true }).fill('Authorization')
  await section.getByLabel('值', { exact: true }).fill('Bearer fixture-token')
  await section.getByRole('button', { name: '保存并应用', exact: true }).click()
  await section.getByText('已连接', { exact: true }).waitFor()
  await section.locator('img').evaluate(async (image) => { await (image as HTMLImageElement).decode() })
  await expect.poll(() => server.authorization.includes('Bearer fixture-token')).toBe(true)
  await section.getByRole('button', { name: '导入 JSON 配置', exact: true }).click()
  const jsonDialog = page.getByRole('dialog', { name: 'MCP JSON 配置', exact: true })
  const jsonSource = jsonDialog.getByRole('textbox', { name: 'JSON 配置内容', exact: true })
  await jsonSource.waitFor()
  expect(await jsonSource.inputValue()).not.toContain('fixture-token')
  await jsonDialog.locator('[data-code-editor] pre span[style*="--shiki-token"]').first().waitFor()
  await capture('mcp-json-light')
  const configuration = JSON.parse(await jsonSource.inputValue()) as { mcpServers: Record<string, Record<string, unknown>> }
  configuration.mcpServers.web_demo!.toolCallTimeoutMs = 24000
  configuration.mcpServers.json_added = { url: server.url, disabled: true }
  await jsonSource.fill(JSON.stringify(configuration, null, 2))
  await jsonDialog.getByRole('button', { name: '保存并应用', exact: true }).click()
  await section.getByRole('button', { name: '配置 json_added', exact: true }).first().waitFor()
  await expect.poll(() => server.authorization.at(-1)).toBe('Bearer fixture-token')
  await section.getByRole('button', { name: '导入 JSON 配置', exact: true }).click()
  await jsonSource.waitFor()
  const concurrent = JSON.parse(await jsonSource.inputValue()) as { mcpServers: Record<string, Record<string, unknown>> }
  const configured = (await scaffold.ctx.mcpSettings.list()).servers.find(row => row.serverName === 'json_added')
  if (configured === undefined) throw new Error('Expected imported server')
  const current = await scaffold.ctx.mcpSettings.detail(configured.id)
  await scaffold.ctx.mcpSettings.update(current.id, { ...current.config, toolCallTimeoutMs: 32000 }, current.revision)
  concurrent.mcpServers.web_demo!.toolCallTimeoutMs = 18000
  concurrent.mcpServers.json_added!.toolCallTimeoutMs = 64000
  const failedDraft = JSON.stringify(concurrent, null, 2)
  await jsonSource.fill(failedDraft)
  await jsonDialog.getByRole('button', { name: '保存并应用', exact: true }).click()
  await jsonDialog.getByRole('alert').waitFor()
  expect(await jsonDialog.getByRole('alert').textContent()).toContain('部分配置已保存')
  expect(await jsonSource.inputValue()).toBe(failedDraft)
  await jsonDialog.getByRole('button', { name: '重新读取配置', exact: true }).click()
  await expect.poll(async () => {
    const loaded = JSON.parse(await jsonSource.inputValue()) as { mcpServers: Record<string, Record<string, unknown>> }
    return loaded.mcpServers.json_added?.toolCallTimeoutMs
  }).toBe(32000)
  await jsonDialog.getByRole('button', { name: '取消', exact: true }).click()
  await compareOrRefreshGolden(expected('list'), await captureStableAria(page, '[data-mcp-settings]', scaffold.workspaceCwd), webSnapshotMode())
  await capture('mcp-list-light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await capture('mcp-list-dark')
  await page.setViewportSize({ width: 480, height: 900 })
  expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await capture('mcp-list-narrow')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.emulateMedia({ colorScheme: 'light' })

  await section.getByRole('button', { name: '配置 web_demo', exact: true }).first().click()
  await section.getByText('mcp__web_demo__ping', { exact: true }).waitFor()
  expect(await section.getByPlaceholder('已保存，输入新值替换').inputValue()).toBe('')
  await section.getByRole('button', { name: '高级设置', exact: true }).click()
  await section.getByLabel('调用超时（毫秒）', { exact: true }).fill('12000')
  await section.getByRole('button', { name: '保存并应用', exact: true }).click()
  await section.getByRole('button', { name: '配置 web_demo', exact: true }).first().waitFor()
  await section.getByRole('button', { name: '配置 web_demo', exact: true }).first().click()
  await section.getByRole('button', { name: '重启服务', exact: true }).waitFor()
  const requests = server.authorization.length
  await section.getByRole('button', { name: '重启服务', exact: true }).click()
  await expect.poll(() => server.authorization.length).toBeGreaterThan(requests)
  await section.getByText('已连接', { exact: true }).waitFor()
  await capture('mcp-detail-light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await capture('mcp-detail-dark')
  await page.setViewportSize({ width: 480, height: 900 })
  expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await capture('mcp-detail-narrow')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await section.getByRole('button', { name: '返回列表', exact: true }).click()
  await section.getByRole('switch', { name: '启用 web_demo', exact: true }).click()
  await section.getByRole('button', { name: '配置 web_demo', exact: true }).first().getByText('已停用', { exact: true }).waitFor()
  await section.getByRole('button', { name: '重启并应用', exact: true }).click()
  await page.getByRole('dialog', { name: '重启应用并加载配置', exact: true }).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).last().click()
  expect(tripwire.pageErrors).toEqual([])
}, 180000)
