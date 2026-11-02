/**
 * The session header's agent-preset label.
 *
 * The label selects this Session's preset without changing its history or
 * the new-task default. The Host waits for active work before rebinding.
 */

import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconAgentPresetOutlineRegular, IconChevronDownOutlineRegular, Menu, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { AgentPresetSeatInjected } from './AgentPresetSeat.tsx'
import { requiresCodingTools } from './settings-store.ts'
import { presetDisplayText } from './locales.ts'
import css from './AgentPresetLabel.module.css'
import pickerCss from './AgentPresetSeat.module.css'

/** Registration-side business face for the header label. */
export type AgentPresetLabelInjected = AgentPresetSeatInjected

/** Full component props. */
export type AgentPresetLabelProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetLabelInjected>

/**
 * Render this session's agent-preset name beside its title.
 * @param props - composed slot props.
 * @returns the preset menu, or null when the Session records no preset.
 */
export function AgentPresetLabel({
  sessionId, useSessions, useAgentPresetSeat, useDeveloperTools, load, select, dismissRefusal, t,
}: AgentPresetLabelProps) {
  const preset = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  })
  const state = useAgentPresetSeat(value => value)
  const developerTools = useDeveloperTools(value => value)
  const options = state.options.filter(option => developerTools || !requiresCodingTools(option))
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // Deployments that compose no presets never label anything, so the roster
    // is only worth a request once a session reports one.
    if (preset !== undefined) void load()
  }, [preset, load])

  if (preset === undefined) return null

  const option = state.options.find(entry => entry.id === preset)
  const text = option === undefined ? undefined : presetDisplayText(option, t)
  return (
    <>
      <Menu open={open} onClose={() => { setOpen(false) }} selectedId={preset} align="start" portal
        className={pickerCss.menuAnchor}
        items={options.map((option) => {
          const display = presetDisplayText(option, t)
          return { id: option.id, label: <span className={pickerCss.item}>
            <span className={pickerCss.itemName}>{display.name}</span>
            <span className={pickerCss.itemDesc}>{display.description ?? t('noDescription')}</span>
          </span> }
        })}
        onSelect={(id) => { setOpen(false); void select(id) }}
        anchor={<button type="button" className={css.label} title={t('headerHint')}
          aria-haspopup="menu" aria-expanded={open} disabled={state.busy || options.length === 0}
          onClick={() => { setOpen(value => !value) }}>
          <IconAgentPresetOutlineRegular size={14} className={css.icon} />
          <span className={css.text}>{state.busy ? t('switching') : text?.name ?? preset}</span>
          <IconChevronDownOutlineRegular size={12} className={css.icon} />
        </button>} />
      {state.error !== null && typeof state.error === 'object' && <Toast
        text={t('switchRefused', { name: presetDisplayText(state.error.preset, t).name, reason: state.error.reason })}
        holdMs={8000} onDone={() => { dismissRefusal(state.error) }} />}
    </>
  )
}
