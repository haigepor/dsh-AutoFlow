/** Per-model effort subsets and advanced wire mappings. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Menu, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import { DEFAULT_REASONING_LEVELS, additionalReasoningLevels, modelReasoningLevels, reasoningLabel, validateModelReasoning } from './model-reasoning.ts'
import type { ModelReasoningOptions } from './model-reasoning.ts'
import styles from './ModelsSection.module.css'

/** Shared data for a default picker and its capability editor. */
export interface ModelReasoningProps {
  model: DeepSeekModelDraft
  position: number
  disabled: boolean
  direct: boolean
  options: ModelReasoningOptions
  inherited?: LlmModelReasoningInfo | undefined
  t: (key: ModelsKey) => string
  onChange: (model: DeepSeekModelDraft) => void
}

/**
 * Render the row's default effort using the shared settings menu.
 * @param props - model draft, adapter choices, and capability disclosure action.
 * @returns default picker, including a shortcut to the capability editor.
 */
export function ModelReasoningDefault(props: ModelReasoningProps & { onConfigure: () => void }): ReactNode {
  const { model, position, disabled, options, inherited, direct, t, onChange } = props
  const [open, setOpen] = useState(false)
  const levels = modelReasoningLevels(model, options, inherited, direct)
  const defaultLevels = [...DEFAULT_REASONING_LEVELS.filter(id => id !== 'off'),
    ...(model['reasoningEfforts'] === undefined ? [] : levels.filter(id => id !== 'off'
      && !DEFAULT_REASONING_LEVELS.includes(id as typeof DEFAULT_REASONING_LEVELS[number])))]
  const value = typeof model['defaultReasoningEffort'] === 'string'
    ? model['defaultReasoningEffort']
    : levels.includes('high') ? 'high' : defaultLevels.find(id => levels.includes(id)) ?? ''
  return <div className={styles['modelReasoningCell']}>
    <span className={styles['modelMobileLabel']}>{t('modelReasoning')}</span>
    <Menu open={open} portal autoFocus selectedId={value}
      className={styles['catalogPicker']} listClassName={styles['reasoningMenu']}
      items={[
        ...defaultLevels.map(id => ({ id, label: reasoningLabel(id, t, inherited), disabled: !levels.includes(id) })),
        { id: 'configure-separator', type: 'separator' },
        { id: 'configure', label: t('reasoningConfigure') },
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        if (id === 'configure') { props.onConfigure(); return }
        onChange({ ...model, defaultReasoningEffort: id })
      }}
      anchor={<button type="button" className={`${styles['catalogTrigger']} ${styles['reasoningTrigger']}`}
        aria-label={`${t('modelReasoning')} ${String(position)}`} aria-haspopup="menu" aria-expanded={open}
        disabled={disabled} onClick={() => { setOpen(current => !current) }}>
        <span>{value === '' ? t('reasoningSelectEffort') : reasoningLabel(value, t, inherited)}</span>
        <IconChevronDownOutlineRegular size={14} />
      </button>} />
  </div>
}

/**
 * Render selectable effort subsets without erasing protocol compatibility fields.
 * @param props - schema choices, model draft and owning row callback.
 * @returns supported effort controls and optional advanced mapping fields.
 */
export function ModelReasoningCapabilities(props: ModelReasoningProps): ReactNode {
  const { model, position, disabled, options, inherited, direct, t, onChange } = props
  const [advanced, setAdvanced] = useState(false)
  const [formatOpen, setFormatOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const manual = model['reasoningEfforts'] !== undefined
  const levels = modelReasoningLevels(model, options, inherited, direct)
  const compat = typeof model['compat'] === 'object' && model['compat'] !== null
    ? model['compat'] as Record<string, unknown> : {}
  const format = typeof compat['thinkingFormat'] === 'string' ? compat['thinkingFormat'] : ''
  const declared = model['reasoningEfforts']
  const mapping: Record<string, unknown> = typeof declared === 'object' && declared !== null && !Array.isArray(declared)
    ? declared as Record<string, unknown> : {}
  const writeLevels = (ids: readonly string[]): void => {
    const selected = ids.length === 0 && options.levels.includes('off') ? ['off'] : [...ids]
    const noReasoning = selected.length === 0 || selected.every(id => id === 'off')
    const reasoningEfforts = direct ? selected : noReasoning ? false : Object.fromEntries(selected.map(id => [id,
      Object.hasOwn(mapping, id) ? mapping[id]
        : options.inheritedMapping !== undefined && Object.hasOwn(options.inheritedMapping, id)
          ? options.inheritedMapping[id] : id === 'off' ? null : id]))
    onChange({ ...model, reasoningEfforts })
  }
  const visibleLevels = [...DEFAULT_REASONING_LEVELS,
    ...levels.filter(level => !DEFAULT_REASONING_LEVELS.includes(level as typeof DEFAULT_REASONING_LEVELS[number]))]
  const additions = additionalReasoningLevels(options, levels)
  const issue = validateModelReasoning(model, direct)
  return <section className={styles['modelReasoningCapabilities']} tabIndex={-1} data-reasoning-editor={position}
    aria-label={`${t('reasoningSupported')} ${String(position)}`}>
    <div className={styles['reasoningChips']}>
      {visibleLevels.map(id =>
        <button key={id} type="button" className={styles['reasoningChip']}
          disabled={disabled || (!options.levels.includes(id) && !levels.includes(id))}
          aria-pressed={levels.includes(id)} onClick={() => {
            writeLevels(levels.includes(id) ? levels.filter(level => level !== id) : [...levels, id])
          }}>
          {reasoningLabel(id, t, inherited)}
        </button>)}
      {additions.length > 0 ? <Menu open={addOpen} portal autoFocus listClassName={styles['reasoningMenu']}
        items={additions.map(id => ({ id, label: reasoningLabel(id, t, inherited) }))}
        onClose={() => { setAddOpen(false) }} onSelect={(id) => { setAddOpen(false); writeLevels([...levels, id]) }}
        anchor={<button type="button" className={styles['reasoningAddLevel']} disabled={disabled}
          aria-label={`${t('reasoningAddLevel')} ${String(position)}`} aria-haspopup="menu" aria-expanded={addOpen}
          onClick={() => { setAddOpen(current => !current) }}>{t('reasoningAddLevel')}<IconChevronDownOutlineRegular size={14} /></button>} /> : null}
    </div>
    {issue === undefined ? null : <p className={styles['error']} role="alert">{t(issue)}</p>}
    {!direct && manual && levels.length > 0 ? <>
      <button type="button" className={styles['reasoningAdvancedToggle']} aria-expanded={advanced}
        onClick={() => { setAdvanced(current => !current) }}>{t('reasoningMapping')}
        <IconChevronDownOutlineRegular size={14} />
      </button>
      {advanced ? <div className={styles['reasoningMapping']}>
        {options.formats.length > 0 ? <div className={styles['modelField']}>
          <span className={styles['modelFieldLabel']}>{t('reasoningFormat')}</span>
          <Menu open={formatOpen} portal autoFocus selectedId={format} listClassName={styles['reasoningMenu']}
            items={[{ id: '', label: t('reasoningFormatInherited') }, ...options.formats.map(id => ({ id, label: id }))]}
            onClose={() => { setFormatOpen(false) }} onSelect={(id) => {
              setFormatOpen(false)
              const nextCompat = { ...compat }
              if (id === '') Reflect.deleteProperty(nextCompat, 'thinkingFormat'); else nextCompat['thinkingFormat'] = id
              const next = { ...model }
              if (Object.keys(nextCompat).length === 0) Reflect.deleteProperty(next, 'compat'); else next['compat'] = nextCompat
              onChange(next)
            }} anchor={<button type="button" className={styles['catalogTrigger']} disabled={disabled}
              aria-label={`${t('reasoningFormat')} ${String(position)}`} aria-haspopup="menu" aria-expanded={formatOpen}
              onClick={() => { setFormatOpen(current => !current) }}>{format || t('reasoningFormatInherited')}<IconChevronDownOutlineRegular size={14} /></button>} />
        </div> : null}
        {levels.map(id => <label key={id} className={styles['modelField']}>
          <span className={styles['modelFieldLabel']}>{reasoningLabel(id, t, inherited)}</span>
          <input className={styles['input']} disabled={disabled} value={typeof mapping[id] === 'string' ? mapping[id] : ''}
            aria-label={`${t('reasoningWire')} ${id} ${String(position)}`} placeholder={id === 'off' ? t('reasoningOffWireHint') : id}
            onChange={event => onChange({ ...model, reasoningEfforts: { ...mapping, [id]: event.target.value === '' && id === 'off' ? null : event.target.value } })} />
        </label>)}
      </div> : null}
    </> : null}
  </section>
}
