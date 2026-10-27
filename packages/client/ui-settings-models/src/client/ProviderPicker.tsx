/** Searchable built-in provider directory using the shared menu controls. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconSearchOutlineRegular, Input, Menu, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelsKey } from './locales.ts'
import { ProviderBrandIcon } from './ProviderBrandIcon.tsx'
import styles from './ModelsSection.module.css'
import connectStyles from './ProviderConnect.module.css'

interface ProviderChoice {
  id: string
  label: string
}

const COMMON_PROVIDERS: readonly string[] = ['deepseek', 'openai', 'anthropic', 'google', 'moonshot', 'moonshotai', 'kimi-coding', 'qwen', 'alibaba', 'zai', 'minimax']

function rank(id: string): number {
  const index = COMMON_PROVIDERS.indexOf(id)
  return index < 0 ? COMMON_PROVIDERS.length : index
}

/**
 * Render a provider menu with name/ID search and a stable, common-first order.
 * @param props - available providers, current draft and menu state.
 * @returns the directory trigger and its searchable menu.
 */
export function ProviderPicker({ choices, selected, open, disabled, onOpenChange, onSelect, t }: {
  choices: readonly ProviderChoice[]
  selected: ProviderChoice
  open: boolean
  disabled: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (id: string) => void
  t: (key: ModelsKey) => string
}): ReactNode {
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) { setQuery(''); return }
    // 触屏保留列表视野；桌面在菜单定位完成后聚焦搜索，避免隐藏帧吞掉焦点。
    const frame = requestAnimationFrame(() => {
      if (window.matchMedia('(pointer: fine)').matches) searchRef.current?.focus({ preventScroll: true })
    })
    return () => { cancelAnimationFrame(frame) }
  }, [open])
  const needle = query.trim().toLocaleLowerCase()
  const matches = choices.filter(choice => `${choice.label} ${choice.id}`.toLocaleLowerCase().includes(needle))
    .toSorted((a, b) => rank(a.id) - rank(b.id) || a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id))
  return <Menu open={open} portal className={styles['catalogPicker']} listClassName={`${styles['catalogMenu']} ${connectStyles['providerMenu']}`}
    onClose={() => { onOpenChange(false) }}
    anchor={<button type="button" className={`${styles['catalogTrigger']} ${connectStyles['servicePicker']}`}
      aria-label={t('provider')} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
      onClick={() => { onOpenChange(!open) }}>
      <span className={connectStyles['providerMark']}><ProviderBrandIcon provider={selected.id} size={20} /></span>
      <span className={connectStyles['serviceName']}><span>{selected.label}</span></span>
      <IconChevronDownOutlineRegular size={16} />
    </button>}>
    <div className={connectStyles['providerSearch']} role="presentation">
      <Input ref={searchRef} type="search" value={query} icon={<IconSearchOutlineRegular size={16} />}
        aria-label={t('providerSearch')} placeholder={t('providerSearch')}
        onChange={(event) => { setQuery(event.target.value) }}
        onKeyDown={(event) => { if (event.key === 'Home' || event.key === 'End' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') event.stopPropagation() }} />
    </div>
    {matches.map(choice => <MenuItemButton key={choice.id} current={choice.id === selected.id}
      onSelect={() => { onSelect(choice.id); onOpenChange(false) }}>
      <span className={connectStyles['providerOption']}>
        <span className={connectStyles['providerMark']}><ProviderBrandIcon provider={choice.id} size={20} /></span>
        <span className={connectStyles['providerOptionLabel']}>{choice.label}</span>
        {choice.id === selected.id && <IconCheckOutlineRegular size={16} />}
      </span>
    </MenuItemButton>)}
    {matches.length === 0 && <p className={connectStyles['providerNoResults']} role="status">{t('providerSearchEmpty')}</p>}
  </Menu>
}
