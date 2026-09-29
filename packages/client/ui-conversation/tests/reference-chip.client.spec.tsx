// @vitest-environment jsdom
/**
 * ReferenceChip visual face: icon selection per appearance, the trigger
 * marker fallback, label truncation container, and invalid styling.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ReferenceChip } from '../src/client/input/editor/ReferenceChip.tsx'

afterEach(cleanup)

describe('ReferenceChip', () => {
  it('highlights a selected plugin with the plugin glyph', () => {
    const { container } = render(<ReferenceChip label="Notes" appearance="plugin" invalid={false} />)
    expect(container.textContent).toBe('Notes')
    expect(container.querySelector('svg')).not.toBeNull()
  })
  it('uses the selected plugin artwork and falls back if it cannot load', () => {
    const artwork = 'data:image/svg+xml;base64,PHN2Zy8+'
    const { container } = render(<ReferenceChip label="Notes" appearance="plugin" artwork={artwork} invalid={false} />)
    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe(artwork)
    expect(container.querySelector('svg')).toBeNull()
    if (image !== null) fireEvent.error(image)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
  it('renders the domain icon and the label', () => {
    const { container, getByTitle } = render(
      <ReferenceChip label="Research notes" appearance="session" invalid={false} />,
    )
    expect(getByTitle('Research notes')).toBeTruthy()
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.textContent).toBe('Research notes')
  })

  it('falls back to the trigger marker without an appearance', () => {
    const { container } = render(<ReferenceChip label="commit-helper" invalid={false} />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toBe('@commit-helper')
  })

  it('applies the invalid styling bit', () => {
    const { container } = render(<ReferenceChip label="gone" appearance="folder" invalid />)
    const chip = container.firstElementChild
    expect(chip).not.toBeNull()
    expect([...(chip?.classList ?? [])].some(name => name.includes('invalid'))).toBe(true)
  })
})
