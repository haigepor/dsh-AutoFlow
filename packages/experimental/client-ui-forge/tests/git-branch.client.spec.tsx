// @vitest-environment jsdom
/** User control of generated commit drafts, selected-file commits, and write restrictions. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { GitBranch, type GitBranchProps } from '../src/client/GitBranch.tsx'
import { en } from '../src/client/locales.ts'
import type { PanelSnapshot } from '../src/client/source.ts'
import type { ForgeGitStatus } from '../src/types.ts'
import { ready, worktree } from './client-fixtures.client.ts'

afterEach(cleanup)
const STATUS: ForgeGitStatus = {
  root: '/work/repo', branch: 'main', head: 'a'.repeat(40), upstream: null, ahead: null, behind: null,
  remotes: ['origin'], blocker: null,
  files: [{ path: 'tracked.txt', originalPath: null, index: ' ', worktree: 'M', conflicted: false }],
}
const OK: RemoteResult<void> = { ok: true, value: undefined }

async function fixture(status = STATUS, running = false) {
  const panel = createSnapshotStore<PanelSnapshot>({ state: ready(), disconnected: false })
  const props = {
    usePanel: bindSnapshotSelector(panel),
    useSession: bindSnapshotSelector(createSnapshotStore({ ...sessionSnapshot(SessionId('git-ui')), running })),
    useAccess: () => true,
    read: vi.fn(async (): Promise<RemoteResult<ForgeGitStatus>> => ({ ok: true, value: status })),
    branches: vi.fn(async () => ({ ok: true as const, value: { current: 'main', branches: ['main', 'release'] } })),
    commit: vi.fn(async () => OK), push: vi.fn(async () => OK), switchBranch: vi.fn(async () => OK),
    generate: vi.fn(async (): Promise<RemoteResult<string>> => ({ ok: true, value: 'Update tracked content' })),
    viewChanges: vi.fn(), viewCheckout: vi.fn(), report: vi.fn(), t: makeTranslate(en),
    worktree: {
      request: vi.fn(async () => true), cancel: vi.fn(async () => true),
      branches: vi.fn(async () => ({ current: 'main', branches: ['main', 'release'] })),
    },
  } satisfies GitBranchProps
  render(<GitBranch {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Git branch: main' }))
  if (status.files.length > 0) await screen.findByRole('checkbox', { name: 'tracked.txt' })
  else await screen.findByText(en['git.clean'])
  await waitFor(() => { expect(screen.getByRole('button', { name: en.refresh }).hasAttribute('disabled')).toBe(false) })
  return { ...props, panel }
}

it('keeps inspection failures reachable and hides confirmed non-Git directories', async () => {
  const f = await fixture()
  act(() => { f.panel.set({ state: ready({ checkout: { state: 'failed', message: 'Git inspection was denied' } }), disconnected: false }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en['checkout.failed'] }))
  expect(f.viewCheckout).toHaveBeenCalledOnce()
  expect(f.commit).not.toHaveBeenCalled()
  act(() => { f.panel.set({ state: ready({ checkout: { state: 'none' } }), disconnected: false }) })
  expect(screen.queryByRole('button')).toBeNull()
})

it('offers worktree creation inside the Git dialog without repeating the current branch', async () => {
  const f = await fixture()
  act(() => { f.panel.set({ state: ready({ worktree: worktree({ editable: true }) }), disconnected: false }) })
  expect(screen.queryByRole('button', { name: 'Current branch: main' })).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: en['worktree.label'] }))
  await waitFor(() => { expect(f.worktree.request).toHaveBeenCalledWith('main') })
  act(() => { f.panel.set({ state: ready({ worktree: worktree({ editable: true, request: { from: 'release' } }) }), disconnected: false }) })
  fireEvent.click(screen.getByRole('button', { name: 'From release' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'mainCurrent' }))
  await waitFor(() => { expect(f.worktree.request).toHaveBeenLastCalledWith('main') })
  fireEvent.click(screen.getByRole('checkbox', { name: en['worktree.label'] }))
  await waitFor(() => { expect(f.worktree.cancel).toHaveBeenCalledOnce() })
})

it('keeps a clean checkout compact while leaving push and branch switching available', async () => {
  await fixture({ ...STATUS, files: [] })
  expect(screen.getByText(en['git.clean'])).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: en['git.message'] })).toBeNull()
  expect(screen.queryByRole('button', { name: en['git.commit'] })).toBeNull()
  expect(screen.getByRole('button', { name: en['git.push'] })).toHaveProperty('disabled', false)
  expect(screen.getByRole('button', { name: en['git.switch'] })).toHaveProperty('disabled', false)
})

it('shows the complete branch name and explains when a search has no matches', async () => {
  const status = { ...STATUS, files: [] }
  const f = await fixture(status)
  const branch = 'feature/a-long-current-branch-name-for-mobile-review'
  f.branches.mockResolvedValue({ ok: true, value: { current: 'main', branches: ['main', branch] } })
  fireEvent.click(screen.getByRole('button', { name: en['git.switch'] }))
  expect(await screen.findByRole('menuitem', { name: branch })).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: en['git.search'] }), { target: { value: 'no-such-branch' } })
  expect(screen.getByText(en['git.noBranches'])).toBeTruthy()
  expect(screen.queryByRole('menuitem')).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: en['git.search'] }), { target: { value: 'mobile-review' } })
  fireEvent.click(screen.getByRole('menuitem', { name: branch }))
  await waitFor(() => { expect(f.switchBranch).toHaveBeenCalledWith(status, branch) })
})

it('generates an editable draft for selected files and waits for the user to commit', async () => {
  const f = await fixture()
  fireEvent.click(screen.getByRole('checkbox', { name: 'tracked.txt' }))
  fireEvent.click(screen.getByRole('button', { name: en['git.generate'] }))
  const message = screen.getByRole('textbox', { name: en['git.message'] })
  await waitFor(() => { expect(message).toHaveProperty('value', 'Update tracked content') })
  expect(f.generate).toHaveBeenCalledWith(STATUS, ['tracked.txt'])
  expect(f.commit).not.toHaveBeenCalled()
  expect(f.push).not.toHaveBeenCalled()
  fireEvent.change(message, { target: { value: 'My edited message' } })
  await waitFor(() => { expect(screen.getByRole('button', { name: en['git.commit'] }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: en['git.commit'] }))
  await waitFor(() => { expect(f.commit).toHaveBeenCalledWith(STATUS, ['tracked.txt'], 'My edited message') })
})

it('preserves the user draft and selection when generation fails', async () => {
  const f = await fixture()
  f.generate.mockResolvedValue({ ok: false, error: new RemoteError('forgePanel/git-message-failed', 'model unavailable', {}) })
  const message = screen.getByRole('textbox', { name: en['git.message'] })
  fireEvent.change(message, { target: { value: 'Keep this draft' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'tracked.txt' }))
  fireEvent.click(screen.getByRole('button', { name: en['git.generate'] }))
  await screen.findByRole('alert')
  expect(message).toHaveProperty('value', 'Keep this draft')
  expect(screen.getByRole('checkbox', { name: 'tracked.txt' })).toHaveProperty('checked', true)
  expect(f.commit).not.toHaveBeenCalled()
})

it.each([['read-only', false], [null, true]] as const)('blocks Git writes with blocker %s while running=%s', async (blocker, running) => {
  const f = await fixture({ ...STATUS, blocker }, running)
  fireEvent.click(screen.getByRole('checkbox', { name: 'tracked.txt' }))
  fireEvent.change(screen.getByRole('textbox', { name: en['git.message'] }), { target: { value: 'Cannot commit' } })
  expect(screen.getByRole('button', { name: en['git.commit'] })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: en['git.push'] })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: en['git.switch'] })).toHaveProperty('disabled', true)
  expect(f.commit).not.toHaveBeenCalled()
})
