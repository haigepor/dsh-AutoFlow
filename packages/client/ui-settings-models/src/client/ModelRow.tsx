/** Shared model fields and actions for both adapter catalog editors. */

import type { DragEvent, InputHTMLAttributes, ReactNode } from 'react'
import { useId, useRef, useState } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconEditOutlineRegular,
  IconCodeOutlineRegular, IconContextInjectionOutlineRegular, IconSendOutlineRegular, Input,
  IconTrashOutlineRegular, Menu, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import { ModelInputTypes } from './ModelInputTypes.tsx'
import { AnimatedDisclosure } from './AnimatedDisclosure.tsx'
import { ModelReasoningCapabilities, ModelReasoningDefault } from './ModelReasoningCapabilities.tsx'
import { ModelReasoningEfforts } from './ModelReasoningEfforts.tsx'
import { modelReasoningLevels, type ModelReasoningOptions } from './model-reasoning.ts'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-api-remotes/client'
import styles from './ModelsSection.module.css'
import connectStyles from './ProviderConnect.module.css'
import directoryStyles from './ModelsDirectory.module.css'
import { ModelEditorDialog } from './ModelEditorDialog.tsx'
import { EditorIntroduction } from './EditorIntroduction.tsx'
import { ProviderFieldIcon } from './ProviderFieldIcon.tsx'
import { FieldHelp } from './FieldHelp.tsx'

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
  /** Summary row whose model fields open in a separate draft dialog. */
  compact?: boolean
  single?: boolean
  model: DeepSeekModelDraft
  position: number
  total: number
  inputField: 'inputModalities' | 'input'
  inputFallback?: readonly string[] | undefined
  inputLoading?: boolean
  reasoningOptions?: ModelReasoningOptions | undefined
  reasoningInherited?: LlmModelReasoningInfo | undefined
  /** Levels the row's `reasoningEfforts` may declare; absent or empty shows no reasoning control. */
  reasoningLevels?: readonly string[] | undefined
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
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDrop: (event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onMove: (to: number) => void
}

/**
 * Render consistent model identity, capacity, and input-type controls.
 * @param props - drafted fields and their owning editor's actions.
 * @returns one model entry in its owning editor.
 */
export function ModelRow(props: ModelRowProps): ReactNode {
  const { model, position, t, disabled } = props
  const entryRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const detailed = props.single === true || props.compact === true
  const Field = detailed ? 'div' : 'label'
  const reasoningProps = {
    model, position, t, disabled, onChange: props.onChange, direct: props.inputField === 'inputModalities',
    options: props.reasoningOptions ?? { levels: [], formats: [] }, inherited: props.reasoningInherited,
    showHelp: detailed,
  }
  const identityFields = (
    (['id', 'name'] as const).map((field) => {
      const label = t(field === 'id' ? 'modelId' : 'modelName')
      const attributes: InputHTMLAttributes<HTMLInputElement> = {
        type: 'text', value: typeof model[field] === 'string' ? model[field] : '', placeholder: label,
        'aria-label': `${label} ${String(position)}`, disabled,
        onChange: (event) => {
          const value = event.target.value
          props.onFieldChange(field, field === 'name' && value === '' ? undefined : value)
        },
        onBlur: field === 'id' ? event => props.onIdBlur?.(event.target.value) : undefined,
      }
      return <Field className={styles['modelIdentityField']} key={field}>
        <span className={styles['modelMobileLabel']}>{label}
          {detailed && <FieldHelp title={label} text={t(field === 'id' ? 'modelIdHelp' : 'modelNameHelp')} t={t} />}
        </span>
        {detailed ? <Input {...attributes} className={styles['modelTextInput'] as string}
          icon={field === 'id' ? <IconCodeOutlineRegular size={16} /> : <ProviderFieldIcon kind="name" />} />
          : <input {...attributes} className={styles['input']} />}
      </Field>
    })
  )
  const defaultReasoning = (
    <ModelReasoningDefault {...reasoningProps} onConfigure={() => {
      if (!props.expanded) props.onToggle()
      requestAnimationFrame(() => {
        const editor = formRef.current?.querySelector<HTMLElement>('[data-reasoning-editor]')
        editor?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
        editor?.focus()
      })
    }} />
  )
  const capacityFields = (
    (['contextWindow', 'maxTokens'] as const).map((field) => {
      const attributes: InputHTMLAttributes<HTMLInputElement> = {
        type: 'text', inputMode: 'numeric', value: props[field].value, placeholder: props[field].placeholder,
        'aria-label': `${t(field)} ${String(position)}`, disabled,
        onChange: (event) => { props[field].onChange(event.target.value) }, onBlur: props[field].onBlur,
      }
      const input = <input {...attributes} className={styles['input']} />
      return (
        <Field className={styles['modelField']} key={field}>
          <span className={styles['modelFieldLabel']}>{t(field)}
            {detailed && <FieldHelp title={t(field)} text={t(field === 'contextWindow' ? 'modelContextHelp' : 'modelOutputHelp')} t={t} />}
          </span>
          {field === 'contextWindow' ? <div className={styles['capacityControl']}>
            {detailed && <IconContextInjectionOutlineRegular size={16} />}
            {input}
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
          </div> : detailed ? <Input {...attributes} className={styles['modelTextInput'] as string} icon={<IconSendOutlineRegular size={16} />} /> : input}
        </Field>
      )
    })
  )
  const inputTypes = (
    <ModelInputTypes model={model} field={props.inputField} position={position}
      fallback={props.inputFallback} disabled={disabled || props.inputLoading === true}
      showHelp={detailed} t={t} onChange={props.onChange} />
  )
  const capabilityFields = (
    props.reasoningOptions === undefined && props.reasoningLevels !== undefined && props.reasoningLevels.length > 0
      ? <ModelReasoningEfforts model={model} levels={props.reasoningLevels} position={position}
        disabled={disabled} t={t} onChange={props.onChange} />
      : <ModelReasoningCapabilities {...reasoningProps} />
  )

  const orderControl = (
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
  )

  const modelForm = <div ref={formRef} className={styles['singleModelForm']}>
    <section className={styles['singleFormSection']} aria-label={t('modelBasicSection')}>
      <h3>{t('modelBasicSection')}</h3>
      <div className={styles['singleFormGrid']}>{identityFields}</div>
    </section>
    <section className={styles['singleFormSection']} aria-label={t('modelCapacitySection')}>
      <h3>{t('modelCapacitySection')}</h3>
      <div className={styles['singleFormGrid']}>{capacityFields}</div>
      {inputTypes}
    </section>
    <section className={styles['singleFormSection']} aria-label={t('modelReasoningSection')}>
      <h3>{t('modelReasoningSection')}</h3>
      {defaultReasoning}
      {capabilityFields}
    </section>
  </div>

  if (props.single === true) return <div ref={entryRef}>{modelForm}</div>

  if (props.compact === true) {
    const id = typeof model['id'] === 'string' ? model['id'] : ''
    const name = typeof model['name'] === 'string' && model['name'].length > 0 ? model['name'] : id || t('providerUntitledModel')
    const declaredInput = model[props.inputField]
    const modalities = Array.isArray(declaredInput) && declaredInput.length > 0 ? declaredInput : props.inputFallback ?? ['text']
    const reasoning = modelReasoningLevels(model, props.reasoningOptions ?? { levels: [], formats: [] }, props.reasoningInherited,
      props.inputField === 'inputModalities').some(level => level !== 'off')
    return <tr className={`${props.dragging ? styles['modelDragging'] : ''} ${props.dropTarget ? styles['modelDropTarget'] : ''}`}
      onDragOver={props.onDragOver} onDrop={props.onDrop}>
      <td><div className={connectStyles['tableIdentity']}>
        {orderControl}<div className={connectStyles['previewIdentity']} id={`${panelId}-identity`}>
          <span>{name}</span>{id !== name && id.length > 0 && <code>{id}</code>}
        </div>
      </div></td>
      <td>
        <div className={`${connectStyles['compactTags']} ${directoryStyles['capabilities']}`}>
          {modalities.includes('image') && <Tag tone="info">{t('modelInputImage')}</Tag>}
          {modalities.includes('text') && <Tag tone="success">{t('modelInputText')}</Tag>}
          {reasoning && <Tag tone="neutral" className={directoryStyles['reasoningTag']}>{t('directoryReasoning')}</Tag>}
        </div></td>
      <td className={connectStyles['tableCapacity']}>{props.contextWindow.value || t('directoryInherited')}</td>
      <td><div className={connectStyles['tableActions']}>
        <Button variant="ghost" size="sm" icon={<IconEditOutlineRegular size={14} />}
          aria-label={`${t('modelAdvanced')} ${String(position)}`} aria-describedby={`${panelId}-identity`}
          aria-haspopup="dialog" disabled={disabled} onClick={props.onToggle}>{t('edit')}</Button>
        <Tooltip label={t('removeModel')} portal><Button variant="ghost" size="sm" className={`${styles['iconButton']} ${connectStyles['tableRemove']}`}
          aria-label={`${t('removeModel')} ${String(position)}`} disabled={disabled} onClick={props.onRemove}><IconTrashOutlineRegular size={14} /></Button></Tooltip>
      </div>
      <ModelEditorDialog open={props.expanded} onClose={props.onToggle} t={t}
        footer={<div className={connectStyles['modelDialogFooter']}>
          <p>{t('providerModelDraftHint')}</p>
          <Button variant="primary" onClick={props.onToggle}>{t('providerModelDone')}</Button>
        </div>}>
        <section className={`${styles['detail']} ${directoryStyles['editorSurface']}`} data-model-editor="true">
          <div className={styles['providerDetail']}>
            <EditorIntroduction kind="model" title={id.length === 0 ? t('addModel') : name}
              description={t('modelEditorDraftDescription')} t={t} />
            <div className={connectStyles['modelDialogBody']}>{modelForm}</div>
          </div>
        </section>
      </ModelEditorDialog></td>
    </tr>
  }

  return (
    <div ref={entryRef} className={`${styles['modelEntry']} ${props.dragging ? styles['modelDragging'] : ''} ${props.dropTarget ? styles['modelDropTarget'] : ''}`}
      onDragOver={props.onDragOver} onDrop={props.onDrop}>
      <div className={styles['modelRow']}>
        {orderControl}
        {identityFields}
        {defaultReasoning}
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
          {capacityFields}
          {inputTypes}
          {capabilityFields}
        </div>
      </AnimatedDisclosure>
    </div>
  )
}
