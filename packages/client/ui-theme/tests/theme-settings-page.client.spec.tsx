// @vitest-environment jsdom
/** Appearance rows preserve the runtime choices and delegate menu selections. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { ThemeSettingsPage, type ThemeSettingsPageProps } from '../src/client/ThemeSettingsPage.tsx'
import { createThemePageStore, type ThemePageState } from '../src/client/settings-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function mountPage(overrides: Partial<ThemePageState> = {}) {
  const store = createThemePageStore().create()
  store.actions.sync({
    preference: 'dark', accent: 'iris', themeSet: 'official', legacyAccent: false,
    glideDuration: 220, fontFamily: 'system', corners: '0.75', fontSize: 14, revision: 1, ...overrides,
  })
  const writes = {
    setTheme: vi.fn(), setAccent: vi.fn(), setThemeSet: vi.fn(), setFontFamily: vi.fn(),
    setCorners: vi.fn(), setGlideDuration: vi.fn(), setFontSize: vi.fn(), resetAppearance: vi.fn(),
  }
  const props: ThemeSettingsPageProps = {
    ...({} as GlobalStandardProps), close: () => {}, useStore: bindSnapshotSelector(store),
    actions: store.actions, t: key => en[key as keyof typeof en] ?? key, ...writes,
  }
  return { ...render(<ThemeSettingsPage {...props} />), writes }
}

it('switches modes and palettes directly from cards and persists the remaining menu values', () => {
  const { container, writes } = mountPage()
  expect(container.querySelectorAll('[data-appearance-settings] > section')).toHaveLength(5)
  const modeGroup = screen.getByRole('group', { name: 'Appearance mode' })
  expect(modeGroup.querySelectorAll('button')).toHaveLength(3)
  expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true')
  for (const [label, value] of [['Follow system', 'system'], ['Light', 'light'], ['Dark', 'dark']] as const) {
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(writes.setTheme).toHaveBeenLastCalledWith(value)
    expect(screen.queryByRole('menu')).toBeNull()
  }
  for (const [label, value] of [['Blue Gray', 'official'], ['Iris', 'current']] as const) {
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(writes.setThemeSet).toHaveBeenLastCalledWith(value)
    expect(screen.queryByRole('menu')).toBeNull()
  }
  const selections = [
    ['Font', 'IBM Plex Serif', writes.setFontFamily, 'ibm-plex-serif'],
    ['Corner radius', '0.5 rem', writes.setCorners, '0.5'],
    ['Menu motion speed', 'Slow (400 ms)', writes.setGlideDuration, 400],
  ] as const
  for (const [name, option, write, value] of selections) {
    const button = screen.getByRole('button', { name })
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: option }))
    expect(write).toHaveBeenCalledWith(value)
    expect(button.getAttribute('aria-expanded')).toBe('false')
  }
  fireEvent.click(screen.getByRole('button', { name: 'Reset appearance' }))
  expect(writes.resetAppearance).toHaveBeenCalledOnce()
})

it.each(['inter', 'noto-sans-sc'] as const)('keeps a saved %s font available without writing preferences on mount', (fontFamily) => {
  const { writes } = mountPage({ fontFamily, legacyAccent: true, corners: 'compact' })
  expect(screen.getByText('Custom palette')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Blue Gray' }).getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByRole('button', { name: 'Iris' }).getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByRole('button', { name: 'Corner radius' }).textContent).toBe('0.25 rem')
  const fontButton = screen.getByRole('button', { name: 'Font' })
  expect(fontButton.textContent).toBe(en[`preset.font.${fontFamily}.label`])
  for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled()
  fireEvent.click(fontButton)
  expect(screen.getByRole('menuitem', { name: en[`preset.font.${fontFamily}.label`] })).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(fontButton.getAttribute('aria-expanded')).toBe('false')
  expect(writes.setFontFamily).not.toHaveBeenCalled()
})
