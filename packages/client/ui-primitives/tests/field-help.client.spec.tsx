// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { FieldHelp } from '../src/FieldHelp.tsx'

afterEach(cleanup)

it('opens a named menu-material dialog on click and returns focus after close or Escape', () => {
  render(<FieldHelp title="Configuration" text="Changes apply on the next step." label="Help" closeLabel="Close" />)
  const trigger = screen.getByRole('button', { name: 'Help' })
  fireEvent.mouseEnter(trigger)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: 'Configuration' })
  expect(document.activeElement).toBe(dialog)
  expect(within(dialog).getByText('Changes apply on the next step.')).toBeTruthy()
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('closes on outside pointer or Tab and toggles from the same trigger', () => {
  render(<><FieldHelp title="Configuration" text="Details" label="Help" closeLabel="Close" /><button>Outside</button></>)
  const trigger = screen.getByRole('button', { name: 'Help' })
  fireEvent.click(trigger)
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.keyDown(document, { key: 'Tab' })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.click(trigger)
  expect(screen.queryByRole('dialog')).toBeNull()
})
