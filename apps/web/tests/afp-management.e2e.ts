/** Keyless profile report management and account-local bindings through authenticated Web actions. */
import { fileURLToPath } from 'node:url'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

type FixtureRun = { id: string; status: string; createdAt: number }
type Collection = { id: string; name: string; isPrivate: boolean; docsCount: number }
interface AfpFixtureService {
  config: Record<string, JsonValue>
  store: {
    profile: string
    createRun(categories: string[], config: Record<string, JsonValue>): Promise<FixtureRun>
    readRun(id: string): Promise<FixtureRun>
    saveRun(run: FixtureRun): Promise<void>
    readBindings(account: string): Promise<{ values: Record<string, { id: string; name: string } | null> }>
  }
  connection: { open(signal: AbortSignal): Promise<{ account: string; client: { listSelections(): Promise<Collection[]> } }> }
  startRefresh(args: { categories: string[] }, owner: undefined, signal: AbortSignal): Promise<{ runId: string }>
}

it('pauses and archives local reports, retains refresh geometry and persists category bindings without AFP writes', async () => {
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: fileURLToPath(new URL('../../../custom-plugins/workspace/dsh-plugin-afp/', import.meta.url)), enabled: true }] },
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  const browser = await chromium.launch()
  try {
    // 测试替身只替换此隔离 profile 的 AFP 连接；报告、锁、任务、绑定和页面 RPC 均用真实实现。
    const afp = scaffold.ctx.get('afp') as AfpFixtureService
    const selections: Collection[] = [
      { id: 'food-default', name: 'AutoFlow_食物', isPrivate: true, docsCount: 0 },
      { id: 'food-custom', name: '私有绑定夹具', isPrivate: true, docsCount: 0 },
    ]
    let connecting = false, entered: (() => void) | undefined
    afp.connection.open = async (signal) => {
      if (connecting) {
        entered?.()
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        signal.throwIfAborted()
      }
      return { account: 'binding-fixture', client: { listSelections: async () => selections } }
    }
    const older = await afp.store.createRun(['animals'], afp.config)
    older.status = 'paused'; older.createdAt = 10; await afp.store.saveRun(older)
    const next = await afp.store.createRun(['landscape'], afp.config)
    next.status = 'paused'; next.createdAt = 20; await afp.store.saveRun(next)
    connecting = true
    const connected = new Promise<void>((resolve) => { entered = resolve })
    const active = await afp.startRefresh({ categories: ['food'] }, undefined, new AbortController().signal)
    await connected
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    const tripwire = watchConsole(page)
    let releaseHistory: (() => void) | undefined, heldHistory: Promise<void> | undefined
    await page.route('**/api/afp/workbench-data', async (route) => {
      const input: unknown = route.request().postDataJSON()
      if (input && typeof input === 'object' && 'operation' in input && input.operation === 'history-list' && heldHistory) await heldHistory
      await route.continue()
    })
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'AFP 图片策展', exact: true }).click()
    await page.getByRole('tab', { name: '筛选任务', exact: true }).click()
    const rows = page.locator('.afp-wb-history-row')
    await expect.poll(() => rows.count()).toBe(3)
    const activeRow = rows.filter({ hasText: '食物' })
    await activeRow.getByRole('button', { name: /^报告更多操作/ }).click()
    await page.getByRole('menuitem', { name: '暂停报告任务', exact: true }).click()
    await page.getByRole('dialog', { name: '暂停报告任务', exact: true }).getByRole('button', { name: '确认', exact: true }).click()
    await expect.poll(async () => (await afp.store.readRun(active.runId)).status).toBe('paused')
    await expect.poll(() => activeRow.textContent()).toContain('已暂停，可继续')
    connecting = false
    await expect.poll(() => page.getByRole('dialog', { name: '暂停报告任务', exact: true }).count()).toBe(0)
    const geometry = await rows.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height))
    heldHistory = new Promise<void>((resolve) => { releaseHistory = resolve })
    await page.locator('.afp-wb-history-section').getByRole('button', { name: '刷新状态', exact: true }).click()
    await expect.poll(() => page.locator('.afp-wb-history-row.is-skeleton').count()).toBe(3)
    expect(await rows.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height))).toEqual(geometry)
    heldHistory = undefined; releaseHistory?.()
    await expect.poll(() => page.locator('.afp-wb-history-row.is-skeleton').count()).toBe(0)
    await page.getByRole('button', { name: '批量管理报告', exact: true }).click()
    await page.getByRole('menuitem', { name: '全选当前已加载报告', exact: true }).click()
    await expect.poll(() => page.getByRole('checkbox', { name: /^选择报告/ }).filter({ visible: true }).count()).toBe(3)
    expect(await page.getByRole('checkbox', { name: /^选择报告/ }).evaluateAll(elements => elements.every(element => element instanceof HTMLInputElement && element.checked))).toBe(true)
    await page.getByRole('button', { name: '批量管理报告', exact: true }).click()
    await page.getByRole('menuitem', { name: '取消全选', exact: true }).click()
    await activeRow.getByRole('button', { name: /^报告更多操作/ }).click()
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('menuitem', { name: '删除本地报告', exact: true }).count()).toBe(0)
    const artifacts = fileURLToPath(new URL('../../../.artifacts/afp-management-20261010/', import.meta.url))
    await mkdir(artifacts, { recursive: true })
    for (const dark of [false, true]) {
      await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark)
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 960 })
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.screenshot({ path: join(artifacts, `reports-${dark ? 'dark' : 'light'}-${width}.png`), fullPage: true })
        await expect.poll(() => page.locator('.afp-wb-history-list').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      }
    }
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    const manageFood = page.getByRole('button', { name: '管理分类收藏夹 · 食物', exact: true }).filter({ visible: true })
    await manageFood.focus(); await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: '管理分类收藏夹 · 食物', exact: true })
    await dialog.getByRole('button', { name: '目标收藏夹', exact: true }).click()
    await page.getByRole('menuitem', { name: '私有绑定夹具', exact: true }).click()
    await dialog.getByRole('button', { name: '保存绑定', exact: true }).click()
    await expect.poll(async () => (await afp.store.readBindings('binding-fixture')).values.food?.id).toBe('food-custom')
    await expect.poll(() => dialog.count()).toBe(0)
    await manageFood.click()
    await dialog.getByRole('button', { name: '删除绑定', exact: true }).click()
    await expect.poll(async () => (await afp.store.readBindings('binding-fixture')).values.food).toBeNull()
    await expect.poll(() => dialog.count()).toBe(0)
    await page.reload()
    await page.getByRole('button', { name: 'AFP 图片策展', exact: true }).click()
    await page.getByRole('tab', { name: '筛选任务', exact: true }).click()
    await manageFood.click()
    expect(await dialog.getByRole('button', { name: '新增绑定', exact: true }).isEnabled()).toBe(false)
    await page.keyboard.press('Escape')
    await rows.filter({ hasText: '动物' }).getByRole('button', { name: /^报告更多操作/ }).click()
    await page.getByRole('menuitem', { name: '删除本地报告', exact: true }).click()
    await page.getByRole('dialog', { name: '删除本地报告', exact: true }).getByRole('button', { name: '确认', exact: true }).click()
    await expect.poll(() => rows.count()).toBe(2)
    await access(join(afp.store.profile, 'archived-runs', `${older.id}.json`))
    await expect.poll(() => rows.evaluateAll(elements => elements.every(element => !element.classList.contains('is-skeleton')))).toBe(true)
    await page.getByRole('button', { name: '批量管理报告', exact: true }).click()
    await page.getByRole('menuitem', { name: '全选当前已加载报告', exact: true }).click()
    await page.getByRole('button', { name: '批量管理报告', exact: true }).click()
    await page.getByRole('menuitem', { name: '删除本地报告', exact: true }).click()
    await page.getByRole('dialog', { name: '删除本地报告', exact: true }).getByRole('button', { name: '确认', exact: true }).click()
    await expect.poll(() => rows.count()).toBe(0)
    await access(join(afp.store.profile, 'archived-runs', `${next.id}.json`))
    await access(join(afp.store.profile, 'archived-runs', `${active.runId}.json`))
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/afp-debug/management.expected.md', import.meta.url)),
      JSON.stringify({ pausedCheckpoint: true, archivedReports: 3, remainingReports: 0, manualSkeletonMatchesRows: true,
        batchScope: 'loaded-reports', bindingPersistsAfterReload: null, remoteWrites: 0, menuEscape: true, themes: ['light', 'dark'], widths: [1440, 390] }, null, 2), webSnapshotMode())
  } finally {
    try { await browser.close() } finally { await scaffold.close() }
  }
})
