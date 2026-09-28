// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSettingsShellStore } from '../src/client/shell-store.ts'
import { SettingsPage } from '../src/client/SettingsPage.tsx'
import type { SettingsPageComponentProps, SettingsSectionRow } from '../src/client/shell-contract.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function mount(rows: readonly SettingsSectionRow[] = [
  { id: 'general', order: 0, label: 'General' },
  { id: 'models', order: 10, label: 'Models' },
  { id: 'plugins', order: 20, label: 'Plugins' },
]) {
  const shell = createSettingsShellStore().create()
  shell.actions.open()
  const closeSettings = vi.fn()
  const renderSlot = vi.fn(((name: string, _props: object, opts?: { only?: string }) => {
    if (name === 'settings.section') return <div data-testid={`section-${opts?.only}`} />
    if (name === 'settings.close') return 'Back'
    if (name === 'settings.header') return 'Settings'
    if (name === 'settings.action') return 'Open configuration file'
    return null
  }) as SettingsPageComponentProps['renderSlot'])
  const props = {
    useStore: bindSnapshotSelector(shell), actions: shell.actions,
    useSections: (select: (value: readonly SettingsSectionRow[]) => readonly SettingsSectionRow[]) => select(rows),
    closeSettings, renderSlot, t: makeTranslate(en),
  } as SettingsPageComponentProps
  const view = render(<SettingsPage {...props} />)
  return { shell, closeSettings, renderSlot, view }
}

describe('SettingsPage', () => {
  it('renders a full page with navigation, actions, and no dialog', () => {
    const { renderSlot } = mount()
    expect(document.querySelector('[data-settings-page]')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'General' })).toBeTruthy()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByText('Open configuration file')).toBeTruthy()
    expect(screen.getByTestId('section-general')).toBeTruthy()
    const sectionCall = vi.mocked(renderSlot).mock.calls.find(call => call[0] === 'settings.section')
    expect(sectionCall?.[2]).toEqual({ only: 'general' })
    const owner = sectionCall?.[1]
    expect(owner !== undefined && 'close' in owner && typeof owner.close === 'function').toBe(true)
  })

  it('focuses the selected section, switches sections, and returns through the back control', () => {
    const { closeSettings } = mount()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'General' }))
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(screen.queryByTestId('section-general')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(closeSettings).toHaveBeenCalledWith(true)
  })

  it('does not treat Escape as page navigation', () => {
    const { closeSettings } = mount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeSettings).not.toHaveBeenCalled()
  })

  it('collapses navigation without changing the selected section or losing accessible labels', () => {
    const { closeSettings } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse settings sidebar' }))
    expect(document.querySelector('[data-settings-page]')?.getAttribute('data-collapsed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Expand settings sidebar' }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(screen.getByTestId('section-models')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Expand settings sidebar' }))
    expect(document.querySelector('[data-settings-page]')?.getAttribute('data-collapsed')).toBe('false')
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(closeSettings).not.toHaveBeenCalled()
  })

  it('falls back to a remaining section when the selected one unloads', () => {
    const { shell, view } = mount()
    act(() => { shell.actions.select('models') })
    const onlyGeneral = [{ id: 'general', order: 0, label: 'General' }]
    const props = {
      useStore: bindSnapshotSelector(shell), actions: shell.actions,
      useSections: (select: (value: readonly SettingsSectionRow[]) => readonly SettingsSectionRow[]) => select(onlyGeneral),
      closeSettings: vi.fn(),
      renderSlot: ((name: string, _props: object, opts?: { only?: string }) => name === 'settings.section' ? <div data-testid={`section-${opts?.only}`} /> : null) as SettingsPageComponentProps['renderSlot'],
      t: makeTranslate(en),
    } as SettingsPageComponentProps
    view.rerender(<SettingsPage {...props} />)
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })
})
