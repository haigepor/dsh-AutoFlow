// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ImageLightbox } from '../src/ImageLightbox.tsx'

afterEach(cleanup)

const labels = { dialog: '原图预览', close: '关闭原图预览' }

describe('ImageLightbox', () => {
  it('navigates by buttons and arrow keys without moving focus or using stale callbacks', () => {
    const next = vi.fn(), previous = vi.fn(), replacement = vi.fn(), onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:first" alt="第一张" labels={labels} onClose={onClose}
      navigation={{ positionLabel: '1 / 3', previousLabel: '上一张', nextLabel: '下一张', onNext: next }} />)
    expect(view.getByRole('button', { name: '上一张' }).hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(next).toHaveBeenCalledOnce()
    const nextButton = view.getByRole('button', { name: '下一张' })
    nextButton.focus()
    fireEvent.click(nextButton)
    expect(next).toHaveBeenCalledTimes(2)
    view.rerender(<ImageLightbox src="blob:second" alt="第二张" labels={labels} onClose={onClose}
      navigation={{ positionLabel: '2 / 3', previousLabel: '上一张', nextLabel: '下一张', onPrevious: previous, onNext: replacement }} />)
    expect(view.getByText('2 / 3').textContent).toMatchInlineSnapshot('"2 / 3"')
    expect(document.activeElement).toBe(nextButton)
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(replacement).toHaveBeenCalledOnce()
    expect(previous).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledTimes(2)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows progress until the image loads and resets progress for a different URL', () => {
    const loadingLabels = { loading: '正在加载大图', error: '图片加载失败', retry: '重试图片' }
    const view = render(<ImageLightbox src="https://example.com/a.png" alt="原图" labels={labels} loadingLabels={loadingLabels}
      loadingImageSrc="https://example.com/loading.webp" onClose={vi.fn()} />)
    expect(view.getByRole('status').textContent).toMatchInlineSnapshot('"正在加载大图"')
    expect(view.getByRole('status').getAttribute('data-illustrated')).toBe('true')
    expect(view.getByRole('status').querySelector('img')?.alt).toBe('')
    expect(view.getByRole('img').getAttribute('data-state')).toBe('loading')
    fireEvent.load(view.getByRole('img'))
    expect(view.queryByRole('status')).toBeNull()
    expect(view.getByRole('img').getAttribute('data-state')).toBe('ready')
    view.rerender(<ImageLightbox src="https://example.com/b.png" alt="原图" labels={labels} loadingLabels={loadingLabels} onClose={vi.fn()} />)
    expect(view.getByRole('status').textContent).toBe('正在加载大图')
  })

  it('offers keyboard-reachable retry after a failed image and keeps dismissal available', () => {
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="https://example.com/fail.png" alt="原图" labels={labels} loadingLabels={{ loading: '正在加载', error: '图片加载失败', retry: '重试图片' }} onClose={onClose} />)
    const failedImage = view.getByRole('img'), close = view.getByRole('button', { name: labels.close })
    fireEvent.error(failedImage)
    const retry = view.getByRole('button', { name: '重试图片' })
    expect(view.getByRole('alert').textContent).toContain('图片加载失败')
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(retry)
    fireEvent.click(retry)
    expect(document.activeElement).toBe(close)
    expect(view.getByRole('img')).not.toBe(failedImage)
    expect(view.getByRole('status').textContent).toBe('正在加载')
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows a cached decoded image without waiting for another load event', () => {
    const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    const width = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(400)
    try {
      const view = render(<ImageLightbox src="https://example.com/cached.png" alt="原图" labels={labels}
        loadingLabels={{ loading: '正在加载', error: '图片加载失败', retry: '重试图片' }} onClose={vi.fn()} />)
      expect(view.queryByRole('status')).toBeNull()
      expect(view.getByRole('img').getAttribute('data-state')).toBe('ready')
    } finally { complete.mockRestore(); width.mockRestore() }
  })

  it('focuses its close control, closes by button and Escape, and restores focus', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    const close = view.getByRole('button', { name: '关闭原图预览' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    const outerKey = vi.fn()
    document.body.addEventListener('keydown', outerKey)
    try {
      fireEvent.keyDown(close, { key: 'Escape' })
      expect(outerKey).not.toHaveBeenCalled()
    } finally { document.body.removeEventListener('keydown', outerKey) }
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('tolerates a focus owner it cannot restore (no active element at mount)', () => {
    // jsdom always reports body as the fallback active element; stub the
    // element-less state a detached focus can leave.
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null })
    try {
      const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
      view.unmount()
    } finally {
      delete (document as { activeElement?: unknown }).activeElement
    }
  })

  it('closes on a mask press but not on a press over the image', () => {
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    fireEvent.mouseDown(view.getByRole('img'))
    expect(onClose).not.toHaveBeenCalled()
    const mask = document.querySelector('[aria-hidden="true"]') as HTMLElement
    fireEvent.mouseDown(mask)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
