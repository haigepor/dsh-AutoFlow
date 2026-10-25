// @vitest-environment jsdom
/** Multiline form fields retain native validation without inline-save shortcuts. */
import { createRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TextArea } from '../src/TextArea.tsx'

afterEach(cleanup)

it('retains line breaks and native required validation through its forwarded textarea ref', () => {
  const ref = createRef<HTMLTextAreaElement>()
  const onChange = vi.fn()
  const view = render(<TextArea ref={ref} aria-label="Rules" required value={'first\nsecond'} onChange={onChange} />)
  const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Rules' })
  expect(ref.current).toBe(field)
  expect(field.value).toBe('first\nsecond')
  fireEvent.change(field, { target: { value: 'third\nfourth' } })
  expect(onChange).toHaveBeenCalledOnce()
  view.rerender(<TextArea ref={ref} aria-label="Rules" required value="" onChange={onChange} />)
  expect(field.checkValidity()).toBe(false)
})
