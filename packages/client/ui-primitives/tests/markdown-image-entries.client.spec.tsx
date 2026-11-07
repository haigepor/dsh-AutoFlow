// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { fileMediaUrl } from '@deepseek-ai/dsh-util-workspace-path'
import { MarkdownDelegateProvider, type MarkdownMenuTarget } from '../src/markdown/MarkdownDelegate.tsx'
import { MarkdownText } from './markdown-test-components.tsx'
import { parseGfm, parseGfmWithMath } from '../src/markdown/parse.ts'
import type { FileDragActions } from '../src/file-drag-actions.ts'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const fileDrag = { prepare: vi.fn(async () => ({ start: () => true, release: () => {} })), reportFailure: vi.fn() }
const labels = { dragFailed: 'Image drag failed', open: 'View full image', dialog: 'Image preview', close: 'Close preview', loading: 'Loading image', failed: 'Image unavailable' }
const fileImages = { fileDrag, resolve: (path: string) => `https://example.com/api/file?path=${encodeURIComponent('/workspace/' + path)}`, labels }
function mount(text: string, streaming = false) {
  const openFile = vi.fn()
  const view = render(<MarkdownDelegateProvider openFile={openFile} fileImages={fileImages}>
    <MarkdownText text={text} streaming={streaming} />
  </MarkdownDelegateProvider>)
  return { ...view, openFile }
}

it('loads Desktop inline and hover previews through the file route after streaming settles', async () => {
  vi.useFakeTimers()
  const path = '/work/测试 图片#100%.png'
  const src = fileMediaUrl('dsh-app://app/', path)!
  const images = { fileDrag, resolve: (value: string) => fileMediaUrl('dsh-app://app/', value), labels }
  const text = `![图片](<${encodeURI(path).replace('#', '%23')}>)\n\n[打开图片](<${encodeURI(path).replace('#', '%23')}>)`
  const openFile = vi.fn()
  const content = (streaming: boolean) => <MarkdownDelegateProvider fileImages={images} openFile={openFile}>
    <MarkdownText text={text} streaming={streaming} />
  </MarkdownDelegateProvider>
  const view = render(content(true))
  expect(view.container.querySelector('img')).toBeNull()
  view.rerender(content(false))
  const inline = screen.getByRole('img').getAttribute('src')
  const inlineUrl = new URL(inline!)
  expect(inlineUrl.searchParams.get('preview')).toBe('1')
  expect(inlineUrl.searchParams.get('path')).toBe(path)
  const trigger = screen.getByRole('button', { name: 'View full image: 图片' })
  trigger.focus()
  fireEvent.click(trigger)
  const originalUrl = new URL(screen.getByRole('dialog').querySelector('img')!.getAttribute('src')!)
  expect(originalUrl.searchParams.has('preview')).toBe(false)
  expect(originalUrl.searchParams.get('path')).toBe(path)
  expect(originalUrl.searchParams.get('load')).toBe(inlineUrl.searchParams.get('load'))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  const link = screen.getByRole('button', { name: '打开图片' })
  fireEvent.pointerEnter(link.parentElement!)
  act(() => { vi.advanceTimersByTime(500) })
  const hoverUrl = new URL(screen.getByAltText(path).getAttribute('src')!)
  expect(hoverUrl.searchParams.get('preview')).toBe('1')
  expect(hoverUrl.searchParams.get('path')).toBe(new URL(src).searchParams.get('path'))
  await expect(JSON.stringify({ inlineVariant: inlineUrl.searchParams.get('preview'), hoverVariant: hoverUrl.searchParams.get('preview'), originalVariant: originalUrl.searchParams.get('preview'), originalPath: originalUrl.searchParams.get('path'), sameLoadForOriginal: originalUrl.searchParams.get('load') === inlineUrl.searchParams.get('load') }, null, 2) + '\n')
    .toMatchFileSnapshot('./fixtures/markdown-local-preview.expected.json')
  fireEvent.error(screen.getByAltText(path))
  expect(screen.getByText(labels.failed)).toBeTruthy()
  fireEvent.click(link)
  expect(openFile).toHaveBeenCalledWith(path, undefined)
})

it('keeps original lightbox, menu and drag identity when the local thumbnail cannot be decoded', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  const path = '/work/high-resolution.tiff', original = fileMediaUrl(document.baseURI, path)!
  const address = 'dsh-resource://file/session/s/high-resolution.tiff'
  const menu = vi.fn(), getTriggerProps = (target: MarkdownMenuTarget) => ({ onContextMenu: () => { menu(target) } })
  const prepare = vi.fn<FileDragActions['prepare']>(async () => ({ start: () => true, release: () => {} }))
  const images = { ...fileImages, resolve: () => original, resourceAddress: () => address, fileDrag: { prepare, reportFailure: vi.fn() } }
  const view = render(<MarkdownDelegateProvider fileImages={images} getTriggerProps={getTriggerProps}>
    <MarkdownText text={`![High resolution](${path})`} />
  </MarkdownDelegateProvider>)
  const image = screen.getByRole('img'), thumbnail = new URL(image.getAttribute('src')!)
  expect(thumbnail.searchParams.get('preview')).toBe('1')
  await act(async () => { fireEvent.pointerDown(image, { button: 0 }) })
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ kind: 'url', resourceAddress: address }), expect.any(AbortSignal))
  const dragged = prepare.mock.calls[0]![0]
  if (dragged.kind !== 'url') throw new Error('Expected an original URL drag source')
  expect(dragged.url).not.toContain('preview=')
  expect(new URL(dragged.url).searchParams.get('load')).toBe(thumbnail.searchParams.get('load'))
  const trigger = screen.getByRole('button', { name: 'View full image: High resolution' })
  fireEvent.contextMenu(trigger)
  expect(menu).toHaveBeenLastCalledWith({ kind: 'image', url: dragged.url, path })
  fireEvent.error(image)
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByText('Image unavailable · High resolution')).toBeTruthy()
  fireEvent.contextMenu(trigger)
  expect(menu).toHaveBeenLastCalledWith({ kind: 'image', url: dragged.url, path })
  fireEvent.click(trigger)
  expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(dragged.url)
  view.unmount()
})

it.each(['svg', 'gif'])('retains explicit original activation after a %s preview fails without automatically loading the original', (extension) => {
  const path = `/work/source.${extension}`, openFile = vi.fn()
  render(<MarkdownDelegateProvider fileImages={{ ...fileImages, resolve: value => fileMediaUrl('dsh-app://app/', value) }} openFile={openFile}>
    <MarkdownText text={`![Source](${path})\n\n[Open original](${path})`} />
  </MarkdownDelegateProvider>)
  const image = screen.getByRole('img')
  expect(new URL(image.getAttribute('src')!).searchParams.get('preview')).toBe('1')
  fireEvent.error(image)
  expect(document.querySelector('img')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Open original' }))
  expect(openFile).toHaveBeenCalledWith(path, undefined)
  fireEvent.click(screen.getByRole('button', { name: 'View full image: Source' }))
  expect(new URL(screen.getByRole('dialog').querySelector('img')!.getAttribute('src')!).searchParams.has('preview')).toBe(false)
})

it('opens inline images in the shared lightbox, restores focus, and never opens the sidebar', () => {
  const { openFile } = mount('![Compare](<.artifacts/对比 image.png>)')
  const trigger = screen.getByRole('button', { name: 'View full image: Compare' })
  trigger.focus()
  expect(new URL(screen.getByRole('img').getAttribute('src')!).searchParams.get('path')).toBe('/workspace/.artifacts/对比 image.png')
  fireEvent.click(trigger)
  expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeTruthy()
  fireEvent.keyDown(window, { key: 'Tab' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close preview' }))
  fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(openFile).not.toHaveBeenCalled()
})

it.each([
  ['assets/my%20photo.png', 'my photo.png'],
  ['assets/%E5%9B%BE%E7%89%87.png', '图片.png'],
  ['C:%5Cassets%5Cmy%20photo.png', 'my photo.png'],
])('prepares the decoded basename for %s', async (destination, name) => {
  fileDrag.prepare.mockClear()
  mount(`![source](${destination})`)
  await act(async () => { fireEvent.pointerEnter(screen.getByRole('img')) })
  expect(fileDrag.prepare).toHaveBeenCalledWith(expect.objectContaining({ name }), expect.any(AbortSignal))
})

it('loads a link preview only after hover dwell and keeps its existing sidebar activation', () => {
  vi.useFakeTimers()
  const { openFile } = mount('[View comparison](.artifacts/对比%20image.png)')
  const link = screen.getByRole('button', { name: 'View comparison' })
  expect(screen.queryByRole('img')).toBeNull()
  fireEvent.pointerEnter(link.parentElement!)
  act(() => { vi.advanceTimersByTime(499) })
  expect(screen.queryByRole('img')).toBeNull()
  act(() => { vi.advanceTimersByTime(1) })
  const image = screen.getByRole('img')
  expect(new URL(image.getAttribute('src')!).searchParams.get('path')).toBe('/workspace/.artifacts/对比 image.png')
  fireEvent.load(image)
  expect(screen.queryByText('Loading image')).toBeNull()
  fireEvent.pointerDown(link)
  fireEvent.click(link)
  expect(screen.queryByRole('img')).toBeNull()
  expect(openFile).toHaveBeenCalledWith('.artifacts/对比 image.png', undefined)
})

it('supports keyboard previews, Escape dismissal, and an inert failure state', () => {
  mount('[View comparison](graph.png)')
  const link = screen.getByRole('button', { name: 'View comparison' })
  // jsdom does not model keyboard input modality for :focus-visible.
  vi.spyOn(link, 'matches').mockReturnValue(true)
  act(() => { link.focus() })
  fireEvent.error(screen.getByRole('img'))
  expect(screen.getByText('Image unavailable')).toBeTruthy()
  fireEvent.keyDown(link, { key: 'Escape' })
  expect(screen.queryByText('Image unavailable')).toBeNull()
})

it('leaves non-image links and streaming paths without a preview', () => {
  mount('[Report](report.pdf)')
  fireEvent.focus(screen.getByRole('button', { name: 'Report' }))
  expect(screen.queryByRole('img')).toBeNull()
  cleanup()
  mount('![Compare](image.png)', true)
  expect(screen.queryByRole('img')).toBeNull()
})

it('keeps image-only links as one activation target', () => {
  const { container, openFile } = mount('[![Compare](image.png)](image.png)')
  expect(container.querySelectorAll('button')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button'))
  expect(openFile).toHaveBeenCalledWith('image.png', undefined)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([parseGfm, parseGfmWithMath])('recovers standalone bare-space paths without promoting code or escaped syntax', (parse) => {
  const source = '![图](/work/test workspace/测试文件/图.png)'
  expect(parse(source).children[0]).toMatchObject({ children: [{ type: 'image', url: '/work/test workspace/测试文件/图.png' }] })
  for (const example of ['`' + source + '`', '```md\n' + source + '\n```', '\\' + source, 'Example: ' + source,
    '![图](https://example.com/test image.png)', '![图](/work/test (image).png)']) {
    expect(JSON.stringify(parse(example))).not.toContain('"type":"image"')
  }
})

it('keeps an unavailable image link navigable without showing a hover preview', () => {
  const openFile = vi.fn()
  render(<MarkdownDelegateProvider openFile={openFile} fileImages={{ ...fileImages, resolve: () => undefined }}>
    <MarkdownText text="[Image](relative.png)" />
  </MarkdownDelegateProvider>)
  const link = screen.getByRole('button', { name: 'Image' })
  fireEvent.focus(link)
  expect(screen.queryByRole('img')).toBeNull()
  fireEvent.click(link)
  expect(openFile).toHaveBeenCalledWith('relative.png', undefined)
})

it('emits an unparsable file image URL unchanged', () => {
  render(<MarkdownDelegateProvider openFile={vi.fn()} fileImages={{ ...fileImages, resolve: () => 'relative.png' }}>
    <MarkdownText text="![Compare](image.png)" />
  </MarkdownDelegateProvider>)
  expect(screen.getByRole('img').getAttribute('src')).toBe('relative.png')
})

it('labels empty-alt image activation and retains a localized failure description', () => {
  mount('![](image.png)')
  expect(screen.getByRole('button', { name: 'View full image' })).toBeTruthy()
  fireEvent.error(document.querySelector('img')!)
  expect(screen.getByText('Image unavailable · image.png')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

it.each([parseGfm, parseGfmWithMath])('uses the shared image categories for bare-space recovery', (parse) => {
  for (const extension of ['avif', 'tif', 'tiff', 'heic', 'heif']) {
    expect(parse(`![图](/work/test dir/photo.${extension})`).children[0])
      .toMatchObject({ children: [{ type: 'image', url: `/work/test dir/photo.${extension}` }] })
  }
  expect(JSON.stringify(parse('![report](/work/test dir/report.pdf)'))).not.toContain('"type":"image"')
})

it('uses the fallback filename for an external image URL without a path', () => {
  mount('![Remote](https://example.com/)')
  expect(screen.getByRole('img').getAttribute('src')).toBe('https://example.com/')
})
