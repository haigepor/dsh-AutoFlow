/** Host-side AFP preset entry points and same-Session switching through the shipped Web composition. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspaceZh, openSettings, writeComposerDraft } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/afp-agent', import.meta.url))

class AfpAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private historyRead = false
  pauseNext: { arrived: PromiseWithResolvers<undefined>; release: PromiseWithResolvers<undefined> } | undefined
  override async listModels(provider: string) { return [{ provider, id: 'fixture', name: 'AFP fixture', contextWindow: 128_000 }] }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const paused = this.pauseNext
    if (paused !== undefined) {
      this.pauseNext = undefined
      paused.arrived.resolve(undefined)
      await paused.release.promise
      options.signal?.throwIfAborted()
    } else if (options.tools?.some(tool => tool.name === 'afp_operation_apply')
      && (options.messages.at(-1)?.role === 'user' || !this.historyRead)) {
      const history = options.messages.at(-1)?.role !== 'user'
      this.historyRead ||= history
      const block = { type: 'tool-call' as const, id: ToolCallId(history ? 'afp-history' : 'afp-search-plan'), name: history ? 'afp_history' : 'afp_search_plan',
        arguments: JSON.stringify(history ? { kind: 'runs', offset: 0, limit: 5 } : { query: 'landscape' }) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = 'AFP fixture completed.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('selects AFP manually or by plugin mention, completes a native tool turn and switches the existing Session after active work', async () => {
  const scaffold = await launchWebScaffold({ developerTools: true, profile: { packages: [], bundles: ['dsh-plugin-afp'] },
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)) })
  const adapter = new AfpAdapter()
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['afp-fixture'], adapter), 'AFP keyless browser adapter')
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'afp-fixture', model: 'fixture' })
    const roster = await scaffold.ctx.agentPresets.list()
    expect(roster.find(row => row.id === 'afp-curator')).toMatchObject({ id: 'afp-curator' })
    expect(roster.find(row => row.id === 'afp-curator')?.name).toBeUndefined()
    expect(roster.find(row => row.id === 'afp-curator')?.broken).toBeUndefined()
    await using afpScope = await scaffold.ctx.agentPresets.acquireScope('afp-curator')
    expect(scaffold.ctx.tools.schemas(afpScope.key).map(tool => tool.name)).toContain('afp_collection_plan')
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    await page.addInitScript(() => { localStorage.setItem('dsh.locale', 'zh') })
    const console = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(page, 'zh')
    const settings = page.locator('[data-settings-page]')
    await settings.getByRole('button', { name: 'Agent 预设', exact: true }).click()
    const afpCard = page.locator('[data-agent-preset-id="afp-curator"]')
    await afpCard.waitFor()
    expect(await afpCard.locator('xpath=ancestor::section[1]').locator('h3').textContent()).toBe('内置')
    expect(await page.locator('[data-agent-preset-id]').count()).toBe(5)
    await expect.poll(() => afpCard.locator('img[data-preset-art="afp-curator"]').evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 256)).toBe(true)
    await afpCard.getByRole('button', { name: '模式说明: AFP 策展助手', exact: true }).click()
    await page.getByRole('dialog').getByRole('heading', { name: '搜索与视觉筛选', exact: true }).waitFor()
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).last().click()
    await afpCard.getByRole('button', { name: '如何使用: AFP 策展助手', exact: true }).click()
    await page.getByRole('dialog').getByText('只把我选中的图片加入 X 收藏夹', { exact: false }).waitFor()
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).last().click()
    await settings.getByRole('button', { name: '返回', exact: true }).click()
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: '标准模式', exact: true }).click()
    const picker = page.getByRole('menu')
    expect(await picker.getByRole('menuitem', { name: /^标准模式/ }).count()).toBe(1)
    expect(await picker.getByRole('menuitem', { name: /^创造模式/ }).count()).toBe(1)
    await picker.getByRole('menuitem', { name: /^AFP 策展助手/ }).click()
    await page.getByRole('button', { name: 'AFP 策展助手', exact: true }).waitFor()
    await page.getByRole('button', { name: 'AFP 策展助手', exact: true }).click()
    await page.getByRole('menuitem', { name: /^标准模式/ }).click()
    const input = page.locator('[data-composer-input]').first()
    const baselineSettled = scaffold.whenTurnSettled()
    await writeComposerDraft(page, input, '记录当前对话基线')
    await input.press('Enter')
    const baselineSession = await baselineSettled
    await writeComposerDraft(page, input, '@afp')
    await page.getByRole('option', { name: /AFP 图片策展/ }).click()
    await page.getByRole('button', { name: 'AFP 策展助手', exact: true }).waitFor()
    const settled = scaffold.whenTurnSettled()
    await input.press('End')
    await page.keyboard.insertText(' 规划风景图片搜索')
    await input.press('Enter')
    const sessionId = await settled
    expect(sessionId).toBe(baselineSession)
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('AFP Session did not retain its Agent')
    expect(scaffold.ctx.agentPresets.composedPreset(agent.ctx)).toBe('afp-curator')
    const firstAfpRequest = adapter.requests[1]!
    const afpNames = firstAfpRequest.tools!.map(tool => tool.name).sort()
    for (const name of ['afp_photo_selection', 'afp_refresh', 'afp_collection_plan', 'afp_operation_apply', 'afp_download_plan', 'afp_run_items', 'job_output', 'skill']) {
      expect(afpNames).toContain(name)
    }
    expect(afpNames.filter(name => !name.startsWith('afp_'))).toEqual([
      'ask_user_question', 'job_kill', 'job_list', 'job_output', 'read', 'skill', 'todo_write',
    ])
    expect(firstAfpRequest.messages[0]?.content.some(block => block.type === 'text'
      && block.text.includes('AFP photo search and curation specialist'))).toBe(true)
    const contextBudget = (request: GenerateOptions) => {
      // The repository token meter uses four characters per token, plus framing.
      const system = request.messages.filter(message => message.role === 'system')
        .flatMap(message => message.content).map(block => block.type === 'text' ? block.text : JSON.stringify(block)).join('')
      return {
        systemEstimatedTokens: Math.ceil(system.length / 4) + 4,
        toolEstimatedTokens: Math.ceil(JSON.stringify(request.tools).length / 4) + 4,
      }
    }
    process.stdout.write(`AFP context estimates: ${JSON.stringify({ standard: contextBudget(adapter.requests[0]!), specialist: contextBudget(firstAfpRequest) })}\n`)
    const events = agent.session.snapshotEvents()
    expect(events.some(event => event.type === 'tool/result' && !event.data.message.isError)).toBe(true)
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['afp_search_plan', 'afp_history'])
    expect(events.filter(event => event.type === 'tool/result').every(event => !event.data.message.isError)).toBe(true)
    await page.getByRole('button', { name: 'AFP 策展助手', exact: true }).click()
    await page.getByRole('menuitem', { name: /^标准模式/ }).click()
    await page.getByRole('button', { name: '标准模式', exact: true }).waitFor()
    expect(scaffold.ctx.agents.get(sessionId)).toBe(agent)
    expect(agent.session.snapshotEvents().slice(0, events.length)).toEqual(events)
    const standardNames = scaffold.ctx.tools.schemas(agent).map(tool => tool.name)
    expect(standardNames).not.toContain('afp_operation_apply')
    expect(standardNames).toContain('afp_photo_search_start')
    expect(standardNames).toEqual(expect.arrayContaining(adapter.requests[0]!.tools!.map(tool => tool.name)))
    expect((await scaffold.ctx.agentPresets.resolve()).id).toBe('standard')
    await page.getByRole('button', { name: '标准模式', exact: true }).click()
    await page.getByRole('menuitem', { name: /^AFP 策展助手/ }).click()
    await page.getByRole('button', { name: 'AFP 策展助手', exact: true }).waitFor()

    const gate = { arrived: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() }
    adapter.pauseNext = gate
    const nextSettled = scaffold.whenTurnSettled()
    await writeComposerDraft(page, input, '继续当前 AFP 任务')
    await input.press('Enter')
    await gate.arrived.promise
    try {
      await page.getByRole('button', { name: 'AFP 策展助手', exact: true }).click()
      await page.getByRole('menuitem', { name: /^标准模式/ }).click()
      await page.getByRole('button', { name: '切换中…', exact: true }).waitFor()
      expect(scaffold.ctx.agentPresets.composedPreset(agent.ctx)).toBe('afp-curator')
    } finally { gate.release.resolve(undefined) }
    expect(await nextSettled).toBe(sessionId)
    await page.getByRole('button', { name: '标准模式', exact: true }).waitFor()
    expect(scaffold.ctx.agentPresets.composedPreset(agent.ctx)).toBe('standard')
    await page.setViewportSize({ width: 420, height: 900 })
    const header = page.getByRole('button', { name: '标准模式', exact: true })
    expect(await header.isVisible()).toBe(true)
    await header.focus()
    await header.press('Enter')
    await page.getByRole('menuitem', { name: /^AFP 策展助手/ }).waitFor()
    await page.keyboard.press('Escape')
    expect(await header.evaluate(element => element === document.activeElement)).toBe(true)

    const summary = agent.session.snapshotEvents().flatMap<Record<string, unknown>>((event) => {
      if (event.type === 'agent-preset/selected') return [{ type: event.type, agentPreset: event.data.agentPreset }]
      if (event.type === 'tool/call') return [{ type: event.type, name: event.data.name, arguments: event.data.arguments }]
      if (event.type === 'turn/end') return [{ type: event.type, turn: event.data.turn, reason: event.data.reason }]
      return []
    })
    await compareOrRefreshGolden(join(EXPECTED, 'session.expected.md'), JSON.stringify({ events: summary, afpTools: afpNames }, null, 2), webSnapshotMode())
    await compareOrRefreshGolden(join(EXPECTED, 'header.expected.md'), await captureStableAria(page, 'button[title^="切换当前对话"]', scaffold.workspaceCwd), webSnapshotMode())
    expect(console.pageErrors).toEqual([])
  } finally {
    adapter.pauseNext?.release.resolve(undefined)
    await browser?.close()
    await scaffold.close()
  }
})
