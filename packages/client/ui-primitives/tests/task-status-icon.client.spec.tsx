// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TaskStatusIcon } from '../src/TaskStatusIcon.tsx'

afterEach(cleanup)

it('renders distinct task states with a rotating ring only for the ongoing state', () => {
  const { container } = render(<><TaskStatusIcon state="pending" /><TaskStatusIcon state="in_progress" /><TaskStatusIcon state="completed" size={20} /></>)
  const icons = [...container.querySelectorAll('svg')]
  expect(icons.map(icon => ({ state: icon.dataset.taskState, size: icon.getAttribute('width'), grid: icon.getAttribute('viewBox'), details: [...icon.children].map(node => node.tagName) }))).toMatchInlineSnapshot(`
    [
      {
        "details": [
          "rect",
        ],
        "grid": "0 0 16 16",
        "size": "16",
        "state": "pending",
      },
      {
        "details": [
          "circle",
          "g",
        ],
        "grid": "0 0 16 16",
        "size": "16",
        "state": "in_progress",
      },
      {
        "details": [
          "rect",
          "path",
        ],
        "grid": "0 0 16 16",
        "size": "20",
        "state": "completed",
      },
    ]
  `)
  for (const icon of icons) {
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.querySelector('animate, animateTransform')).toBeNull()
    expect(icon.querySelector('[stroke]')?.getAttribute('stroke')).toBe('currentColor')
  }
})
