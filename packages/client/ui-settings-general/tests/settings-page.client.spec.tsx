// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSettingsShellStore } from '../src/client/shell-store.ts'
import { SettingsPage } from '../src/client/SettingsPage.tsx'
import type { SettingsPageComponentProps, SettingsSectionRow, SettingsSearchRow } from '../src/client/shell-contract.ts'
import { en } from '../src/client/locales.ts'

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(rows: readonly SettingsSectionRow[] = [
  { id: 'general', order: 0, label: 'General' },
  { id: 'models', order: 10, label: 'Models' },
  { id: 'plugins', order: 20, label: 'Plugins' },
]) {
  const shell = createSettingsShellStore().create()
  shell.actions.open()
  const closeSettings = vi.fn()
  const renderSlot = vi.fn(((name: string, _props: object, opts?: { only?: string }) => {
    if (name === 'settings.section') return <div data-testid={`section-${opts?.only}`}><h2 id="font-heading">Font</h2></div>
    if (name === 'settings.close') return 'Back'
    if (name === 'settings.header') return 'Settings'
    if (name === 'settings.action') return 'Open configuration file'
    return null
  }) as SettingsPageComponentProps['renderSlot'])
  const props = {
    useStore: bindSnapshotSelector(shell), actions: shell.actions,
    useSections: (select: (value: readonly SettingsSectionRow[]) => readonly SettingsSectionRow[]) => select(rows),
    useSearchEntries: (select: (value: readonly SettingsSearchRow[]) => readonly SettingsSearchRow[]) => select([
      { id: 'font', sectionId: 'models', label: 'Font', target: '#font-heading' },
      { id: 'language', sectionId: 'general', label: 'Language' },
    ]),
    closeSettings, renderSlot, t: makeTranslate(en),
  } as SettingsPageComponentProps
  const view = render(<SettingsPage {...props} />)
  return { shell, closeSettings, renderSlot, view }
}

describe('SettingsPage', () => {
  it('renders section navigation without a document footer or dialog', () => {
    const { renderSlot } = mount()
    expect(document.querySelector('[data-settings-page]')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'General' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Preferences' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Models and agents' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Plugins and apps' })).toBeTruthy()
    expect(screen.queryByText('Open configuration file')).toBeNull()
    expect(document.querySelector('[data-settings-page] footer')).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
    const sectionCall = vi.mocked(renderSlot).mock.calls.find(call => call[0] === 'settings.section')
    expect(sectionCall?.[2]).toEqual({ only: 'general' })
    const owner = sectionCall?.[1]
    expect(owner !== undefined && 'close' in owner && typeof owner.close === 'function').toBe(true)
  })

  it('focuses the selected section, switches sections, and returns through the back control', async () => {
    const { closeSettings } = mount()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'General' }))
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('page')
    expect(await screen.findByTestId('section-models')).toBeTruthy()
    expect(screen.queryByTestId('section-general')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(closeSettings).toHaveBeenCalledWith(true)
  })

  it('does not treat Escape as page navigation', () => {
    const { closeSettings } = mount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeSettings).not.toHaveBeenCalled()
  })

  it('collapses navigation without changing the selected section or losing accessible labels', async () => {
    const { closeSettings } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse settings sidebar' }))
    expect(document.querySelector('[data-settings-page]')?.getAttribute('data-collapsed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Expand settings sidebar' }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(await screen.findByTestId('section-models')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Expand settings sidebar' }))
    expect(document.querySelector('[data-settings-page]')?.getAttribute('data-collapsed')).toBe('false')
    expect(await screen.findByTestId('section-models')).toBeTruthy()
    expect(closeSettings).not.toHaveBeenCalled()
  })

  it('falls back to a remaining section when the selected one unloads', () => {
    const { shell, view } = mount()
    act(() => { shell.actions.select('models') })
    const onlyGeneral = [{ id: 'general', order: 0, label: 'General' }]
    const props = {
      useStore: bindSnapshotSelector(shell), actions: shell.actions,
      useSections: (select: (value: readonly SettingsSectionRow[]) => readonly SettingsSectionRow[]) => select(onlyGeneral),
      useSearchEntries: (select: (value: readonly object[]) => readonly object[]) => select([]),
      closeSettings: vi.fn(),
      renderSlot: ((name: string, _props: object, opts?: { only?: string }) => name === 'settings.section' ? <div data-testid={`section-${opts?.only}`} /> : null) as SettingsPageComponentProps['renderSlot'],
      t: makeTranslate(en),
    } as SettingsPageComponentProps
    view.rerender(<SettingsPage {...props} />)
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('keeps text through collapse fade, then remounts it for the wide entrance', async () => {
    mount()
    const label = screen.getByText('Models', { selector: 'span' })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse settings sidebar' }))
    expect(document.contains(label)).toBe(true)
    await vi.waitFor(() => { expect(screen.queryByRole('searchbox')).toBeNull() })
    expect(document.contains(label)).toBe(false)
    expect(screen.getByRole('button', { name: 'Models' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Expand settings sidebar' }))
    expect(screen.getByText('Models', { selector: 'span' })).not.toBe(label)
  })

  it('searches settings on another page without mounting it, then focuses the selected setting', async () => {
    mount()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: '  FONT  ' } })
    expect(screen.getByRole('button', { name: 'Font Models' })).toBeTruthy()
    expect(screen.queryByTestId('section-models')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Font Models' }))
    expect(await screen.findByTestId('section-models')).toBeTruthy()
    await vi.waitFor(() => { expect(document.activeElement?.id).toBe('font-heading') })
    expect(screen.getByRole('searchbox').getAttribute('value')).toBe('')
  })

  it('shows an empty result and clears search with Escape without leaving settings', () => {
    const { closeSettings } = mount()
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'no-such-setting' } })
    expect(screen.getByText('No matching settings')).toBeTruthy()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByText('No matching settings')).toBeNull()
    expect(closeSettings).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'General' })).toBeTruthy()
  })
})
