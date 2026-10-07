// @vitest-environment jsdom
// The hero suggestion cards: four category cards expanding their two task
// chips, prefill outcomes driving the status hints, the toggle-off gesture,
// and the draft-present hidden/disabled posture. Partitions hide through
// `visibility` (shared grid cell), so activation reads `data-active`, not
// element presence.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { HeroSuggestions } from '../src/client/skeleton/HeroSuggestions.tsx'
import type { HeroSuggestionsProps } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/suggestion-locales.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

afterEach(cleanup)

function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
  }))
}

function noPendingInteraction() {
  return bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map()))
}

function mount(prefill: HeroSuggestionsProps['prefill'], draftPresent = false) {
  const props: HeroSuggestionsProps = {
    draftPresent,
    prefill,
    useWorkspaces: bindSnapshotSelector(createSnapshotStore<WorkspaceSnapshot>({
      items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    })),
    usePanelInfo: selector => selector({ activePanelId: null }),
    useSessions: emptySessions(),
    useSessionStatus: noPendingInteraction(),
    useSessionRetainInfo: () => undefined,
    useResource,
    t: makeTranslate(zh),
  }
  return render(<HeroSuggestions {...props} />)
}

function taskPartition(taskLabel: string): HTMLElement {
  return screen.getByText(taskLabel).closest('[data-active]')!
}

describe('hero suggestions', () => {
  it('renders the four category cards under the row label', () => {
    mount(() => 'ready')
    expect(screen.getByLabelText('开始一项任务')).toBeDefined()
    expect(screen.getByText('探索并理解代码')).toBeDefined()
    expect(screen.getByText('构建新功能、应用或工具')).toBeDefined()
    expect(screen.getByText('审查代码并提出修改建议')).toBeDefined()
    expect(screen.getByText('修复问题和失败')).toBeDefined()
  })

  it('expands a category\'s task chips on pick and toggles them off on re-pick', () => {
    mount(() => 'ready')
    expect(taskPartition('了解项目结构').getAttribute('data-active')).toBe('false')
    fireEvent.click(screen.getByText('探索并理解代码'))
    expect(taskPartition('了解项目结构').getAttribute('data-active')).toBe('true')
    expect(taskPartition('理解一项功能').getAttribute('data-active')).toBe('true')
    expect(taskPartition('排查一个问题').getAttribute('data-active')).toBe('false')
    fireEvent.click(screen.getByText('探索并理解代码'))
    expect(taskPartition('了解项目结构').getAttribute('data-active')).toBe('false')
  })

  it('prefills with the prompt text and stays hint-free on ready', () => {
    const prefill = vi.fn(() => 'ready' as const)
    mount(prefill)
    fireEvent.click(screen.getByText('探索并理解代码'))
    fireEvent.click(screen.getByText('了解项目结构'))
    expect(prefill).toHaveBeenCalledWith('请探索当前工作区的代码，解释项目结构、主要入口和模块之间的关系。')
    for (const hint of ['请先选择工作区，再选择任务。', '当前输入正在处理中，请稍后再试。']) {
      expect(screen.getByText(hint).getAttribute('data-active')).toBe('false')
      expect(screen.getByText(hint).getAttribute('role')).toBeNull()
    }
  })

  it('announces the workspace prerequisite and the busy state through the status hint', () => {
    const workspace = vi.fn(() => 'workspace' as const)
    mount(workspace)
    fireEvent.click(screen.getByText('修复问题和失败'))
    fireEvent.click(screen.getByText('排查一个问题'))
    expect(screen.getByText('请先选择工作区，再选择任务。').getAttribute('data-active')).toBe('true')
    expect(screen.getByText('请先选择工作区，再选择任务。').getAttribute('role')).toBe('status')
    cleanup()
    const busy = vi.fn(() => 'busy' as const)
    mount(busy)
    fireEvent.click(screen.getByText('审查代码并提出修改建议'))
    fireEvent.click(screen.getByText('评审当前改动'))
    expect(screen.getByText('当前输入正在处理中，请稍后再试。').getAttribute('data-active')).toBe('true')
    expect(screen.getByText('当前输入正在处理中，请稍后再试。').getAttribute('role')).toBe('status')
  })

  it('hides the row and disables every control while a draft is present', () => {
    mount(() => 'ready', true)
    const row = screen.getByLabelText('开始一项任务')
    expect(row.getAttribute('aria-hidden')).toBe('true')
    expect(row.getAttribute('data-has-draft')).toBe('true')
    for (const card of ['探索并理解代码', '构建新功能、应用或工具', '审查代码并提出修改建议', '修复问题和失败']) {
      // The row hides through aria-hidden; byRole needs hidden to see it.
      expect(screen.getByRole('button', { name: card, hidden: true }).hasAttribute('disabled')).toBe(true)
    }
    expect(screen.getByRole('button', { name: '了解项目结构', hidden: true }).hasAttribute('disabled')).toBe(true)
  })
})
