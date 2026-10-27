/** Model help labels adapt to the shared click-open help primitive. */
import { FieldHelp as SharedFieldHelp } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelsKey } from './locales.ts'

/**
 * Render model guidance with the shared help interaction and menu material.
 * @param props - subject, explanation, optional trigger label, and model locale.
 * @returns the shared help trigger and panel.
 */
export function FieldHelp({ title, text, label, t }: { title: string; text: string; label?: string; t: (key: ModelsKey) => string }) {
  return <SharedFieldHelp title={title} text={text} label={label ?? t('helpFor').replace('{field}', title)} closeLabel={t('close')} />
}
