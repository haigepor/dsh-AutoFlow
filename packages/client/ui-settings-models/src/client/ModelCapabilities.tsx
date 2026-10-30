/** Per-model native search selection with automatic catalog matching and explicit overrides. */
import { Button, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { nativeWebSearchEnabled, nativeWebSearchMode } from '@deepseek-ai/dsh-llm/native-web-search'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import { FieldHelp } from './FieldHelp.tsx'
import styles from './ModelsSection.module.css'

/**
 * Edit native search without materializing an automatic suggestion as a manual choice.
 * @param props Model draft, selected protocol, discovered capability and owner actions.
 * @returns One capability checkbox and an optional return-to-automatic action.
 */
export function ModelCapabilities({ model, api, reported, disabled, t, onChange }: {
  model: DeepSeekModelDraft
  api: string | undefined
  reported?: boolean | undefined
  disabled: boolean
  t: (key: ModelsKey) => string
  onChange: (model: DeepSeekModelDraft) => void
}) {
  const configured = typeof model['nativeWebSearch'] === 'boolean' ? model['nativeWebSearch'] : undefined
  const discovered = reported ?? (typeof model['nativeWebSearchDefault'] === 'boolean' ? model['nativeWebSearchDefault'] : undefined)
  const supported = nativeWebSearchMode(api) !== undefined
  const checked = nativeWebSearchEnabled(typeof model['id'] === 'string' ? model['id'] : '', api, configured, discovered)
  return <section className={styles['singleFormSection']} aria-label={t('modelCapabilities')}>
    <h3><span className={styles['modelLabelContent']}>{t('modelCapabilities')}
      <FieldHelp title={t('nativeWebSearch')} text={t(supported ? 'nativeWebSearchHelp' : 'nativeWebSearchUnsupported')} t={t} />
    </span></h3>
    <div className={styles['modelInputChoices']}>
      <Checkbox className={styles['modelChoice']} label={t('nativeWebSearch')} checked={checked}
        disabled={disabled || !supported} onChange={(value) => { onChange({ ...model, nativeWebSearch: value }) }} />
      {configured !== undefined && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => {
        const next = { ...model }; Reflect.deleteProperty(next, 'nativeWebSearch'); onChange(next)
      }}>{t('modelCapabilityAuto')}</Button>}
    </div>
  </section>
}
