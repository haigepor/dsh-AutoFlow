/**
 * The card that declares a provider pi-ai does not ship — an OpenAI-compatible
 * gateway, a self-hosted server, or a provider newer than the installed
 * catalog.
 *
 * This is a create, not an edit, which is why it is its own form rather than
 * the provider editor with extra fields: the route id is being *chosen* here,
 * and the settings address does not exist until it is. Each new draft starts
 * with an unused random id that remains editable and survives rerenders.
 * It renders as the
 * custom-API panel of the section's add card; the card's mode switch names it
 * when both modes are offered, and with the custom mode alone the card shows
 * this form directly. One `settings.mutate` sets the whole profile at
 * `providers.<route>`; the key travels separately through `credentials/set`
 * under the reference the profile records, exactly as an existing provider's
 * key does.
 *
 * The three fields a hand-declared route cannot default — endpoint, protocol,
 * and at least one model — are required here rather than at load, so the
 * failure names the field while the user is still looking at it.
 *
 * Reasoning defaults and supported levels belong to individual model rows.
 * Their edits preserve the route's existing protocol compatibility fields.
 */

import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Button, IconChevronRightOutlineRegular, IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { ProviderFieldIcon } from './ProviderFieldIcon.tsx'
import { AnimatedDisclosure } from './AnimatedDisclosure.tsx'
import connectStyles from './ProviderConnect.module.css'
import { apiKeyFailure } from './apiKey.ts'
import { ApiKeyInput } from './ApiKeyInput.tsx'
import { EditorFooter } from './EditorFooter.tsx'
import { validateDeepSeekModels } from './DeepSeekModelsEditor.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import type { ModelReasoningOptions } from './model-reasoning.ts'
import type { ModelDraft } from './ModelListEditor.tsx'
import { validateReasoningEfforts } from './ModelReasoningEfforts.tsx'
import { deriveKeyRef } from './store.ts'
import { ProtocolPicker } from './ProtocolPicker.tsx'
import { FieldHelp } from './FieldHelp.tsx'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The settings namespace a hand-declared provider is written into. */
const NS = 'llm-pi-ai'

/**
 * A route id usable as a settings key AND as the stem of a credential name.
 * The leading letter is the second half of that: `deriveKeyRef` uppercases the
 * id and replaces every non-alphanumeric run with `_`, and a credential
 * reference is a POSIX shell identifier, which cannot start with a digit. A
 * digit-leading id passes every check this card makes and then fails at the
 * credential seam with a raw regular expression the user cannot act on.
 */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Generate an editable default id unused in the current provider directory. */
function createRouteId(taken: readonly string[]): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const base = `custom-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
  let candidate = base
  // A finite directory collision must not depend on another random draw.
  for (let suffix = 2; taken.includes(candidate); suffix++) candidate = `${base}-${String(suffix)}`
  return candidate
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Props of {@link CustomProviderCard}. */
export interface CustomProviderCardProps {
  /** Schema-owned reasoning configuration offered by the adapter. */
  reasoningOptions?: ModelReasoningOptions | undefined
  /** Route ids already declared, so the card refuses to shadow one. */
  taken: readonly string[]
  /** Wire protocols the adapter can serve, in the order it reports them. */
  protocols: readonly string[]
  /** Reasoning levels the adapter's schema accepts, in escalation order; empty shows no reasoning control. */
  reasoningLevels: readonly string[]
  /**
   * Revision of the `llm-pi-ai` user section this card opened at, sent with
   * the create so a route another tab declared meanwhile is a refusal rather
   * than a silent overwrite of its whole profile.
   */
  revision: number
  /** The Host operations this card writes and interrogates through. */
  operations: ModelsOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Optional page heading for the card-owned Cancel and create actions. */
  actionsTarget?: HTMLElement | null | undefined
  /** Close the card; `changed` reports whether a provider was created. */
  onClose: (changed: boolean) => void
  /**
   * Called once per change with whether the create or the list's endpoint
   * interrogation is in flight, so the owner can hold its surface still.
   */
  onBusyChange?: (busy: boolean) => void
}

/**
 * Render the custom-provider creation card.
 * @param props - existing routes, protocol choices, wire faces, and copy.
 * @returns the creation card.
 */
export function CustomProviderCard(props: CustomProviderCardProps): ReactNode {
  const { taken, protocols, reasoningLevels, operations, t, onBusyChange } = props
  // The write is checked against the revision on which this draft was opened.
  const [openedAt] = useState(() => props.revision)
  const [route, setRoute] = useState(() => createRouteId(taken))
  const [displayName, setDisplayName] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const advancedId = useId()
  const [baseURL, setBaseURL] = useState('')
  const [protocol, setProtocol] = useState(protocols[0] ?? '')
  const [keyDraft, setKeyDraft] = useState('')
  const [models, setModels] = useState<readonly ModelDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [listBusy, setListBusy] = useState(false)
  useEffect(() => { onBusyChange?.(busy || listBusy) }, [busy, listBusy, onBusyChange])
  const [failure, setFailure] = useState<string | undefined>(undefined)
  /**
   * The profile write landed. Only the key write can still be outstanding, so
   * the fields that describe the provider are settled and the retry path is
   * the credential alone.
   */
  const [committed, setCommitted] = useState(false)
  const disabled = props.readOnly || busy
  /** Everything but the key stops being editable once the provider exists. */
  const profileDisabled = disabled || committed

  const routeInvalid = route.length > 0 && !ROUTE_PATTERN.test(route)
  const routeTaken = taken.includes(route)
  const advancedVisible = advancedOpen || routeInvalid || routeTaken || route.length === 0
  const normalizedBaseURL = baseURL.trim()
  const baseUrlInvalid = baseURL.length > 0 && !isHttpUrl(normalizedBaseURL)
  // Rows are checked by the same per-row validator the editor cards use, so a
  // bad row is named by its position here too. Capacities have route-level
  // fallbacks; what a route cannot default is at least one model. Every row of
  // this hand-declared route edits its reasoning levels, so they are checked too.
  const modelFailure = validateDeepSeekModels(models) ?? validateReasoningEfforts(models)
  const keyFailure = apiKeyFailure(keyDraft)
  // The typed key with paste whitespace removed. A blank field yields an empty
  // string, which the create path reads as "no key supplied" — a route may
  // legitimately authenticate through the provider's own ambient discovery.
  const keyValue = keyDraft.trim()
  const ready = route.length > 0 && !routeInvalid && !routeTaken
    && normalizedBaseURL.length > 0 && !baseUrlInvalid && models.length > 0 && modelFailure === undefined
    && keyFailure === undefined
  // 字段错误在原位显示，模型行校验在底部指明位置，未填写的初始表单不提前报错。
  const modelHint = failure !== undefined || modelFailure === undefined
    ? undefined : `${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`

  /** Perform the create, returning a failure message or undefined. */
  const createOnce = async (): Promise<string | undefined> => {
    const keyRef = deriveKeyRef(route)
    const storesKey = keyValue.length > 0
    if (!committed) {
      const profile = {
        ...displayName.length === 0 ? {} : { displayName },
        // The profile names the conventional reference only when this card is
        // about to store a key, matching the editor: a route declared with the
        // key left blank keeps its provider-native auth path (a credential
        // chain, ADC) instead of resolving a reference nothing ever sets.
        ...storesKey ? { apiKeyEnv: keyRef } : {},
        api: protocol,
        baseURL: normalizedBaseURL,
        models: models.map(model => ({ ...model })),
      }
      // `taken` is a snapshot too, so the id check alone cannot see a route
      // declared after this card opened; the revision makes that race a
      // `settings-conflict` instead of a write over the other profile.
      const written = await operations.writeSettings(
        NS,
        [{ op: 'set', path: ['providers', route], value: profile as JsonValue }],
        openedAt,
      )
      if (written.kind !== 'written') {
        return written.kind === 'conflict' ? t('conflict') : written.message
      }
      // The provider now exists. A retry after the key write below fails must
      // not re-run this mutate: the revision it holds is the one this write
      // just superseded, so the Host would answer `settings-conflict` and the
      // key could never be stored from this card at all.
      setCommitted(true)
    }
    if (storesKey) {
      const stored = await operations.storeCredential(keyRef, keyValue)
      // The profile landed; saying the key did not is the only honest report,
      // and the retry above now goes straight back to this write.
      if (stored !== undefined) return stored
    }
    return undefined
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const outcome = await createOnce()
      if (outcome !== undefined) {
        setFailure(outcome)
        return
      }
      props.onClose(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`${styles['editor']} ${connectStyles['form']}`}>
      <div className={connectStyles['connectionFields']}>
        <section className={connectStyles['group']} aria-label={t('providerIdentitySection')}>
          <div className={connectStyles['topGrid']}>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('customDisplayName')} <span className={connectStyles['optional']}>{t('providerOptional')}</span></span>
              <div className={connectStyles['endpoint']}><ProviderFieldIcon kind="name" />
                <input className={styles['input']} type="text" value={displayName}
                  placeholder={t('providerNamePlaceholder')} aria-label={t('customDisplayName')} disabled={profileDisabled}
                  onChange={(event) => { setDisplayName(event.target.value) }} />
              </div>
            </div>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('customApi')}</span>
              <ProtocolPicker value={protocol} choices={protocols} disabled={profileDisabled} t={t} onChange={setProtocol} />
            </div>
          </div>
        </section>
        <section className={connectStyles['group']} aria-label={t('providerConnectionSection')}>
          <div className={styles['field']}>
            <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
            <div className={connectStyles['endpoint']}><ProviderFieldIcon kind="endpoint" />
              <input className={styles['input']} type="text" value={baseURL}
                placeholder={t(protocol === 'anthropic-messages' ? 'customAnthropicBaseUrlPlaceholder' : 'customBaseUrlPlaceholder')}
                aria-label={t('baseUrl')} aria-invalid={baseUrlInvalid} disabled={profileDisabled}
                onChange={(event) => { setBaseURL(event.target.value) }} />
            </div>
            {baseUrlInvalid ? <p className={styles['error']}>{t('customBaseUrlInvalid')}</p> : null}
          </div>
          <div className={styles['field']}>
            <span className={styles['fieldLabel']}>{t('keyInput')} <span className={connectStyles['optional']}>{t('providerOptional')}</span></span>
            <ApiKeyInput t={t} icon={<ProviderFieldIcon kind="key" />} value={keyDraft} placeholder={t('keyPlaceholder')} aria-label={t('keyInput')} disabled={disabled}
              onChange={(event) => { setKeyDraft(event.target.value) }} />
            {keyFailure === undefined ? null : <p className={styles['error']}>{t(keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure)}</p>}
          </div>
        </section>

      </div>
      <ModelListEditor
        connecting
        emptyMessage={t('providerModelsEmpty')}
        reasoningOptions={props.reasoningOptions}
        models={models}
        onChange={setModels}
        reasoningLevels={reasoningLevels}
        probe={{
          settingsNs: NS,
          baseURL: normalizedBaseURL,
          api: protocol,
          ...keyValue.length === 0 ? {} : { apiKey: keyValue },
        }}
        probeBlocked={baseUrlInvalid
          ? 'customBaseUrlInvalid'
          : keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure}
        operations={operations}
        t={t}
        disabled={profileDisabled}
        onBusyChange={setListBusy}
      />
      <section className={connectStyles['advanced']}>
        <Button variant="ghost" size="sm" className={connectStyles['advancedToggle']}
          aria-label={t('providerAdvanced')} aria-expanded={advancedVisible} aria-controls={advancedId} onClick={() => { setAdvancedOpen(value => !value) }}>
          <IconSettingsOutlineRegular size={16} />{t('providerAdvanced')}<IconChevronRightOutlineRegular size={14} />
        </Button>
        <AnimatedDisclosure open={advancedVisible} id={advancedId}>
          <div className={connectStyles['advancedBody']}>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('customRoute')}<FieldHelp title={t('customRoute')} text={t('customRouteHint')} t={t} /></span>
              <input className={styles['input']} type="text" value={route} placeholder="acme-gateway" aria-label={t('customRoute')}
                disabled={profileDisabled} onChange={(event) => { setRoute(event.target.value) }} />
              {routeInvalid || routeTaken ? <p className={styles['error']}>{t(routeInvalid ? 'customRouteInvalid' : 'customRouteTaken')}</p> : null}
            </div>
          </div>
        </AnimatedDisclosure>
      </section>

      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      {modelHint === undefined ? null : <p className={styles['advancedHint']}>{modelHint}</p>}
      <EditorFooter
        connecting
        actionsTarget={props.actionsTarget}
        t={t}
        busy={busy}
        submitDisabled={disabled || !ready}
        submitLabelKey="create"
        submitBusyLabelKey="creating"
        onCancel={() => { props.onClose(committed) }}
        onSubmit={() => { void create() }}
      />
    </div>
  )
}
