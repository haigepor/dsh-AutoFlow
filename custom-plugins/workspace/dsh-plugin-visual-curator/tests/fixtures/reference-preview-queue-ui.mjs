/** Native previews from independent factories share one image lane in a real scrolling grid. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import * as UI from '../../../../../packages/client/ui-primitives/src/index.ts'
import { createReferencePreview } from '../../src/client/reference-preview.tsx'
import { sharedPreviewLoader } from '../../src/client/preview-loader.ts'
import { zh } from '../../src/client/workbench-locale.ts'
import pluginCss from '../../src/client/entry.css'
import '../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../../packages/client/ui-theme/src/styles/focus.css'

const h = React.createElement, t = key => zh[key], first = createReferencePreview(React, UI), second = createReferencePreview(React, UI)
const sheet = document.createElement('style'); sheet.textContent = pluginCss; document.head.append(sheet)
const nativeFetch = window.fetch.bind(window), nativeCreate = URL.createObjectURL.bind(URL), nativeRevoke = URL.revokeObjectURL.bind(URL)
const stats = { active: 0, maxActive: 0, calls: [], cancelled: 0, urls: new Set() }
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.href).pathname
  if (!path.startsWith('/qa-media/')) return await nativeFetch(input, init)
  stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active); stats.calls.push(String(input))
  try { return await nativeFetch(input, init) }
  catch (error) { if (init?.signal?.aborted) stats.cancelled++; throw error }
  finally { stats.active-- }
}
URL.createObjectURL = blob => { const url = nativeCreate(blob); stats.urls.add(url); return url }
URL.revokeObjectURL = url => { stats.urls.delete(url); nativeRevoke(url) }
sharedPreviewLoader.configure(2)
let show = true, refresh = 0
const networkQuery = new URL(location.href).searchParams.has('real-network') ? `?run=${crypto.randomUUID()}` : ''
function App() {
  return h('main', null, h('header', null,
    h(UI.Button, { onClick: () => { refresh++; render() } }, '刷新失败图片'),
    h(UI.Button, { onClick: () => { show = false; render() } }, '卸载列表')),
    h('div', { id: 'preview-scroll', className: 'fixture-grid' }, show && Array.from({ length: 16 }, (_, index) => h(index % 2 ? second : first, { key: index, src: `/qa-media/photo-${index}.svg${networkQuery}`, href: `/qa-media/photo-${index}.svg${networkQuery}`, alt: `photo-${index}`, width: 160, height: 100, refreshKey: refresh, t }))))
}
const root = createRoot(document.getElementById('root'))
function render() { root.render(h(App)) }
window.previewFixture = {
  stats: () => ({ ...stats, urls: stats.urls.size }),
  async reactivate() { await sharedPreviewLoader.dispose(); sharedPreviewLoader.configure(2); show = true; render() },
  async dispose() { root.unmount(); await sharedPreviewLoader.dispose() },
}
render()
