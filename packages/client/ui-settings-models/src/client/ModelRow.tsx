/** Shared model fields and actions for both adapter catalog editors. */

import type { DragEvent, ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import { ModelInputTypes } from './ModelInputTypes.tsx'
import styles from './ModelsSection.module.css'

/** A capacity's editable text and adapter-specific inherited hint. */
interface CapacityInput {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onBlur?: () => void
}

/** Adapter-owned data and actions for one model row. */
interface ModelRowProps {
  model: DeepSeekModelDraft
  position: number
  total: number
  inputField: 'inputModalities' | 'input'
  inputFallback?: readonly string[] | undefined
  inputLoading?: boolean
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
  return (
    <div className={`${styles['modelEntry']} ${props.dragging ? styles['modelDragging'] : ''} ${props.dropTarget ? styles['modelDropTarget'] : ''}`}
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
        <button
          type="button"
          className={styles['iconButton']}
          aria-label={`${t('modelAdvanced')} ${String(position)}`}
          aria-expanded={props.expanded}
          title={t('modelAdvanced')}
          onClick={props.onToggle}
        >
          {props.expanded ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}
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
      {props.expanded
        ? (
          <div className={styles['modelAdvanced']}>
            {(['contextWindow', 'maxTokens'] as const).map(field => (
              <label className={styles['modelField']} key={field}>
                <span className={styles['modelFieldLabel']}>{t(field)}</span>
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
              </label>
            ))}
            <ModelInputTypes
              model={model} field={props.inputField} position={position}
              fallback={props.inputFallback} disabled={disabled || props.inputLoading === true} t={t} onChange={props.onChange}
            />
          </div>
        )
        : null}
    </div>
  )
}
