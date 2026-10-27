// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent } from '@testing-library/react'
import { createReasoningRenderFixture } from './reasoning-render-fixture.tsx'

afterEach(cleanup)
const unavailable = async (): Promise<never> => { throw new Error('This text-only preview has no authorized attachments') }

describe('standalone native Chat content', () => {
  it('renders headings, lists, tables and native code controls without a Session Provider', async () => {
    const b = await createReasoningRenderFixture('en')
    const text = '## Visual analysis\n\n1. Muted greens\n2. Soft light\n\n| Color | Weight |\n| --- | --- |\n| Green | 0.8 |\n\n```json\n{"saved":true}\n```'
    const view = b.render(b.renderFactorySlot('conversation.chat.assistant.content', { text, streaming: false }))
    expect(b.runtime.factoryOf('conversation.chat.assistant.content').scope).toBe('root')
    expect(view.getByRole('heading', { name: 'Visual analysis', level: 2 })).toBeTruthy()
    expect(view.getAllByRole('listitem')).toHaveLength(2)
    expect(view.getByRole('table')).toBeTruthy()
    expect(view.getByRole('button', { name: 'Copy' })).toBeTruthy()
    const wrap = view.getByRole('button', { name: 'Wrap lines' })
    fireEvent.click(wrap)
    expect(wrap.getAttribute('aria-pressed')).toBe('false')
    view.rerender(b.renderFactorySlot('conversation.chat.assistant.content', { text: `${text}\n\nMore output`, streaming: true }))
    expect(view.getByRole('button', { name: 'Wrap lines' })).toBe(wrap)
    expect(wrap.getAttribute('aria-pressed')).toBe('false')
    view.unmount()
    await b.owner.dispose()
    expect(() => b.runtime.factoryOf('conversation.chat.assistant.content')).toThrow('no definition')
  })

  it('preserves exact read-only input, native bubble layout, and JSON blocks without Session transforms', async () => {
    const b = await createReasoningRenderFixture('en')
    const content = { text: 'Keep <file> literally\nSecond line', attachments: [], extraBlocks: [] }
    const view = b.render(b.renderFactorySlot('conversation.chat.user.preview', { content, loadImage: unavailable }))
    expect(b.runtime.factoryOf('conversation.chat.user.preview').scope).toBe('root')
    expect(view.getByText(/Keep <file> literally/u).textContent).toBe(content.text)
    expect(view.container.querySelector('file')).toBeNull()
    expect(view.container.querySelector('[class*="userStack"]')).toBeTruthy()
    expect(view.container.querySelector('[class*="bubble"]')).toBeTruthy()
    view.rerender(b.renderFactorySlot('conversation.chat.user.preview', { content: { ...content, extraBlocks: [{ source: 'saved' }] }, loadImage: unavailable }))
    expect(view.getByRole('button', { name: /Extra content block/u })).toBeTruthy()
    view.unmount()
    await b.owner.dispose()
    expect(() => b.runtime.factoryOf('conversation.chat.user.preview')).toThrow('no definition')
  })
})
