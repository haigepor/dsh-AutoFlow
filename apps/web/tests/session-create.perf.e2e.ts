/** Opt-in Host creation profiling over the shipped Web composition and synthetic records. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session as InspectorSession } from 'node:inspector/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { chromium, type Request } from 'playwright'
import { SessionId, SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import { oneTurnLog } from '../../../packages/session/session-persistence/tests/contract.ts'
import { launchWebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

interface Sample {
  scenario: string
  totalMs: number
  cpuUs: number
  uiReadyMs?: number
  phases: Record<string, { calls: number; ms: number }>
}

const output = process.env.DSH_SESSION_CREATE_PROFILE_OUTPUT
const preset = process.env.DSH_SESSION_CREATE_PROFILE_PRESET ?? 'standard'

it.skipIf(output === undefined)('profiles fully initialized Host session creation and live blank reuse', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [], hmr: false, bundles: ['dsh-plugin-afp'] },
    agentPresets: { default: preset },
    extraOverlayPath: [
      fileURLToPath(new URL('./archive-settings.overlay.yml', import.meta.url)),
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    ],
  })
  onTestFinished(() => scaffold.close())
  const ctx = scaffold.ctx
  let active: Sample | undefined
  const samples: Sample[] = []
  const createdBlanks: SessionId[] = []
  const measure = async <T>(name: string, call: () => Promise<T>): Promise<T> => {
    const target = active
    const started = performance.now()
    try { return await call() } finally {
      if (target !== undefined) {
        const phase = target.phases[name] ??= { calls: 0, ms: 0 }
        phase.calls++
        phase.ms += performance.now() - started
      }
    }
  }
  const resolve = ctx.agentPresets.resolve.bind(ctx.agentPresets)
  vi.spyOn(ctx.agentPresets, 'resolve').mockImplementation(function (this: typeof ctx.agentPresets, ...args) {
    return measure('preset.resolve', () => resolve.apply(this, args))
  })
  const mount = ctx.agentPresets.mount.bind(ctx.agentPresets)
  vi.spyOn(ctx.agentPresets, 'mount').mockImplementation(function (this: typeof ctx.agentPresets, ...args) {
    return measure('preset.mount', () => mount.apply(this, args))
  })
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(function (this: typeof ctx.sessionPersistence, ...args) {
    return measure('persistence.create', async () => {
      const handle = await create.apply(this, args)
      const append = handle.append.bind(handle)
      vi.spyOn(handle, 'append').mockImplementation(function (this: typeof handle, ...values) {
        return measure('persistence.append', () => append.apply(this, values))
      })
      return handle
    })
  })
  const announce = ctx.agents.announce.bind(ctx.agents)
  vi.spyOn(ctx.agents, 'announce').mockImplementation(function (this: typeof ctx.agents, ...args) {
    return measure('agent.announce', () => announce.apply(this, args))
  })
  const agentCreate = ctx.agents.create.bind(ctx.agents)
  vi.spyOn(ctx.agents, 'create').mockImplementation(function (this: typeof ctx.agents, ...args) {
    return measure('agent.create', () => agentCreate.apply(this, args))
  })
  const list = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(function (this: typeof ctx.sessionPersistence, ...args) {
    return measure('persistence.list', () => list.apply(this, args))
  })
  const stat = ctx.sessionPersistence.stat.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'stat').mockImplementation(function (this: typeof ctx.sessionPersistence, ...args) {
    return measure('persistence.stat', () => stat.apply(this, args))
  })
  const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
  vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(function (this: typeof ctx.sessionQuery, ...args) {
    return measure('query.observe', () => observe.apply(this, args))
  })
  global.gc?.()
  const memoryBefore = process.memoryUsage()
  let projects = 0
  for (const count of [1, 24]) {
    while (projects < count) {
      const cwd = join(scaffold.workspaceCwd, `synthetic-project-${projects}`)
      await mkdir(cwd)
      const header: SessionHeader = { id: SessionId(`synthetic-${projects}`), cwd, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false }
      const handle = await ctx.sessionPersistence.create(header)
      await handle.append(oneTurnLog())
      await handle.close()
      projects++
    }
    const workspace = await ctx.workspaceRegistry.create(join(scaffold.workspaceCwd, 'synthetic-project-0'), 'Synthetic project')
    const attach = workspace.attachSession.bind(workspace)
    const attachment = vi.spyOn(workspace, 'attachSession').mockImplementation(function (this: typeof workspace, ...args) {
      return measure('workspace.attach', () => attach.apply(this, args))
    })
    let blank: SessionId | undefined
    for (const operation of ['new', 'reuse'] as const) {
      for (let index = 0; index < 6; index++) {
        const sample: Sample = { scenario: `${count}-projects/${operation}`, totalMs: 0, cpuUs: 0, phases: {} }
        active = sample
        const started = performance.now()
        const cpu = process.cpuUsage()
        const created = await ctx.sessionController.create({ workspaceId: workspace.id,
          ...(operation === 'reuse' && blank !== undefined ? { sessionId: blank } : {}),
        })
        sample.totalMs = performance.now() - started
        const used = process.cpuUsage(cpu)
        sample.cpuUs = used.user + used.system
        active = undefined
        expect(ctx.agents.get(created.sessionId)).toBeDefined()
        expect(created.agentPreset).toBe(preset)
        expect(workspace.sessionIds.includes(created.sessionId)).toBe(true)
        if (operation === 'reuse') expect(created.sessionId).toBe(blank)
        else { blank = created.sessionId; createdBlanks.push(blank) }
        samples.push(sample)
      }
    }
    attachment.mockRestore()
  }
  global.gc?.()
  const memoryAfter = process.memoryUsage()
  const peakRssKiB = process.resourceUsage().maxRSS
  const persistenceBuildSha256 = createHash('sha256').update(await readFile(
    fileURLToPath(new URL('../../../packages/session/session-persistence-jsonl/lib/index.js', import.meta.url)),
  )).digest('hex')
  const metadataBuildSha256 = createHash('sha256').update(await readFile(
    fileURLToPath(new URL('../../../packages/boot/app-boot/lib/index.js', import.meta.url)),
  )).digest('hex')
  const backgroundInventory = process.env.DSH_SESSION_CREATE_PROFILE_INVENTORY === '1'
  const report = { node: process.version, platform: process.platform, preset, persistenceBuildSha256, metadataBuildSha256,
    backgroundInventory, gc: global.gc !== undefined,
    endpoint: 'Host: live Agent and Workspace membership; browser: selected Session and editable composer accepting a draft',
    exclusions: 'profile boot, fixture construction, model and external network calls; Host samples also exclude HTTP and browser',
    memoryBefore, memoryAfter, peakRssKiB, samples,
  }
  if (output !== undefined) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (process.env.DSH_SESSION_CREATE_PROFILE_BROWSER === '1') {
    const profiler = process.env.DSH_SESSION_CREATE_PROFILE_CPU === '1' ? new InspectorSession() : undefined
    if (profiler !== undefined) {
      profiler.connect()
      onTestFinished(() => { profiler.disconnect() })
      await profiler.post('Profiler.enable')
      await profiler.post('Profiler.start')
    }
    for (const id of createdBlanks) await ctx.workspaceRegistry.archiveSession(id)
    const workspace = await ctx.workspaceRegistry.create(join(scaffold.workspaceCwd, 'synthetic-project-0'), 'Synthetic project')
    await workspace.attachSession(SessionId('synthetic-0'))
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEnglishPage(browser)
    const pending = new Map<Request, { sample: Sample; started: number; method: string }>()
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (active === undefined || !path.startsWith('/api/')) return
      pending.set(request, { sample: active, started: performance.now(), method: path.slice(5) })
    })
    page.on('requestfinished', (request) => {
      const call = pending.get(request)
      if (call === undefined) return
      const phase = call.sample.phases[`rpc:${call.method}`] ??= { calls: 0, ms: 0 }
      phase.calls++
      phase.ms += performance.now() - call.started
      pending.delete(request)
    })
    page.on('requestfailed', (request) => { pending.delete(request) })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-dsh-boot]').waitFor({ state: 'detached' })
    const current = page.locator('[data-row-key="session:synthetic-0"]')
    await current.click()
    await page.locator('[data-row-key="session:synthetic-0"][aria-selected="true"]').waitFor()
    await page.locator('[data-composer-input][contenteditable="true"]').fill('Synthetic baseline draft')
    for (const id of workspace.sessionIds) {
      if (id !== SessionId('synthetic-0')) {
        await ctx.workspaceRegistry.archiveSession(id)
        await page.locator(`[data-row-key="session:${id}"]`).waitFor({ state: 'detached' })
      }
    }
    let target: SessionId | undefined
    let targetReady = Promise.withResolvers<SessionId>()
    let inventoryRefresh: Promise<unknown> | undefined
    const attach = workspace.attachSession.bind(workspace)
    vi.spyOn(workspace, 'attachSession').mockImplementation(function (this: typeof workspace, ...args) {
      target = args[0]
      targetReady.resolve(target)
      const attached = measure('workspace.attach', () => attach.apply(this, args))
      if (active !== undefined && backgroundInventory) {
        inventoryRefresh = measure('background.inventory', () => Promise.all([
          ctx.pluginManager.listPlugins(), ctx.pluginManager.listBundles(),
        ]))
      }
      return attached
    })
    for (const operation of ['new', 'reuse'] as const) {
      const attempts = backgroundInventory ? 3 : 6
      for (let index = 0; index < attempts; index++) {
        await current.click()
        await page.locator('[data-row-key="session:synthetic-0"][aria-selected="true"]').waitFor()
        await page.locator(`[data-row-key="workspace:${workspace.id}"]`).hover()
        const button = page.locator('button[aria-label="New session in Synthetic project"]')
        const readiness = await button.evaluateHandle((element) => {
          const ready = Promise.withResolvers<number>()
          element.addEventListener('pointerdown', () => {
            const started = performance.now()
            const observer = new MutationObserver(() => {
              const selected = document.querySelector('[data-row-key^="session:"][aria-selected="true"]')
              const editor = document.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')
              if (selected === null || selected.getAttribute('data-row-key') === 'session:synthetic-0'
                || editor === null || editor.getClientRects().length === 0 || editor.closest('[inert]') !== null) return
              observer.disconnect()
              requestAnimationFrame(() => { ready.resolve(performance.now() - started) })
            })
            observer.observe(document.body, { childList: true, subtree: true, attributes: true })
          }, { once: true })
          return { ready: ready.promise }
        })
        target = undefined
        targetReady = Promise.withResolvers<SessionId>()
        const sample: Sample = { scenario: `24-projects/browser-${operation}`, totalMs: 0, cpuUs: 0, phases: {} }
        active = sample
        const started = performance.now()
        const cpu = process.cpuUsage()
        await measure('browser.click', () => button.click())
        await measure('browser.hostTarget', () => targetReady.promise)
        await measure('browser.selection', () => page.locator(`[data-row-key="session:${target}"][aria-selected="true"]`).waitFor())
        const editor = page.locator('[data-composer-input][contenteditable="true"]')
        await measure('browser.draft', () => editor.fill('Synthetic unsent draft'))
        sample.uiReadyMs = await readiness.evaluate(value => value.ready)
        await readiness.dispose()
        sample.totalMs = performance.now() - started
        const used = process.cpuUsage(cpu)
        sample.cpuUs = used.user + used.system
        active = undefined
        samples.push(sample)
        await inventoryRefresh
        if (operation === 'new' && index < attempts - 1 && target !== undefined) {
          await current.click()
          await ctx.workspaceRegistry.archiveSession(target)
        }
      }
    }
    if (profiler !== undefined && output !== undefined) {
      const { profile } = await profiler.post('Profiler.stop')
      await writeFile(`${output}.cpuprofile`, JSON.stringify(profile), 'utf8')
    }
  }
  if (output !== undefined) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}, 180_000)
