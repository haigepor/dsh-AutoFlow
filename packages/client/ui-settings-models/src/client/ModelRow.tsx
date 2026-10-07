/** Shared model fields and actions for both adapter catalog editors. */

import type { DragEvent, ReactNode } from 'react'
import { useId, useRef, useState } from 'react'
import {
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconTrashOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import { ModelInputTypes } from './ModelInputTypes.tsx'
import { AnimatedDisclosure } from './AnimatedDisclosure.tsx'
import { ModelReasoningCapabilities, ModelReasoningDefault } from './ModelReasoningCapabilities.tsx'
import type { ModelReasoningOptions } from './model-reasoning.ts'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-api-remotes/client'
import styles from './ModelsSection.module.css'

/** A capacity's editable text and adapter-specific inherited hint. */
interface CapacityInput {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onPreset?: (value: string) => void
  onBlur?: () => void
}

/** Common context capacities; the text input remains available for custom values. */
const CONTEXT_WINDOW_PRESETS = ['128K', '256K', '512K', '1M', '2M', '4M'] as const

/** Adapter-owned data and actions for one model row. */
interface ModelRowProps {
  model: DeepSeekModelDraft
  position: number
  total: number
  inputField: 'inputModalities' | 'input'
  inputFallback?: readonly string[] | undefined
  inputLoading?: boolean
  reasoningOptions?: ModelReasoningOptions | undefined
  reasoningInherited?: LlmModelReasoningInfo | undefined
  expanded: boolean
  disabled: boolean
  t: (key: ModelsKey) => string
  contextWindow: CapacityInput
  maxTokens: CapacityInput
  onFieldChange: (field: 'id' | 'name', value: string | undefined) => void
  onIdBlur?: (value: string) => void
  onChange: (model: DeepSeekModelDraft) => void
  onToggle: () => void
  onRemove: () => void
  dragging: boolean
  dropTarget: boolean
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onMove: (to: number) => void
}

/**
 * Render consistent model identity, capacity, and input-type controls.
 * @param props - drafted fields and their owning editor's actions.
 * @returns one expandable model entry.
 */
export function ModelRow(props: ModelRowProps): ReactNode {
  const { model, position, t, disabled } = props
  const entryRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const reasoningProps = {
    model, position, t, disabled, onChange: props.onChange, direct: props.inputField === 'inputModalities',
    options: props.reasoningOptions ?? { levels: [], formats: [] }, inherited: props.reasoningInherited,
  }
  return (
    <div ref={entryRef} className={`${styles['modelEntry']} ${props.dragging ? styles['modelDragging'] : ''} ${props.dropTarget ? styles['modelDropTarget'] : ''}`}
      onDragOver={props.onDragOver} onDrop={props.onDrop}>
      <div className={styles['modelRow']}>
        <div className={styles['modelOrder']}>
          <span className={styles['modelOrderNumber']}>{String(position).padStart(2, '0')}</span>
          <button type="button" className={styles['modelDragHandle']} disabled={disabled || props.total < 2}
            draggable={!disabled && props.total > 1} data-model-order-position={position}
            aria-label={`${t('reorderModel')} ${String(position)}`} title={t('reorderModel')}
            onDragStart={props.onDragStart} onDragEnd={props.onDragEnd}
            onKeyDown={(event) => {
              const to = event.key === 'ArrowUp' ? position - 1 : event.key === 'ArrowDown' ? position + 1 : position
              if (to === position || to < 1 || to > props.total) return
              event.preventDefault()
              const list = event.currentTarget.closest('[data-model-list]')
              props.onMove(to - 1)
              requestAnimationFrame(() => {
                list?.querySelector<HTMLButtonElement>(`[data-model-order-position="${String(to)}"]`)?.focus()
              })
            }}>
            <span className={styles['modelGrip']} aria-hidden="true" />
          </button>
        </div>
        {(['id', 'name'] as const).map(field => (
          <label className={styles['modelIdentityField']} key={field}>
            <span className={styles['modelMobileLabel']}>{t(field === 'id' ? 'modelId' : 'modelName')}</span>
            <input
              className={styles['input']}
              type="text"
              value={typeof model[field] === 'string' ? model[field] : ''}
              placeholder={t(field === 'id' ? 'modelId' : 'modelName')}
              aria-label={`${t(field === 'id' ? 'modelId' : 'modelName')} ${String(position)}`}
              disabled={disabled}
              onChange={(event) => {
                const value = event.target.value
                props.onFieldChange(field, field === 'name' && value === '' ? undefined : value)
              }}
              onBlur={field === 'id' ? event => props.onIdBlur?.(event.target.value) : undefined}
            />
          </label>
        ))}
        <ModelReasoningDefault {...reasoningProps} onConfigure={() => {
          if (!props.expanded) props.onToggle()
          requestAnimationFrame(() => {
            const editor = entryRef.current?.querySelector<HTMLElement>('[data-reasoning-editor]')
            editor?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
            editor?.focus()
          })
        }} />
        <button
          type="button"
          className={styles['iconButton']}
          aria-label={`${t('modelAdvanced')} ${String(position)}`}
          aria-expanded={props.expanded}
          aria-controls={panelId}
          title={t('modelAdvanced')}
          onClick={props.onToggle}
        >
          <span className={styles['modelChevron']} data-open={props.expanded}><IconChevronRightOutlineRegular /></span>
        </button>
        <button
          type="button"
          className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
          aria-label={`${t('removeModel')} ${String(position)}`}
          title={t('removeModel')}
          disabled={disabled}
          onClick={props.onRemove}
        >
          <IconTrashOutlineRegular size={14} />
        </button>
      </div>
      <AnimatedDisclosure open={props.expanded} id={panelId}>
        <div className={styles['modelAdvanced']}>
          {(['contextWindow', 'maxTokens'] as const).map(field => (
            <label className={styles['modelField']} key={field}>
              <span className={styles['modelFieldLabel']}>{t(field)}</span>
              {field === 'contextWindow' ? <div className={styles['capacityControl']}>
                <input
                  className={styles['input']}
                  type="text"
                  inputMode="numeric"
                  value={props[field].value}
                  placeholder={props[field].placeholder}
                  aria-label={`${t(field)} ${String(position)}`}
                  disabled={disabled}
                  onChange={(event) => { props[field].onChange(event.target.value) }}
                  onBlur={props[field].onBlur}
                />
                <Menu open={contextMenuOpen} portal autoFocus selectedId={props[field].value}
                  listClassName={styles['reasoningMenu']}
                  items={CONTEXT_WINDOW_PRESETS.map(value => ({ id: value, label: value }))}
                  onClose={() => { setContextMenuOpen(false) }}
                  onSelect={(value) => {
                    setContextMenuOpen(false)
                    const updateCapacity = props[field].onPreset ?? props[field].onChange
                    updateCapacity(value)
                  }}
                  anchor={<button type="button" className={styles['capacityMenuButton']}
                    aria-label={`${t('contextWindowMenu')} ${String(position)}`} aria-haspopup="menu"
                    aria-expanded={contextMenuOpen} disabled={disabled}
                    onClick={() => { setContextMenuOpen(current => !current) }}>
                    <IconChevronDownOutlineRegular size={14} />
                  </button>} />
              </div> : <input
                className={styles['input']}
                type="text"
                inputMode="numeric"
                value={props[field].value}
                placeholder={props[field].placeholder}
                aria-label={`${t(field)} ${String(position)}`}
                disabled={disabled}
                onChange={(event) => { props[field].onChange(event.target.value) }}
                onBlur={props[field].onBlur}
              />}
            </label>
          ))}
          <ModelInputTypes model={model} field={props.inputField} position={position}
            fallback={props.inputFallback} disabled={disabled || props.inputLoading === true} t={t} onChange={props.onChange} />
          <ModelReasoningCapabilities {...reasoningProps} />
        </div>
      </AnimatedDisclosure>
    </div>
  )
}
