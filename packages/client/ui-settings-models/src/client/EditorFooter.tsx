/**
 * The action row every provider card ends with: dismiss on the left, commit on
 * the right.
 *
 * The two cards commit different things — one creates a route, one edits an
 * existing profile — but the row itself carries no such knowledge. It renders
 * what it is handed, so the cards keep sole ownership of when a commit is
 * allowed and what the in-flight wording is.
 *
 * Cancel refuses input only while a commit is in flight, never because the card
 * is disabled: a card the deployment cannot write to must still be dismissable.
 *
 * @module dsh-client-ui-settings-models/client/EditorFooter
 */

import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'
import connectStyles from './ProviderConnect.module.css'

/** Props of {@link EditorFooter}. */
export interface EditorFooterProps {
  /** Localizer for the row's own labels. */
  t: (key: keyof typeof en) => string
  /** Whether a commit is in flight; holds Cancel and swaps the commit label. */
  busy: boolean
  /** Whether the commit is refused, as judged by the owning card. */
  submitDisabled: boolean
  /** Commit label while idle. */
  submitLabelKey: keyof typeof en
  /** Commit label while a commit is in flight. */
  submitBusyLabelKey: keyof typeof en
  /** Dismiss label; defaults to the settings editor copy. */
  cancelLabelKey?: keyof typeof en
  /** Show the provider-setup footer guidance and spacing. */
  connecting?: boolean
  /** Page heading that hosts these actions; the card still owns commit state. */
  actionsTarget?: HTMLElement | null | undefined
  /** Secondary provider action that remains visible beside the pinned save controls. */
  leading?: ReactNode
  /** Dismiss the card without committing. */
  onCancel: () => void
  /** Run the card's commit. */
  onSubmit: () => void
}

/**
 * Render one provider card's action row.
 * @param props - the labels, commit gating, and handlers the owning card supplies.
 * @returns the cancel/commit row.
 */
export function EditorFooter(props: EditorFooterProps): ReactNode {
  const { t } = props
  const actions = (
    <div className={`${styles['editorActions']} ${props.actionsTarget != null ? connectStyles['headerActions'] : props.connecting === true ? connectStyles['footer'] : ''}`}>
      {props.leading === undefined ? null : <div className={styles['editorSecondaryAction']}>{props.leading}</div>}
      {props.connecting === true && props.actionsTarget == null && <p>{t('providerFooterHint')}</p>}
      <Button
        variant="outline"
        disabled={props.busy}
        onClick={props.onCancel}
      >
        {t(props.cancelLabelKey ?? 'cancel')}
      </Button>
      <Button
        variant="primary"
        icon={props.actionsTarget != null && !props.busy ? <IconPlusOutlineRegular size={16} /> : undefined}
        disabled={props.submitDisabled}
        onClick={props.onSubmit}
      >
        {props.busy ? t(props.submitBusyLabelKey) : t(props.submitLabelKey)}
      </Button>
    </div>
  )
  return props.actionsTarget == null ? actions : createPortal(actions, props.actionsTarget)
}
