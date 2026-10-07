import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentPresetSectionController } from '../src/client/section-store.ts'

function fixture() {
  const remote = { agentPresets: {
    list: vi.fn(async () => ({ ok: true as const, value: { presets: [{ id: 'standard', isDefault: true }] } })),
    read: vi.fn(async (id: string) => ({ ok: true as const, value: { agentPreset: id, name: 'Standard', content: '- name: fs\n' } })),
  }, settings: { update: vi.fn(async () => ({ ok: true as const, value: {} })) } }
  const controller = new AgentPresetSectionController({ remote } as never)
  return { remote, controller, state: () => controller.store.getSnapshot() }
}

describe('the preset roster', () => {
  afterEach(() => { vi.useRealTimers() })
  it('announces a shared initial read, clears retry errors and retains rows during refresh', async () => {
    const { controller, remote, state } = fixture()
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof remote.agentPresets.list>>>()
    remote.agentPresets.list.mockImplementationOnce(() => gate.promise)
    const initial = controller.load()
    expect(state()).toMatchObject({ status: 'loading', rows: [], error: null })
    expect(controller.load()).toBe(initial)
    gate.resolve({ ok: true, value: { presets: [{ id: 'standard', isDefault: true }] } })
    await initial
    const rows = state().rows
    remote.agentPresets.list.mockRejectedValueOnce(new Error('disconnected'))
    await controller.load()
    expect(state()).toMatchObject({ status: 'error', error: 'disconnected', rows })
    remote.agentPresets.list.mockImplementationOnce(() => gate.promise)
    const retry = controller.load()
    expect(state()).toMatchObject({ status: 'loading', error: null })
    expect(state().rows).toBe(rows)
    await retry
    expect(state().status).toBe('ready')
  })
  it('updates the confirmed default before a delayed roster refresh and verifies it before syncing', async () => {
    vi.useFakeTimers()
    const { controller, remote, state } = fixture()
    remote.agentPresets.list.mockResolvedValue({ ok: true, value: { presets: [
      { id: 'standard', isDefault: false }, { id: 'ptc', isDefault: true },
    ] } })
    remote.agentPresets.list.mockResolvedValueOnce({ ok: true, value: { presets: [
      { id: 'standard', isDefault: true }, { id: 'ptc', isDefault: false },
    ] } })
    await controller.load()
    const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })
    remote.settings.update.mockImplementationOnce(async () => { await wait(100); return { ok: true, value: {} } })
    remote.agentPresets.list.mockImplementationOnce(async () => {
      await wait(300)
      return { ok: true, value: { presets: [{ id: 'ptc', isDefault: true }] } }
    })
    const sync = vi.fn(async () => { await wait(200); return undefined })
    const pending = controller.makeDefault('ptc', sync)
    await vi.advanceTimersByTimeAsync(100)
    expect(state().rows.find(row => row.isDefault)?.id).toBe('ptc')
    expect(state().saving).toBe(true)
    expect(sync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(sync).toHaveBeenCalledWith('ptc')
    await vi.advanceTimersByTimeAsync(200)
    await pending
    expect(state()).toMatchObject({ saving: false, pendingId: null, error: null })
  })

  it('discards a pre-write roster response and syncs only the freshly verified default', async () => {
    const { controller, remote, state } = fixture()
    await controller.load()
    const older = Promise.withResolvers<Awaited<ReturnType<typeof remote.agentPresets.list>>>()
    remote.agentPresets.list.mockImplementationOnce(() => older.promise)
    const refresh = controller.load()
    remote.agentPresets.list.mockResolvedValueOnce({ ok: true, value: { presets: [{ id: 'ptc', isDefault: true }] } })
    const sync = vi.fn(async () => undefined)
    const pending = controller.makeDefault('ptc', sync)
    await vi.waitFor(() => { expect(state().saving).toBe(true); expect(remote.settings.update).toHaveBeenCalledOnce() })
    older.resolve({ ok: true, value: { presets: [{ id: 'standard', isDefault: true }] } })
    await Promise.all([refresh, pending])
    expect(remote.agentPresets.list).toHaveBeenCalledTimes(3)
    expect(state().rows).toEqual([{ id: 'ptc', isDefault: true }])
    expect(sync).toHaveBeenCalledWith('ptc')
  })

  it('clears pending feedback after a refused save without claiming the requested default', async () => {
    const { controller, remote, state } = fixture()
    await controller.load()
    remote.settings.update.mockResolvedValueOnce({ ok: false, error: { message: 'read only' } } as never)
    const sync = vi.fn(async () => undefined)
    await controller.makeDefault('ptc', sync)
    expect(state()).toMatchObject({ saving: false, pendingId: null, error: 'read only', rows: [{ id: 'standard', isDefault: true }] })
    expect(sync).not.toHaveBeenCalled()
  })

  it('keeps a confirmed default and skips session sync when roster verification fails', async () => {
    const { controller, remote, state } = fixture()
    remote.agentPresets.list.mockResolvedValueOnce({ ok: true, value: { presets: [
      { id: 'standard', isDefault: true }, { id: 'ptc', isDefault: false },
    ] } })
    await controller.load()
    remote.agentPresets.list.mockRejectedValueOnce(new Error('roster disconnected'))
    const sync = vi.fn(async () => undefined)
    await controller.makeDefault('ptc', sync)
    expect(state()).toMatchObject({ saving: false, pendingId: null, status: 'error', error: 'roster disconnected' })
    expect(state().rows.find(row => row.isDefault)?.id).toBe('ptc')
    expect(sync).not.toHaveBeenCalled()
  })
  it('shows the requested card immediately while keeping the saved default until confirmation', async () => {
    const { controller, remote, state } = fixture()
    await controller.load()
    const write = Promise.withResolvers<Awaited<ReturnType<typeof remote.settings.update>>>()
    remote.settings.update.mockImplementationOnce(() => write.promise)
    const pending = controller.makeDefault('minimal')
    expect(state()).toMatchObject({ saving: true, pendingId: 'minimal', rows: [{ id: 'standard', isDefault: true }] })
    write.resolve({ ok: true, value: {} })
    await pending
    expect(state()).toMatchObject({ saving: false, pendingId: null })
  })
  it('reads the roster once for simultaneous loads and surfaces failed reads', async () => {
    const { controller, remote, state } = fixture()
    await Promise.all([controller.load(), controller.load()])
    expect(remote.agentPresets.list).toHaveBeenCalledOnce()
    expect(state()).toMatchObject({ status: 'ready', rows: [{ id: 'standard', isDefault: true }], view: null })
    remote.agentPresets.list.mockRejectedValueOnce(new Error('offline'))
    await controller.load()
    expect(state()).toMatchObject({ status: 'error', error: 'offline' })
    remote.agentPresets.list.mockResolvedValueOnce({ ok: false, error: { message: 'refused' } } as never)
    await controller.load()
    expect(state().error).toBe('refused')
    remote.agentPresets.list.mockRejectedValueOnce('gone')
    await controller.load()
    expect(state().error).toBe('gone')
  })

  it('opens one declared composition for reading and keeps a failed read out of the viewer', async () => {
    const { controller, remote, state } = fixture()
    await controller.view('standard')
    expect(remote.agentPresets.read).toHaveBeenCalledWith('standard')
    expect(state().view).toEqual({ id: 'standard', title: 'Standard', content: '- name: fs\n' })
    controller.closeView()
    expect(state().view).toBeNull()
    remote.agentPresets.read.mockResolvedValueOnce({ ok: true, value: { agentPreset: 'mine', content: '[]\n' } } as never)
    await controller.view('mine')
    expect(state().view).toEqual({ id: 'mine', title: 'mine', content: '[]\n' })
    remote.agentPresets.read.mockResolvedValueOnce({ ok: false, error: { message: 'Unknown agent preset: gone' } } as never)
    await controller.view('gone')
    expect(state()).toMatchObject({ view: null, error: 'Unknown agent preset: gone' })
    remote.agentPresets.read.mockRejectedValueOnce(new Error('offline'))
    await controller.view('standard')
    expect(state()).toMatchObject({ view: null, error: 'offline' })
  })

  it('ignores a read that settles after the viewer closes or a newer read opens', async () => {
    const { controller, remote, state } = fixture()
    const late = Promise.withResolvers<Awaited<ReturnType<typeof remote.agentPresets.read>>>()
    remote.agentPresets.read.mockImplementationOnce(() => late.promise)
    const first = controller.view('standard')
    controller.closeView()
    late.resolve({ ok: true, value: { agentPreset: 'standard', name: 'Standard', content: 'old' } })
    await first
    expect(state().view).toBeNull()

    const failed = Promise.withResolvers<Awaited<ReturnType<typeof remote.agentPresets.read>>>()
    remote.agentPresets.read.mockImplementationOnce(() => failed.promise)
    const stale = controller.view('standard')
    await controller.view('mine')
    failed.reject(new Error('stale read'))
    await stale
    expect(state()).toMatchObject({ error: null, view: { id: 'mine', content: '- name: fs\n' } })
  })

  it('keeps default selection and blank-session synchronization on their existing settings path', async () => {
    const { controller, remote, state } = fixture()
    const sync = vi.fn(async () => undefined)
    await controller.makeDefault('standard', sync)
    expect(remote.settings.update).toHaveBeenCalledWith('agent-preset-registry', { selectedDefault: 'standard' }, undefined)
    expect(sync).toHaveBeenCalledWith('standard')
    remote.settings.update.mockRejectedValueOnce(new Error('read only'))
    await controller.makeDefault('minimal')
    expect(state()).toMatchObject({ saving: false, error: 'read only' })
  })

  it('prevents a second default write and reports blank-session synchronization failures', async () => {
    const { controller, remote, state } = fixture()
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    remote.settings.update.mockImplementationOnce(async () => { await wait; return { ok: true, value: {} } })
    const pending = controller.makeDefault('standard', async () => 'Session already started')
    await controller.makeDefault('standard')
    expect(remote.settings.update).toHaveBeenCalledOnce()
    release()
    await pending
    expect(state().error).toBe('Session already started')
  })

  it('skips blank-session synchronization when the roster marks no default', async () => {
    const { controller, remote } = fixture()
    const sync = vi.fn(async () => undefined)
    remote.agentPresets.list.mockResolvedValueOnce({ ok: true, value: { presets: [{ id: 'standard', isDefault: false }] } })

    await controller.makeDefault('standard', sync)

    expect(remote.settings.update).toHaveBeenCalledOnce()
    expect(sync).not.toHaveBeenCalled()
  })
})
