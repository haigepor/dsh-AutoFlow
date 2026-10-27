// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CodeEditor } from '../src/CodeEditor.tsx'

afterEach(cleanup)

it('keeps native source editing and uses the shared Shiki token colors', async () => {
  const onChange = vi.fn()
  const source = '{"mcpServers":{},"disabled":true}'
  const { container, rerender } = render(<CodeEditor label="JSON" language="json" value={source} onChange={onChange} />)
  const editor = screen.getByRole('textbox', { name: 'JSON' })
  fireEvent.change(editor, { target: { value: '{"mcpServers":{}}' } })
  expect(onChange).toHaveBeenCalledWith('{"mcpServers":{}}')
  await waitFor(() => { expect(container.querySelector('pre span[style*="--shiki-token"]')).toBeTruthy() }, { timeout: 5000 })
  expect(container.querySelector('pre')?.getAttribute('aria-hidden')).toBe('true')
  rerender(<CodeEditor label="JSON" language="json" value="{}" onChange={onChange} disabled />)
  expect((editor as HTMLTextAreaElement).disabled).toBe(true)
})
