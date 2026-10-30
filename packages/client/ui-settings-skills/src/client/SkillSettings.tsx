/** Skill management stays in the same settings content column as MCP services. */
import { useId, useRef, useState } from 'react'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  Button,
  FieldHelp,
  IconFolderOpenOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconSkillOutlineRegular,
  Input,
  IconPaperclipOutlineRegular,
  IconCloseOutlineRegular,
  Modal,
  SegmentedTabs,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ManagedDirectory,
  ManagedSkill,
  ManagedSkillId,
  SkillBackup,
  SkillDirectoryId,
} from '@deepseek-ai/dsh-skill-manager/types'
import type { SkillSettingsProps } from './contract.ts'
import css from './SkillSettings.module.css'
import { SkillDetailsDialog } from './SkillDetailsDialog.tsx'
import { SkillCreateDialog } from './SkillCreateDialog.tsx'
import { SkillChoice as Choice } from './SkillChoice.tsx'
import { SkillSkeleton } from './SkillSkeleton.tsx'
import { SkillDiscover } from './SkillDiscover.tsx'
import { SkillSourcesDialog } from './SkillSourcesDialog.tsx'
import skillsArtwork from './assets/skills-reading-whale-maid-v1.webp'

type Tab = 'global' | 'project' | 'discover' | 'trash'
type Filter = 'all' | 'enabled' | 'disabled' | 'shadowed' | 'invalid'
type Confirm = { kind: 'trash'; row: ManagedSkill } | { kind: 'restore' | 'permanent'; backup: SkillBackup }

/** Compose inventory, exact-copy details, imports, public discovery and recoverable history.
 *
 * @param props - registered resources, locale, state and management callbacks.
 *
 * @returns the current skills settings view.

 */
export function SkillSettings(props: SkillSettingsProps) {
  const { t, useResource, useStore } = props
  const busy = useStore(state => state.busy)
  const [tab, setTab] = useState<Tab>('global')
  const [workspace, setWorkspace] = useState('')
  const scope = tab === 'global' ? '' : workspace
  const [createOpen, setCreateOpen] = useState(false)
  const [previewSkill, setPreviewSkill] = useState<ManagedSkill | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [sources, setSources] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [dragged, setDragged] = useState<ManagedSkillId | null>(null)
  const id = useId()
  const inventory = useResource<'skill-inventory'>(
    `dsh-resource://skill-inventory/list?workspace=${encodeURIComponent(scope)}`,
  )
  const detailId = previewSkill?.id
  const detail = useResource<'skill-detail'>(
    detailId ? `dsh-resource://skill-detail/${detailId}?workspace=${encodeURIComponent(scope)}` : '',
  )
  const backups = useResource<'skill-backups'>(tab === 'trash' ? 'dsh-resource://skill-backups/list' : '')
  const snapshot = inventory.value
  const writable = snapshot?.directories.filter(root => root.writable) ?? []
  const rows =
    snapshot?.skills.filter((row) => {
      const root = snapshot.directories.find(item => item.id === row.directoryId)
      const project = root?.source.startsWith('project-') === true
      if ((tab === 'project') !== project) return false
      if (categoryFilter && row.category !== categoryFilter) return false
      if (!`${row.name} ${row.description} ${row.path}`.toLowerCase().includes(query.trim().toLowerCase())) return false
      return (
        filter === 'all' ||
        (filter === 'invalid'
          ? !row.valid
          : filter === 'shadowed'
            ? row.valid && row.enabled && !row.effective
            : filter === 'enabled'
              ? row.enabled
              : !row.enabled)
      )
    }) ?? []
  const back = (): void => {
    setCreateOpen(false)
    setPreviewSkill(null)
  }
  const selectTab = (next: Tab): void => {
    setTab(next)
    back()
    if (next === 'project' && !workspace) setWorkspace(snapshot?.workspaces[0] ?? '')
  }
  async function confirmAction(): Promise<void> {
    if (confirm === null) return
    const success =
      confirm.kind === 'trash'
        ? await props.trash(confirm.row.id, scope)
        : await props.restore(confirm.backup.id, confirm.kind === 'permanent', scope)
    if (success) {
      setConfirm(null)
      back()
    }
  }
  return (
    <section className={css.section} data-skill-settings>
      <header className={css.header} data-settings-page-header>
        <h1>{t('title')}</h1>
        <div className={css.headerActions}>
          <>
            <Button
              variant="outline"
              disabled={busy}
              icon={<IconRefreshOutlineRegular />}
              aria-label={t('refresh')}
              onClick={props.refresh}
            />
            <Button
              variant="outline"
              disabled={busy || snapshot === undefined}
              onClick={() => {
                setSources(true)
              }}
            >
              {t('sources')}
            </Button>
            <Button
              variant="outline"
              disabled={busy || writable.length === 0}
              onClick={() => {
                setImportOpen(true)
              }}
            >
              {t('import')}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              icon={<IconPlusOutlineRegular />}
              onClick={() => {
                setCreateOpen(true)
              }}
            >
              {t('create')}
            </Button>
          </>
        </div>
      </header>
      <div className={css.introduction}>
        <img src={skillsArtwork} width={88} height={66} alt="" aria-hidden="true" draggable={false} />
        <div>
          <div className={css.introTitle}>
            <h2>{t('introTitle')}</h2>
            <FieldHelp title={t('introTitle')} text={t('introHelp')} label={t('help')} closeLabel={t('close')} />
          </div>
          <p className={css.intro}>{t('intro')}</p>
        </div>
      </div>
      {inventory.status === 'failed' || detail.status === 'failed' ? (
        <div className={css.notice} role="alert">
          {t('loadFailed')}
          <Button size="sm" onClick={props.refresh}>
            {t('retry')}
          </Button>
        </div>
      ) : null}
      {snapshot?.complete === false ? (
        <p className={css.notice} role="status">
          {t('incomplete')}
        </p>
      ) : null}
      <>
        <SegmentedTabs<Tab>
          value={tab}
          onChange={selectTab}
          label={t('tabs')}
          variant="underline"
          items={[
            { value: 'global', label: t('global'), id: `${id}-global`, panelId: `${id}-panel` },
            { value: 'project', label: t('project'), id: `${id}-project`, panelId: `${id}-panel` },
            { value: 'discover', label: t('discover'), id: `${id}-discover`, panelId: `${id}-panel` },
            { value: 'trash', label: t('trash'), id: `${id}-trash`, panelId: `${id}-panel` },
          ]}
        />
        {tab === 'trash' ? (
          <Choice
            label={t('workspace')}
            value={workspace}
            items={[
              { id: '', label: t('global') },
              ...(snapshot?.workspaces ?? []).map(path => ({ id: path, label: path })),
            ]}
            onChange={setWorkspace}
          />
        ) : null}
        <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className={css.section}>
          {tab === 'global' || tab === 'project' ? (
            <>
              <div className={css.toolbar}>
                <Input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                  }}
                  placeholder={t('search')}
                  aria-label={t('search')}
                />
                <Choice
                  label={t('filter')}
                  showLabel
                  value={filter}
                  items={(['all', 'enabled', 'disabled', 'shadowed', 'invalid'] as const).map(value => ({
                    id: value,
                    label: t(value),
                  }))}
                  onChange={(value) => {
                    setFilter(value as Filter)
                  }}
                />
                <Choice
                  label={t('category')}
                  showLabel
                  value={categoryFilter}
                  items={[
                    { id: '', label: t('all') },
                    ...(snapshot?.categories ?? []).map(category => ({ id: category, label: category })),
                  ]}
                  onChange={setCategoryFilter}
                />
                {categoryFilter ? (
                  <>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        void props.setCategoryEnabled(categoryFilter, true, scope)
                      }}
                    >
                      {t('categoryEnable')}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        void props.setCategoryEnabled(categoryFilter, false, scope)
                      }}
                    >
                      {t('categoryDisable')}
                    </Button>
                  </>
                ) : null}
                {tab === 'project' ? (
                  <Choice
                    label={t('workspace')}
                    value={workspace}
                    items={(snapshot?.workspaces ?? []).map(path => ({ id: path, label: path }))}
                    onChange={setWorkspace}
                  />
                ) : null}
              </div>
              {snapshot === undefined && inventory.status !== 'failed' ? <SkillSkeleton label={t('loading')} /> : null}
              {snapshot !== undefined && rows.length === 0 ? (
                <div className={css.empty}>
                  <h2>{t(query || filter !== 'all' ? 'noMatches' : 'empty')}</h2>
                  <p>{t(query || filter !== 'all' ? 'noMatchesDetail' : 'emptyDetail')}</p>
                </div>
              ) : null}
              {snapshot?.directories
                .filter(root => rows.some(row => row.directoryId === root.id))
                .map(root => (
                  <div className={css.source} key={root.id}>
                    <div className={css.sourceHeader}>
                      <div>
                        <details className={css.sourceInfo}>
                          <summary>
                            <IconFolderOpenOutlineRegular size={16} />
                            <h2>
                              {t(
                                root.source === 'user-dsh'
                                  ? 'personalSource'
                                  : root.source === 'user-agents'
                                    ? 'sharedSource'
                                    : root.source === 'bundled'
                                      ? 'bundledSource'
                                      : root.source.startsWith('project-')
                                        ? 'project'
                                        : 'externalSource',
                              )}
                            </h2>
                            <span className={css.sourceCount}>
                              {rows.filter(row => row.directoryId === root.id).length}
                            </span>
                          </summary>
                          <p className={css.path}>{root.path}</p>
                        </details>
                      </div>
                      <Switch
                        checked={root.enabled}
                        disabled={busy}
                        label={t('toggle', { name: root.source })}
                        onChange={(enabled) => {
                          void props.setEnabled(root.id, enabled, scope)
                        }}
                      />
                    </div>
                    <div className={css.cardGrid}>
                      {rows
                        .filter(row => row.directoryId === root.id)
                        .map(row => (
                          <div
                            className={css.card}
                            data-skill-card
                            key={row.id}
                            draggable={!busy}
                            onDragStart={() => {
                              setDragged(row.id)
                            }}
                            onDragEnd={() => {
                              setDragged(null)
                            }}
                            onDragOver={(event) => {
                              if (dragged !== null) event.preventDefault()
                            }}
                            onDrop={(event) => {
                              event.preventDefault()
                              if (dragged !== null && dragged !== row.id)
                                void props.arrange(dragged, row.category, row.order - 0.5, scope)
                              setDragged(null)
                            }}
                          >
                            <button
                              className={css.cardMain}
                              type="button"
                              aria-label={t('open', { name: row.name })}
                              onClick={() => {
                                setPreviewSkill(row)
                              }}
                            >
                              <span className={css.cardHeading}>
                                <span className={css.cardIcon}>
                                  <IconSkillOutlineRegular size={20} />
                                </span>
                                <span className={css.skillName}>{row.name}</span>
                              </span>
                              <span className={css.cardDescription}>{row.description || row.path}</span>
                              <span className={css.cardCategory}>
                                {row.category}
                                {!row.writable ? <Tag>{t('readOnly')}</Tag> : null}
                              </span>
                            </button>
                            <div className={css.cardFooter}>
                              <Tag tone={!row.valid ? 'danger' : row.effective ? 'success' : 'neutral'}>
                                {t(
                                  !row.valid
                                    ? 'invalid'
                                    : !row.enabled
                                      ? 'disabled'
                                      : row.effective
                                        ? 'effective'
                                        : 'shadowed',
                                )}
                              </Tag>
                              <Switch
                                checked={row.enabled}
                                disabled={busy || !row.valid}
                                label={t('toggle', { name: row.name })}
                                onChange={(enabled) => {
                                  void props.setEnabled(row.id, enabled, scope)
                                }}
                              />
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                ))}
            </>
          ) : tab === 'discover' ? (
            snapshot === undefined ? (
              inventory.status === 'failed' ? null : (
                <SkillSkeleton label={t('loading')} />
              )
            ) : (
              <SkillDiscover
                {...props}
                directories={writable}
                workspace={scope}
                workspaces={snapshot.workspaces}
                onWorkspaceChange={setWorkspace}
              />
            )
          ) : (
            <>
              {backups.value === undefined && backups.status !== 'failed' ? (
                <SkillSkeleton label={t('loading')} />
              ) : null}
              {backups.status === 'failed' ? <p role="alert">{t('loadFailed')}</p> : null}
              {backups.value?.length === 0 ? (
                <div className={css.empty}>
                  <h2>{t('backupEmpty')}</h2>
                </div>
              ) : null}
              {backups.value?.map(backup => (
                <div className={css.row} key={backup.id}>
                  <div className={css.rowMain}>
                    <div className={css.rowTitle}>
                      <span className={css.skillName}>{backup.name}</span>
                      <Tag>{t(backup.kind === 'trash' ? 'backupTrash' : 'backupUpdate')}</Tag>
                    </div>
                    <span className={css.path}>{backup.target}</span>
                    <span className={css.path}>{new Date(backup.time).toLocaleString()}</span>
                  </div>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setConfirm({ kind: 'restore', backup })
                    }}
                  >
                    {t('restore')}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setConfirm({ kind: 'permanent', backup })
                    }}
                  >
                    {t('permanent')}
                  </Button>
                </div>
              ))}
            </>
          )}
        </div>
      </>
      {createOpen ? (
        <SkillCreateDialog
          {...props}
          onClose={() => {
            setCreateOpen(false)
          }}
        />
      ) : null}
      {previewSkill ? (
        <SkillDetailsDialog
          {...props}
          skill={previewSkill}
          detail={detail.value?.skill.id === previewSkill.id ? detail.value : undefined}
          failed={detail.status === 'failed'}
          workspace={scope}
          onClose={() => {
            setPreviewSkill(null)
          }}
          onTrash={(row) => {
            setConfirm({ kind: 'trash', row })
          }}
        />
      ) : null}
      {sources ? (
        <SkillSourcesDialog
          {...props}
          directories={snapshot?.directories ?? []}
          onClose={() => {
            setSources(false)
          }}
        />
      ) : null}
      {importOpen ? (
        <SkillImport
          {...props}
          directories={writable}
          limits={snapshot?.limits}
          workspace={scope}
          onClose={() => {
            setImportOpen(false)
          }}
        />
      ) : null}
      {confirm !== null ? (
        <Modal
          open
          title={t(
            confirm.kind === 'trash' ? 'removeTitle' : confirm.kind === 'restore' ? 'restoreTitle' : 'permanentTitle',
          )}
          description={t(
            confirm.kind === 'trash'
              ? 'removeDetail'
              : confirm.kind === 'restore'
                ? 'restoreDetail'
                : 'permanentDetail',
          )}
          closeLabel={t('cancel')}
          onClose={() => {
            if (!busy) setConfirm(null)
          }}
          closeOnBackdropClick={!busy}
          footer={
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setConfirm(null)
                }}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  void confirmAction()
                }}
              >
                {t(confirm.kind === 'trash' ? 'remove' : confirm.kind)}
              </Button>
            </>
          }
        />
      ) : null}
    </section>
  )
}

function Destination({
  directories,
  value,
  onChange,
  t,
}: {
  directories: ManagedDirectory[]
  value: SkillDirectoryId | undefined
  onChange: (id: SkillDirectoryId) => void
  t: SkillSettingsProps['t']
}) {
  return (
    <label className={css.field}>
      {t('destination')}
      <Choice
        label={t('destination')}
        value={value ?? ''}
        items={directories.map(root => ({ id: root.id, label: root.path }))}
        onChange={(id) => {
          onChange(brandString<SkillDirectoryId>(id))
        }}
      />
    </label>
  )
}
function SkillImport(
  props: SkillSettingsProps & {
    directories: ManagedDirectory[]
    limits: { maxBytes: number; maxFiles: number } | undefined
    workspace: string
    onClose: () => void
  },
) {
  const { t } = props
  const [destination, setDestination] = useState(props.directories[0]?.id)
  const [files, setFiles] = useState<File[]>([])
  const [overwrite, setOverwrite] = useState(false)
  const folder = useRef<HTMLInputElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const formId = useId()
  const busy = props.useStore(state => state.busy)
  const close = (): void => {
    if (!busy) props.onClose()
  }
  return (
    <Modal
      open
      title={t('import')}
      description={t('importHelp')}
      closeLabel={t('cancel')}
      onClose={close}
      closeOnBackdropClick={!busy}
      className={css.compactDialog ?? ''}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            form={formId}
            type="submit"
            variant="primary"
            disabled={busy || files.length === 0 || destination === undefined}
          >
            {t('import')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className={css.editor}
        onSubmit={(event) => {
          event.preventDefault()
          if (destination === undefined || props.limits === undefined) return
          if (
            files.length > props.limits.maxFiles ||
            files.reduce((total, file) => total + file.size, 0) > props.limits.maxBytes
          ) {
            props.actions.announce('error.too-large', false)
            return
          }
          void Promise.all(
            files.map(async file => ({
              path: file.webkitRelativePath || file.name,
              base64: bytesBase64(new Uint8Array(await file.arrayBuffer())),
            })),
          )
            .then(upload => props.importFiles(destination, upload, overwrite, props.workspace))
            .then((ok) => {
              if (ok) props.onClose()
            })
            .catch(() => {
              props.actions.announce('failed', false)
            })
        }}
      >
        <Destination directories={props.directories} value={destination} onChange={setDestination} t={t} />
        <input
          ref={filePicker}
          type="file"
          multiple
          hidden
          disabled={busy}
          aria-label={t('files')}
          onChange={(event) => {
            setFiles(Array.from(event.target.files ?? []))
          }}
        />
        <input
          ref={folder}
          type="file"
          multiple
          hidden
          disabled={busy}
          aria-label={t('folder')}
          {...{ webkitdirectory: '' }}
          onChange={(event) => {
            setFiles(Array.from(event.target.files ?? []))
          }}
        />
        <div className={css.uploadZone}>
          <IconPaperclipOutlineRegular size={28} />
          <h3>{t('chooseSkillFiles')}</h3>
          <p>{t('uploadTypes')}</p>
          <div className={css.headerActions}>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                filePicker.current?.click()
              }}
            >
              {t('chooseFiles')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                folder.current?.click()
              }}
            >
              {t('folder')}
            </Button>
          </div>
        </div>
        {files.length ? (
          <div className={css.selection}>
            <p>
              {t('fileSummary', {
                count: files.length,
                size: Math.ceil(files.reduce((total, file) => total + file.size, 0) / 1024),
              })}
            </p>
            <ul className={css.fileList}>
              {files.map((file, index) => (
                <li key={file.webkitRelativePath || file.name}>
                  <span>{file.webkitRelativePath || file.name}</span>
                  <Button
                    size="sm"
                    disabled={busy}
                    aria-label={t('removeFile', { name: file.name })}
                    onClick={() => {
                      setFiles(files.filter((_, position) => position !== index))
                    }}
                    icon={<IconCloseOutlineRegular size={14} />}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <label className={css.checkbox}>
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(event) => {
              setOverwrite(event.target.checked)
            }}
          />
          {t('overwrite')}
        </label>
      </form>
    </Modal>
  )
}
function bytesBase64(bytes: Uint8Array): string {
  let value = ''
  for (let index = 0; index < bytes.length; index += 8192)
    value += String.fromCharCode(...bytes.subarray(index, index + 8192))
  return btoa(value)
}
