// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UpdateDownloadPanel } from '../src/client/UpdateDownloadPanel.tsx'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { DesktopDownloadProgress, DesktopUpdateState } from '../src/update-state.ts'

afterEach(cleanup)

function fixture() {
  const locale = resolveDesktopLocale('zh-CN')
  const download: DesktopDownloadProgress = { stage: 'probing', choice: { source: 'auto' }, transferred: 1024 ** 2,
    total: 10 * 1024 ** 2, bytesPerSecond: 512 * 1024, remainingSeconds: 18,
    sources: [{ id: 'github', name: 'GitHub' }, { id: 'ghfast', name: 'GHFast' }] }
  const state: DesktopUpdateState = { phase: 'downloading', version: '2.0.0', percent: 10, download }
  const control = vi.fn(async (_action: string, _version: string, _choice?: unknown) => {})
  const close = vi.fn()
  const props = { state, messages: locale.messages, locale: locale.id, control, close }
  return { ...render(<UpdateDownloadPanel {...props} />), props, download, control, close }
}

it('renders measured progress and keeps custom source input stable during updates', async () => {
  const f = fixture()
  const initial = { selectedSource: document.getElementById('download-source')!.dataset.source,
    status: document.getElementById('download-status')!.textContent,
    amount: document.querySelector('[data-download-amount]')!.textContent,
    speed: document.querySelector('[data-download-speed]')!.textContent,
    eta: document.querySelector('[data-download-eta]')!.textContent,
    pause: screen.getByRole('button', { name: '暂停下载' }).textContent,
    notes: screen.getByRole('region', { name: '更新内容' }).textContent }
  expect(initial).toEqual(JSON.parse(readFileSync(join(import.meta.dirname, 'expected/update-download-zh.json'), 'utf8')))
  fireEvent.click(screen.getByRole('button', { name: '下载线路' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '自定义 HTTPS 代理' }))
  const input = screen.getByRole('textbox', { name: 'HTTPS 代理前缀' }) as HTMLInputElement
  fireEvent.change(input, { target: { value: 'https://mirror.example/path/' } })
  input.focus()
  f.rerender(<UpdateDownloadPanel {...f.props} state={{ ...f.props.state,
    download: { ...f.download, stage: 'downloading', transferred: 2 * 1024 ** 2 } }} />)
  expect(input.value).toBe('https://mirror.example/path/')
  expect(document.activeElement).toBe(input)
  fireEvent.click(screen.getByRole('button', { name: '暂停下载' }))
  await waitFor(() => { expect(f.control).toHaveBeenCalledWith('pause', '2.0.0', undefined) })
  f.rerender(<UpdateDownloadPanel {...f.props} state={{ ...f.props.state, phase: 'available', download: {
    stage: 'paused', choice: f.download.choice, sources: f.download.sources, transferred: 2 * 1024 ** 2,
    total: f.download.total, bytesPerSecond: 0,
  } }} />)
  expect(screen.getByRole('status').textContent).toBe('下载已暂停，进度已保存')
  expect(screen.getByRole('button', { name: '继续下载' })).toBeTruthy()
})

it('lets ordinary downloads continue in the background without authorizing installation', () => {
  const f = fixture()
  fireEvent.click(screen.getByRole('button', { name: '后台下载' }))
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.control).not.toHaveBeenCalled()
})

it('groups localized release notes and retains the scroll position while byte progress changes', () => {
  const f = fixture()
  const releaseNotes = { schemaVersion: 1 as const, version: '2.0.0', items: [
    { id: 'download-resume', category: 'fixes' as const, text: { en: 'Resume interrupted downloads.', 'zh-CN': '修复下载中断后无法继续的问题。' } },
    { id: 'literal-content', category: 'features' as const, text: { en: '<img src=x onerror=alert(1)>', 'zh-CN': '显示更新内容。' } },
  ] }
  const state = { ...f.props.state, releaseNotes }
  f.rerender(<UpdateDownloadPanel {...f.props} state={state} />)
  expect(screen.getByRole('heading', { name: '新增功能' })).toBeTruthy()
  expect(screen.getByText('修复下载中断后无法继续的问题。')).toBeTruthy()
  const region = screen.getByRole('region', { name: '更新内容' })
  region.scrollTop = 50
  f.rerender(<UpdateDownloadPanel {...f.props} state={{ ...state, download: { ...f.download, transferred: 2048 } }} />)
  expect(screen.getByRole('region', { name: '更新内容' })).toBe(region)
  expect(region.scrollTop).toBe(50)
  const en = resolveDesktopLocale('en')
  f.rerender(<UpdateDownloadPanel {...f.props} state={state} messages={en.messages} locale={en.id} />)
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
  expect(region.querySelector('img')).toBeNull()
})

it('keeps mandatory download controls available without a dismiss action', () => {
  const f = fixture()
  f.rerender(<UpdateDownloadPanel {...f.props} close={undefined} />)
  expect(screen.queryByRole('button', { name: '后台下载' })).toBeNull()
  expect(screen.queryByRole('button', { name: '关闭' })).toBeNull()
  expect(screen.getByRole('button', { name: '暂停下载' })).toBeTruthy()
})
