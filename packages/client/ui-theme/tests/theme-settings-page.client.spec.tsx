// @vitest-environment jsdom
/** Appearance settings cards delegate each selection to the runtime service. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { ThemeSettingsPage, type ThemeSettingsPageProps } from '../src/client/ThemeSettingsPage.tsx'
import { createThemePageStore } from '../src/client/settings-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('renders upstream mode previews and persists every appearance control', () => {
  const store = createThemePageStore().create()
  store.actions.sync({
    preference: 'dark', accent: 'iris', themeSet: 'official', legacyAccent: false,
    glideDuration: 220, fontFamily: 'system', corners: '0.75', fontSize: 14, revision: 1,
  })
  const writes = {
    setTheme: vi.fn(), setAccent: vi.fn(), setThemeSet: vi.fn(), setFontFamily: vi.fn(),
    setCorners: vi.fn(), setGlideDuration: vi.fn(), setFontSize: vi.fn(), resetAppearance: vi.fn(),
  }
  const props: ThemeSettingsPageProps = {
    ...({} as GlobalStandardProps), close: () => {}, useStore: bindSnapshotSelector(store),
    actions: store.actions, t: key => en[key as keyof typeof en] ?? key, ...writes,
  }
  const { container } = render(<ThemeSettingsPage {...props} />)

  expect(container.querySelectorAll('[data-preview-mode]')).toHaveLength(5)
  expect(container.querySelectorAll('[data-name^="icon-theme-"]')).toHaveLength(3)
  expect(container.querySelector('[data-name="icon-theme-dark"]')?.getAttribute('preserveAspectRatio')).toBeNull()
  expect(container.querySelector('[data-preview-palette="official"]')).not.toBeNull()
  expect(container.querySelector('[data-preview-palette="current"]')).not.toBeNull()
  expect(container.querySelector('[data-carousel-page="0"]')?.getAttribute('aria-hidden')).toBe('false')
  expect(container.querySelectorAll('[data-carousel-page="0"] button')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: 'Next theme color preset' })).toBeNull()
  expect(container.querySelectorAll('[data-appearance-settings] > section')).toHaveLength(5)
  expect(screen.getByRole('button', { name: /^Dark/ }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: /^Light/ }))
  expect(writes.setTheme).toHaveBeenCalledWith('light')
  const currentThemeCard = container.querySelector('[data-carousel-page="0"] button:nth-of-type(2)')
  if (!(currentThemeCard instanceof HTMLButtonElement)) {
    throw new Error('The current-project theme card was not rendered.')
  }
  fireEvent.click(currentThemeCard)
  expect(writes.setThemeSet).toHaveBeenCalledWith('current')
  fireEvent.click(screen.getByRole('button', { name: /IBM Plex Serif/ }))
  expect(writes.setFontFamily).toHaveBeenCalledWith('ibm-plex-serif')
  fireEvent.click(screen.getByRole('button', { name: /^0.5 rem/ }))
  expect(writes.setCorners).toHaveBeenCalledWith('0.5')
  fireEvent.click(screen.getByRole('button', { name: 'Menu motion speed preview' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Slow (400 ms)' }))
  expect(writes.setGlideDuration).toHaveBeenCalledWith(400)
  fireEvent.click(screen.getByRole('button', { name: 'Reset appearance' }))
  expect(writes.resetAppearance).toHaveBeenCalledOnce()
})
