/** Local catalog presentation; commands are copied for manual installation. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BetterSidebarService } from '../../../src/client/service.ts'
import { PLUGIN_TOPIC_URL, type PluginEntry } from '../../../src/client/plugins-shared.ts'
import { builtinTabPlugins } from '../../../src/client/plugins-tabs.ts'
import { builtinViewerPlugins } from '../../../src/client/plugins-viewers.ts'
import { t } from '../../../src/client/locales.ts'
import css from './plugin-catalog.module.css'

export type PluginKind = 'tab' | 'viewer'
const text = (value: string | (() => string)) => typeof value === 'function' ? value() : value

/** Preserve the catalog's filtering, category order and clipboard-only installation. */
export function PluginListBody({ kind }: { service: BetterSidebarService; kind: PluginKind }) {
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current) } }, [])
  const catalog = kind === 'tab' ? builtinTabPlugins : builtinViewerPlugins
  const needle = query.trim().toLowerCase()
  const filtered = catalog.filter(entry => [entry.id, text(entry.name), text(entry.description)].some(value => value.toLowerCase().includes(needle)))
  const groups = new Map<string | undefined, PluginEntry[]>()
  for (const entry of filtered) {
    const category = entry.category === undefined ? undefined : text(entry.category)
    groups.set(category, [...groups.get(category) ?? [], entry])
  }
  const jump = (url: string) => { window.open(url, '_blank', 'noopener') }
  const copy = async (entry: PluginEntry) => {
    if (!await writeClipboard(entry.install) || !mounted.current) return
    clearTimeout(timer.current)
    setCopied(entry.id)
    timer.current = setTimeout(() => setCopied(null), 1500)
  }
  return <div className={css.catalog}>
    <Button variant="ghost" className={css.topic} onClick={() => jump(PLUGIN_TOPIC_URL)}>{t('addPluginsBrowseMore')}</Button>
    <Input type="search" aria-label={t('addPluginsSearch')} placeholder={t('addPluginsSearch')} value={query} onChange={event => setQuery(event.currentTarget.value)} />
    <div className={css.heading}>{t('addPluginsRecommended')} <span>{filtered.length}</span></div>
    {!filtered.length && <div className={css.description}>{t(catalog.length ? 'addPluginsNoMatch' : 'addPluginsEmpty')}</div>}
    {[...groups].map(([category, entries]) => <div key={category ?? '\u0000'}>
      {category && <div className={css.heading}>{category}</div>}
      {entries.map(entry => <div className={css.entry} key={entry.id}>
        <div className={css.head}>
          <Button variant="ghost" className={css.name} aria-label={`${t('openPlugin')}: ${text(entry.name)}`} onClick={() => jump(entry.url)}>{text(entry.name)}</Button>
          <div className={css.actions}><Button size="sm" variant="outline" onClick={() => jump(entry.url)} aria-label={`${t('openPlugin')}: ${text(entry.name)}`}>{t('openPlugin')}</Button>
            <Button size="sm" variant="outline" onClick={() => { void copy(entry) }} aria-label={`${t('copyInstall')}: ${text(entry.name)}`}>{t(copied === entry.id ? 'copied' : 'copy')}</Button></div>
        </div>
        <div className={css.description}>{text(entry.description)}</div>
        <code className={css.command}>{entry.install}</code>
      </div>)}
    </div>)}
  </div>
}
