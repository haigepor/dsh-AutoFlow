/** Protocol choice rendered with the same menu surface as other settings menus. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelsKey } from './locales.ts'
import { protocolLabel } from './protocol-label.ts'
import styles from './ModelsSection.module.css'

/** Render the available wire protocols for a provider profile. */
export function ProtocolPicker({ value, choices, disabled, t, onChange }: {
  value: string | undefined
  choices: readonly string[]
  disabled: boolean
  t: (key: ModelsKey) => string
  onChange: (value: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      portal
      autoFocus
      selectedId={value ?? ''}
      className={styles['catalogPicker']}
      listClassName={styles['catalogMenu']}
      items={[
        ...value === undefined ? [{ id: '', label: t('customApiUnset') }] : [],
        ...choices.map(choice => ({ id: choice, label: protocolLabel(t, choice) })),
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => { onChange(id); setOpen(false) }}
      anchor={(
        <button
          type="button"
          className={styles['catalogTrigger']}
          aria-label={t('customApi')}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => { setOpen(current => !current) }}
        >
          <span>{value === undefined ? t('customApiUnset') : protocolLabel(t, value)}</span>
          <IconChevronDownOutlineRegular size={16} />
        </button>
      )}
    />
  )
}
