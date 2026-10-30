// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SkillManagementSnapshot, SkillDirectoryId, ManagedSkillId } from '@deepseek-ai/dsh-skill-manager/types'
import { SkillSettings } from '../src/client/SkillSettings.tsx'
import type { SkillSettingsProps } from '../src/client/contract.ts'
import { createSkillSettingsStore } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
)
function fixture() {
  const state = createSkillSettingsStore().create()
  const snapshot: SkillManagementSnapshot = {
    complete: true,
    limits: { maxBytes: 1024 * 1024, maxFiles: 100 },
    categories: [],
    workspaces: [],
    directories: [
      {
        id: brandString<SkillDirectoryId>('root'),
        source: 'user-dsh',
        path: '/test/skills',
        writable: true,
        enabled: true,
        external: false,
      },
    ],
    skills: [
      {
        id: brandString<ManagedSkillId>('demo'),
        directoryId: brandString<SkillDirectoryId>('root'),
        name: 'demo',
        description: '可复用流程',
        path: '/test/skills/demo/SKILL.md',
        revision: 'r1',
        enabled: true,
        modelInvocable: true,
        userInvocable: true,
        writable: true,
        valid: true,
        diagnostics: [],
        effective: true,
        category: '',
        order: 0,
      },
    ],
  }
  const operations = {
    createConversation: vi.fn<SkillSettingsProps['createConversation']>(async () => true),
    refresh: vi.fn(),
    setEnabled: vi.fn(async () => true),
    save: vi.fn(async () => true),
    importFiles: vi.fn<SkillSettingsProps['importFiles']>(async () => true),
    trash: vi.fn(async () => true),
    restore: vi.fn(async () => true),
    source: vi.fn(async () => true),
    arrange: vi.fn(async () => true),
    discover: vi.fn(async () => []),
    install: vi.fn(async () => true),
    preview: vi.fn(async () => undefined),
    update: vi.fn(async () => true),
    copy: vi.fn(async () => {}),
    subscribe: vi.fn(async () => true),
    marketplace: vi.fn<SkillSettingsProps['marketplace']>(async () => []),
    installMarketplace: vi.fn(async () => true),
    setCategoryEnabled: vi.fn(async () => true),
  }
  const useResource = ((address: string) => ({
    status: 'live',
    value: address.startsWith('dsh-resource://skill-inventory')
      ? snapshot
      : address.startsWith('dsh-resource://skill-detail')
        ? {
          skill: snapshot.skills[0]!,
          document: '完整技能正文',
          tree: {
            entries: [
              { path: 'SKILL.md', kind: 'file' },
              { path: 'scripts', kind: 'directory' },
              { path: 'scripts/check.js', kind: 'file' },
            ],
            complete: true,
          },
        }
        : address.startsWith('dsh-resource://skill-models')
          ? {
            default: { provider: 'test', model: 'model' },
            routableProviders: ['test'],
            groups: [{ id: 'test', name: 'Test provider', models: [{ id: 'model', name: 'Test model' }] }],
            failures: [],
          }
          : undefined,
  })) as SkillSettingsProps['useResource']
  return {
    operations,
    props: {
      ...operations,
      useResource,
      useWorkspaces: () => [{ workspaceId: 'workspace', path: '/test', sessionIds: [] }],
      useStore: bindSnapshotSelector(state),
      actions: state.actions,
      t: makeTranslate(zh),
    } as SkillSettingsProps,
  }
}
it('renders the shared illustration and controls the exact skill copy', () => {
  const { props, operations } = fixture()
  const { container } = render(<SkillSettings {...props} />)
  expect(container.querySelector('img')?.getAttribute('src')).toContain('skills-reading-whale-maid-v1.webp')
  expect(screen.getByRole('heading', { name: 'Skills技能' })).toBeTruthy()
  fireEvent.click(screen.getByRole('switch', { name: '启用 demo' }))
  expect(operations.setEnabled).toHaveBeenCalledWith('demo', false, '')
})
it('reads full instructions and directory members inside one dialog', () => {
  const { props } = fixture()
  render(<SkillSettings {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '查看 demo' }))
  expect(screen.getByRole('dialog', { name: 'demo' })).toBeTruthy()
  expect(screen.queryByRole('complementary', { name: '目录结构' })).toBeNull()
  expect(screen.queryByRole('button', { name: '查看完整详情' })).toBeNull()
  expect(screen.getByText('完整技能正文')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  expect(screen.getByRole('button', { name: '保存' })).toBeTruthy()
  expect(screen.getAllByRole('button', { name: '取消' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  fireEvent.click(screen.getByRole('tab', { name: '目录结构' }))
  expect(screen.getByRole('dialog', { name: 'demo' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Skills技能' })).toBeTruthy()
  expect(screen.getByRole('complementary', { name: '目录结构' }).textContent).toContain('check.js')
})
it('chooses a workspace and model before preparing an AI skill-authoring chat', async () => {
  const { props, operations } = fixture()
  render(<SkillSettings {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '新建技能' }))
  expect(screen.getByRole('dialog', { name: '新建技能' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '执行工作区' }).textContent).toContain('/test')
  expect(screen.getByRole('button', { name: '模型' }).textContent).toContain('Test model')
  fireEvent.click(screen.getByRole('button', { name: '进入 AI 对话' }))
  await waitFor(() => {
    expect(operations.createConversation).toHaveBeenCalledWith('workspace', { provider: 'test', model: 'model' })
  })
  expect(operations.importFiles).not.toHaveBeenCalled()
})
it('groups directory ownership and registers a source without moving into a new view', async () => {
  const { props, operations } = fixture()
  render(<SkillSettings {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '来源目录' }))
  expect(screen.getByRole('dialog', { name: '来源目录' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: '本地目录' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: '外部目录' })).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: '外部技能目录的绝对路径' }), {
    target: { value: '/external/skills' },
  })
  fireEvent.click(screen.getByRole('button', { name: '添加来源' }))
  await waitFor(() => {
    expect(operations.source).toHaveBeenCalledWith('/external/skills', false)
  })
})
it('searches one selected catalog and installs into the visible target before switching to repositories', async () => {
  const { props, operations } = fixture()
  const item = {
    catalog: 'skills.sh' as const,
    owner: 'example',
    slug: 'review',
    name: 'Review helper',
    description: 'Review changes',
    repository: 'example/skills',
  }
  operations.marketplace.mockResolvedValueOnce([item])
  render(<SkillSettings {...props} />)
  fireEvent.click(screen.getByRole('tab', { name: '发现' }))
  expect(screen.getByRole('tab', { name: '公共市场' })).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: 'GitHub 仓库地址' })).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: '搜索公共技能' }), { target: { value: 'review' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索' }))
  await screen.findByRole('heading', { name: 'Review helper' })
  fireEvent.click(screen.getByRole('button', { name: '安装' }))
  expect(operations.installMarketplace).toHaveBeenCalledWith(item, 'root', false, '')
  fireEvent.click(screen.getByRole('tab', { name: 'GitHub 仓库' }))
  expect(screen.getByRole('textbox', { name: 'GitHub 仓库地址' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '查看仓库' }).hasAttribute('disabled')).toBe(true)
})
