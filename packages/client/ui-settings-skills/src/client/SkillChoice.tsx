/** Shared labelled selectors for skills filters and dialog fields. */
import { useState } from 'react'
import { Button, IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SkillSettings.module.css'

/** Select an explicit option through the shared, portaled Menu.
 * @param props - visible field label, selected identity, choices and selection callback.
 * @returns accessible menu anchor and options.
 */
export function SkillChoice({
  label,
  value,
  items,
  onChange,
  showLabel = false,
  disabled = false,
}: {
  label: string
  value: string
  items: { id: string; label: string }[]
  onChange: (id: string) => void
  showLabel?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      portal
      minWidthFromAnchor
      className={css.choiceAnchor}
      items={items}
      selectedId={value}
      onSelect={(id) => {
        onChange(id)
        setOpen(false)
      }}
      onClose={() => {
        setOpen(false)
      }}
      anchor={
        <Button
          variant="outline"
          className={css.choice ?? ''}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled || items.length === 0}
          onClick={() => {
            setOpen(!open)
          }}
        >
          {showLabel ? <span className={css.choiceLabel}>{label}</span> : null}
          <span className={css.choiceValue}>{items.find(item => item.id === value)?.label ?? label}</span>
          <IconChevronDownOutlineRegular size={14} />
        </Button>
      }
    />
  )
}
