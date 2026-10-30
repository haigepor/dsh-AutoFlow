/** Add-model action shared by the provider setup table and settings catalog. */
import { Button, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * Keep the add action consistent across both model catalog editors.
 * @param props - presentation mode, availability, localized label, and draft owner.
 * @returns the catalog's add-model button.
 */
export function AddModelButton(props: {
  connecting: boolean
  disabled: boolean
  t: (key: ModelsKey) => string
  onAdd: () => void
}) {
  return <Button type="button" variant={props.connecting ? 'outline' : 'ghost'} size={props.connecting ? 'md' : 'sm'}
    className={props.connecting ? undefined : styles['addModelButton']} disabled={props.disabled} onClick={props.onAdd}>
    <IconPlusOutlineRegular size={16} />
    {props.t('addModel')}
  </Button>
}
