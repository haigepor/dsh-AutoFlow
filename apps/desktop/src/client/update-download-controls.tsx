/** React island for shell dialogs; snapshots enter through the existing main-owned render adapter. */
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ICON_SYMBOLS, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/src/icons/index.tsx'
import type { IconSymbolId } from '@deepseek-ai/dsh-client-ui-primitives/src/icons/artwork.ts'
import { createPortal } from 'react-dom'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/base.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/gradient-shadow-text.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/scrollbar.css'
import type { DesktopUpdateState } from '../update-state.ts'
import type { DesktopMessages } from '../locale.ts'
import { UpdateDownloadPanel, type UpdateDownloadPanelProps } from './UpdateDownloadPanel.tsx'
import './update-download-shell.css'

interface DownloadControls {
  render(state: DesktopUpdateState, messages: DesktopMessages, locale: string): void
  hide(): void
}

declare global {
  interface Window { createDownloadControls(control: UpdateDownloadPanelProps['control'], close?: () => void): DownloadControls }
}

const iconIds: readonly IconSymbolId[] = ['dsw-icon-close-outline-regular', 'dsw-icon-chevron-down-outline-regular',
  'dsw-icon-download-outline-regular', 'dsw-icon-clock-outline-regular', 'dsw-icon-gauge-outline-regular',
  'dsw-icon-globe-outline-regular', 'dsw-icon-info-outline-regular', 'dsw-icon-pause-outline-regular',
  'dsw-icon-play-outline-regular', 'dsw-icon-refresh-outline-regular', 'dsw-icon-shield-outline-regular', 'dsw-icon-check-outline-regular']

function Sprite() {
  return <svg className="download-icon-sprite" aria-hidden="true"><defs>
    {iconIds.map(id => <symbol key={id} id={id} viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICON_SYMBOLS[id] }} />)}
  </defs></svg>
}

window.createDownloadControls = (control, close) => {
  const container = document.getElementById('download-controls')
  if (container === null) throw new Error('desktop update: missing download control root')
  const root = createRoot(container)
  const closeButton = document.getElementById('close')
  const hide = (): void => {
    container.hidden = true
    document.body.classList.remove('download-dialog')
    flushSync(() => { root.render(null) })
  }
  window.addEventListener('pagehide', () => { root.unmount() }, { once: true })
  return {
    hide,
    render(state, messages, locale) {
      if (state.download === undefined || state.phase === 'ready' || state.phase === 'installing') { hide(); return }
      container.hidden = false
      document.body.classList.add('download-dialog')
      flushSync(() => {
        root.render(<><Sprite /><UpdateDownloadPanel state={state} messages={messages} locale={locale} control={control} close={close} />
          {closeButton !== null && createPortal(<IconCloseOutlineRegular />, closeButton)}</>)
      })
    },
  }
}
