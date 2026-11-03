/** Download presentation using the shared controls; privileged operations stay in the shell preload. */
import { useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives/src/Input.tsx'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives/src/Tag.tsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives/src/Tooltip.tsx'
import { IconChevronDownOutlineRegular, IconClockOutlineRegular, IconDownloadOutlineRegular,
  IconGaugeOutlineRegular, IconGlobeOutlineRegular, IconInfoOutlineRegular, IconPauseOutlineRegular,
  IconPlayOutlineRegular, IconRefreshOutlineRegular, IconShieldOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/src/icons/index.tsx'
import type { DesktopUpdateState } from '../update-state.ts'
import { DESKTOP_RELEASE_NOTE_CATEGORIES } from '../update-release-notes.ts'
import { formatDesktopMessage, type DesktopMessages } from '../locale.ts'
import s from './UpdateDownloadPanel.module.css'

/** Main-owned progress and commands rendered by both update documents. */
export interface UpdateDownloadPanelProps {
  readonly state: DesktopUpdateState
  readonly messages: DesktopMessages
  readonly locale: string
  readonly control: (action: string, version: string, choice?: unknown) => Promise<void>
  /** Absent for mandatory updates; ordinary updates can continue in the background. */
  readonly close?: (() => void) | undefined
}

/**
 * @param props - Checked update data, localized copy, and isolated shell actions.
 * @returns Stable download controls; progress updates retain local menu and input state.
 */
export function UpdateDownloadPanel({ state, messages: m, locale, control, close }: UpdateDownloadPanelProps) {
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const [prefix, setPrefix] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const command = useRef(false)
  const data = state.download
  const notes = state.releaseNotes
  if (data === undefined) return null
  const paused = data.stage === 'paused'
  const active = state.phase === 'downloading'
  const verifying = state.phase === 'verifying'
  const percent = Math.min(100, Math.max(0, data.total === 0 ? state.percent ?? 0 : data.transferred / data.total * 100))
  const bytes = (value: number): string => {
    const unit = value < 1024 ** 2 ? 'KiB' : 'MiB'
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / (unit === 'KiB' ? 1024 : 1024 ** 2))} ${unit}`
  }
  const choices = [{ id: 'auto', name: m.downloadAuto }, ...data.sources, { id: 'custom', name: m.downloadCustom }]
  const selection = choices.find(item => item.id === data.choice.source)?.name ?? m.downloadAuto
  const source = choices.find(item => item.id === data.source)?.name
  const status = data.stage === 'probing' ? m.downloadProbing : paused ? m.downloadPaused
    : verifying ? m.updateVerifying : state.phase === 'error' ? m.updateDownloadFailed : active ? m.downloadRunning : m.downloadSaved

  async function act(action: string, choice?: unknown): Promise<void> {
    if (command.current || state.version === undefined) return
    command.current = true
    setBusy(true); setError(false)
    try { await control(action, state.version, choice) }
    catch { setError(true) }
    finally { command.current = false; setBusy(false) }
  }

  return <div className={s.panel}>
    <div className={s.hero}>
      <div className={s.summary}>
        <div className={s.statusHeader}>
          <Tag tone="info">{state.version}</Tag>
          <div id="download-status" className={s.status} role="status" aria-live="polite">
            <StateDot state={paused ? 'warning' : state.phase === 'error' ? 'error' : active || verifying ? 'ongoing' : 'idle'} />
            {status}
          </div>
        </div>
        <div className={s.percent}>{percent < 1
          ? new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(percent) : Math.floor(percent)}<span>%</span></div>
        <p className={s.amount} data-download-amount>{bytes(data.transferred)} <span>/ {data.total === 0 ? '—' : bytes(data.total)}</span></p>
      </div>
      <div className={s.art} aria-hidden="true" />
    </div>
    <div className={s.track} role="progressbar" aria-label={status} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(percent)}>
      <div className={s.fill} style={{ '--download-progress': `${percent}%` } as CSSProperties} />
    </div>
    <dl className={s.facts}>
      <div><dt><IconGaugeOutlineRegular />{m.downloadSpeed}</dt><dd data-download-speed>{bytes(data.bytesPerSecond)}/s</dd></div>
      <div><dt><IconClockOutlineRegular />{m.downloadEta}</dt><dd data-download-eta>{data.remainingSeconds === undefined
        ? '—' : formatDesktopMessage(m.downloadRemaining, { seconds: String(data.remainingSeconds) })}</dd></div>
    </dl>
    <div className={s.sourceHeader}>
      <span className={s.label}>{m.downloadSource}<Tooltip label={m.downloadMirrorHint} portal side="top">
        <Button size="sm" className={s.info} aria-label={m.downloadMirrorHint} icon={<IconInfoOutlineRegular />} />
      </Tooltip></span>
      <Button size="sm" icon={<IconRefreshOutlineRegular />} disabled={busy || verifying}
        onClick={() => { void act('retest') }}>{m.downloadRetest}</Button>
    </div>
    <Menu open={menu} onClose={() => { setMenu(false) }} portal minWidthFromAnchor autoFocus
      className={s.menu} selectedId={data.choice.source}
      items={choices.map(item => ({ id: item.id, label: item.name }))}
      onSelect={(id) => {
        setMenu(false)
        if (id === 'custom') { setEditing(true); setPrefix(undefined) }
        else { setEditing(false); void act('source', { source: id }) }
      }}
      anchor={<Button id="download-source" data-source={data.choice.source} variant="outline" className={s.source}
        icon={<IconGlobeOutlineRegular />} aria-label={m.downloadSource} aria-haspopup="menu" aria-expanded={menu}
        disabled={busy || verifying} onClick={() => { setMenu(!menu) }}>
        <span>{selection}{data.choice.source === 'auto' && source !== undefined && <span className={s.route}> · {source}</span>}</span>
        <IconChevronDownOutlineRegular />
      </Button>} />
    {(editing || data.choice.source === 'custom') && <div className={s.custom}>
      <Input id="download-prefix" aria-label={m.downloadPrefix} type="url" placeholder="https://proxy.example/"
        spellCheck={false} maxLength={2048} value={prefix ?? data.choice.customPrefix ?? ''} disabled={busy || verifying}
        onChange={(event) => { setPrefix(event.target.value) }} />
      <Button size="sm" variant="outline" disabled={busy || verifying}
        onClick={() => { void act('source', { source: 'custom', customPrefix: prefix ?? data.choice.customPrefix ?? '' }) }}>{m.downloadApply}</Button>
    </div>}
    <p className={s.error} role="alert" hidden={!error}>{m.downloadControlFailed}</p>
    <section className={s.notes} data-update-notes>
      <h2 id="download-notes-title">{m.releaseNotesTitle}</h2>
      <div className={s.notesScroll} tabIndex={0} role="region" aria-label={m.releaseNotesTitle}>
        {notes === undefined ? <p className={s.notesEmpty}>{m.releaseNotesMissing}</p>
          : DESKTOP_RELEASE_NOTE_CATEGORIES.map((category) => {
            const items = notes.items.filter(item => item.category === category)
            if (items.length === 0) return null
            const heading = { features: m.releaseNotesFeatures, improvements: m.releaseNotesImprovements,
              fixes: m.releaseNotesFixes, other: m.releaseNotesOther }[category]
            return <div key={category} className={s.noteGroup}><h3>{heading}</h3><ul>{items.map(item => <li key={item.id}>
              {locale.startsWith('zh') ? item.text['zh-CN'] : item.text.en}
            </li>)}</ul></div>
          })}
      </div>
    </section>
    <div className={s.footer}>
      <p className={s.safety}><IconShieldOutlineRegular />{m.downloadSafetyNote}</p>
      <div className={s.actions}>
        <Button variant={close === undefined ? 'primary' : 'outline'} disabled={busy || verifying}
          data-action={active ? 'pause' : 'resume'} icon={active ? <IconPauseOutlineRegular /> : <IconPlayOutlineRegular />}
          onClick={() => { void act(active ? 'pause' : 'resume') }}>
          {active ? m.downloadPause : data.stage === 'idle' && data.transferred === 0 ? m.updateDownload : m.downloadResume}
        </Button>
        {close !== undefined && <Button variant="primary" onClick={close} icon={active ? <IconDownloadOutlineRegular /> : undefined}>
          {active || verifying ? m.downloadBackground : m.updateClose}
        </Button>}
      </div>
    </div>
  </div>
}
