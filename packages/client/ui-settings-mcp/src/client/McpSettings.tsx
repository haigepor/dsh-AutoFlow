/** MCP settings list and detail remain in the existing settings content column. */
import { useState } from 'react'
import { Button, FieldHelp, IconCodeOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, Switch, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { McpSettingsProps } from './contract.ts'
import type { McpServerRow } from '../types.ts'
import { McpEditor } from './McpEditor.tsx'
import { McpSkeleton } from './McpSkeleton.tsx'
import { McpJsonDialog } from './McpJsonDialog.tsx'
import connectionArtwork from '../assets/mcp-connection-whale-maid-v2.webp'
import css from './McpSettings.module.css'

/** @param props - registered callbacks, resources, locale and operation state. @returns list, new editor or server detail. */
export function McpSettings(props: McpSettingsProps) {
  const { t, useResource, useStore, actions, refresh } = props
  const busy = useStore(state => state.busy)
  const restartRequired = useStore(state => state.restartRequired)
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'create' } | { kind: 'detail'; id: McpServerRow['id'] }>({ kind: 'list' })
  const [jsonOpen, setJsonOpen] = useState(false)
  const list = useResource<'mcp-servers'>('dsh-resource://mcp-servers/list')
  const detail = useResource<'mcp-server'>(view.kind === 'detail' ? `dsh-resource://mcp-server/${encodeURIComponent(view.id)}` : '')
  const back = (): void => { setView({ kind: 'list' }) }
  const row = detail.value
  const status = (server: McpServerRow) => <Tag tone={server.phase === 'connected' ? 'success' : server.phase === 'failed' ? 'danger' : 'neutral'}>{t(`phase.${server.phase}`)}</Tag>
  return <section className={css.section} data-mcp-settings>
    <header className={css.header} data-settings-page-header>
      <h1>{t(view.kind === 'create' ? 'newTitle' : view.kind === 'detail' ? 'editTitle' : 'title')}</h1>
      <div className={css.headerActions}>
        {view.kind === 'list' ? <><Button variant="outline" disabled={busy !== null} icon={<IconRefreshOutlineRegular />} onClick={() => { actions.confirmRestart(true) }}>{t('restartApp')}</Button>
          <Tooltip label={t('jsonOpen')} side="bottom"><Button variant="outline" disabled={busy !== null || list.value === undefined}
            aria-label={t('jsonOpen')} icon={<IconCodeOutlineRegular />} onClick={() => { setJsonOpen(true) }} /></Tooltip>
          <Button variant="primary" disabled={busy !== null || list.value === undefined} icon={<IconPlusOutlineRegular />} onClick={() => { setView({ kind: 'create' }) }}>{t('add')}</Button></>
          : <Button variant="outline" disabled={busy !== null} icon={<IconChevronLeftOutlineRegular />} onClick={back}>{t('back')}</Button>}
      </div>
    </header>
    <div className={css.introduction} data-mcp-introduction>
      <img src={connectionArtwork} width={104} height={78} alt="" aria-hidden="true" draggable={false} decoding="async" />
      <div><div className={css.introTitle}><h2>{t('introTitle')}</h2>
        <FieldHelp title={t('introTitle')} text={t('introHelp')} label={t('introHelpLabel')} closeLabel={t('close')} />
      </div><p className={css.intro}>{t('intro')}</p></div>
    </div>
    {restartRequired ? <p className={css.notice} role="status">{t('pending')}</p> : null}
    {list.status === 'failed' || (view.kind === 'detail' && detail.status === 'failed') ? <div className={css.notice} role="alert">{t('loadFailed')}<Button size="sm" onClick={refresh}>{t('retry')}</Button></div> : null}
    {view.kind === 'list' ? <>
      {list.value === undefined && list.status !== 'failed' ? <div role="status" aria-label={t('loading')} aria-busy="true"><McpSkeleton /></div> : null}
      {list.value?.servers.length === 0 ? <div className={css.empty}><h2>{t('emptyTitle')}</h2><p>{t('emptyDetail')}</p>
        <Button variant="outline" icon={<IconPlusOutlineRegular />} onClick={() => { setView({ kind: 'create' }) }}>{t('add')}</Button></div> : null}
      <div className={css.list}>{list.value?.servers.map(server => <div className={css.row} key={server.id}>
        <button className={css.rowMain} type="button" aria-label={t('openServer', { name: server.serverName })} onClick={() => { setView({ kind: 'detail', id: server.id }) }}>
          <div className={css.rowTitle}><span className={css.serverName}>{server.serverName}</span>{status(server)}</div>
          <div className={css.rowMeta}><span>{t(server.transport === 'stdio' ? 'stdio' : 'http')}</span><span>{t('toolCount', { count: server.tools.length })}</span></div>
        </button>
        <Switch checked={server.enabled} label={t('enableServer', { name: server.serverName })} disabled={server.readOnly || busy !== null} loading={busy === server.id} onChange={(enabled) => { void props.setEnabled(server.id, enabled) }} />
        <Button aria-label={t('openServer', { name: server.serverName })} onClick={() => { setView({ kind: 'detail', id: server.id }) }}><IconChevronRightOutlineRegular /></Button>
      </div>)}</div>
    </> : view.kind === 'create' && list.value !== undefined ? <div className={css.panel}>
      <McpEditor key="create" initial={list.value.defaults} revision="" creating readOnly={false} busy={busy !== null} t={t} onCancel={back}
        onSave={async (draft, enabled) => { const saved = await props.create(draft, enabled); if (saved) back(); return saved }} />
    </div> : view.kind === 'detail' ? row === undefined ? detail.status !== 'failed'
      ? <div role="status" aria-label={t('loading')} aria-busy="true"><McpSkeleton detail /></div> : null : <div className={css.panel}>
      <div className={css.detailHeader}><div className={css.rowTitle}><h2>{row.serverName}</h2>{status(row)}</div>
        <Button variant="outline" disabled={!row.enabled || row.readOnly || busy !== null} icon={<IconRefreshOutlineRegular />} onClick={() => { void props.restartServer(row.id) }}>{t('restartServer')}</Button></div>
      {row.phase === 'failed' ? <p className={css.notice} role="alert">{t('failedDetail')}</p> : null}
      <McpEditor key={row.id} initial={row.config} revision={row.revision} creating={false} readOnly={row.readOnly}
        busy={busy !== null} t={t} onCancel={back} onSave={async (draft, _enabled, revision) => {
          const saved = await props.update(row.id, draft, revision)
          if (saved) back()
          return saved
        }} />
      <div className={css.tools}><h3>{t('tools')}</h3>{row.tools.length > 0 ? <ul>{row.tools.map(name => <li key={name}><code>{name}</code></li>)}</ul> : <p className={css.help}>{t('noTools')}</p>}</div>
    </div> : null}
    {jsonOpen ? <McpJsonDialog {...props} onClose={() => { setJsonOpen(false) }} /> : null}
  </section>
}
