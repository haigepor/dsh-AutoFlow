/** Complete skill reading and editing in a fixed-chrome native modal. */
import { useId, useState } from 'react'
import {
  Button,
  CodeEditor,
  IconCloseOutlineRegular,
  IconCopyOutlineRegular,
  IconEditOutlineRegular,
  IconSkillOutlineRegular,
  Input,
  MarkdownText,
  Modal,
  SegmentedTabs,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ManagedSkill, ManagedSkillDetail, SkillUpdatePreview } from '@deepseek-ai/dsh-skill-manager/types'
import type { SkillSettingsProps } from './contract.ts'
import { SkillStructure, SkillMetadata } from './SkillPreview.tsx'
import css from './SkillSettings.module.css'

/** Keep skill identity, navigation and actions visible while the selected pane scrolls.
 * @param props - selected copy, current detail and management operations.
 * @returns one complete skill dialog with independent instruction and metadata views.
 */
export function SkillDetailsDialog(
  props: SkillSettingsProps & {
    skill: ManagedSkill
    detail: ManagedSkillDetail | undefined
    failed: boolean
    workspace: string
    onClose: () => void
    onTrash: (row: ManagedSkill) => void
  },
) {
  const { t, detail, workspace } = props
  const [pane, setPane] = useState<'instructions' | 'structure' | 'source'>('instructions')
  const paneId = useId()
  const [editing, setEditing] = useState(false)
  const [document, setDocument] = useState(detail?.document ?? '')
  const [revision, setRevision] = useState(detail?.skill.revision ?? '')
  const [category, setCategory] = useState(props.skill.category)
  const [order, setOrder] = useState(props.skill.order)
  const [ref, setRef] = useState('HEAD')
  const [preview, setPreview] = useState<SkillUpdatePreview>()
  const [checking, setChecking] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  const busy = props.useStore(state => state.busy)
  const skill = detail?.skill ?? props.skill
  const close = (): void => {
    if (!busy) props.onClose()
  }
  const toggleEditing = (): void => {
    if (!detail) return
    setPane('instructions')
    setEditing(!editing)
    setDocument(detail.document)
    setRevision(detail.skill.revision)
  }
  const save = (): void => {
    if (!detail) return
    void props.save(detail.skill.id, document, revision, workspace).then((ok) => {
      if (ok) setEditing(false)
    })
  }
  return (
    <Modal
      open
      headless
      title={skill.name}
      onClose={close}
      closeOnBackdropClick={!busy}
      className={css.skillDialog ?? ''}
    >
      <header className={css.dialogHero}>
        <span className={css.dialogSkillIcon}>
          <IconSkillOutlineRegular size={22} />
        </span>
        <div className={css.dialogHeading}>
          <div className={css.dialogTitle}>
            <h2>{skill.name}</h2>
            {editing ? <Tag>{t('editing')}</Tag> : null}
          </div>
          <p>{skill.description}</p>
        </div>
        <Button
          size="sm"
          disabled={busy}
          icon={<IconCloseOutlineRegular size={16} />}
          aria-label={t('close')}
          onClick={close}
        />
      </header>
      <div className={css.dialogSummary}>
        <SkillMetadata skill={skill} t={t} />
      </div>
      <div className={css.dialogNavigation}>
        <SegmentedTabs
          value={pane}
          onChange={setPane}
          variant="underline"
          label={t('detailTabs')}
          items={[
            { value: 'instructions', label: t('document'), id: `${paneId}-instructions`, panelId: `${paneId}-panel` },
            { value: 'structure', label: t('structure'), id: `${paneId}-structure`, panelId: `${paneId}-panel` },
            { value: 'source', label: t('sourceInfo'), id: `${paneId}-source`, panelId: `${paneId}-panel` },
          ]}
        />
        <div className={css.dialogActions}>
          <Button
            variant="outline"
            size="sm"
            icon={<IconCopyOutlineRegular size={14} />}
            disabled={!detail || props.failed}
            onClick={() => {
              if (detail) void props.copy(editing ? document : detail.document)
            }}
          >
            {t('copy')}
          </Button>
          {skill.writable && !editing ? (
            <Button
              variant="outline"
              size="sm"
              icon={<IconEditOutlineRegular size={14} />}
              disabled={busy || !detail}
              onClick={toggleEditing}
            >
              {t('edit')}
            </Button>
          ) : null}
        </div>
      </div>
      <div id={`${paneId}-panel`} role="tabpanel" aria-labelledby={`${paneId}-${pane}`} className={css.dialogPane}>
        {props.failed ? (
          <p role="alert">{t('loadFailed')}</p>
        ) : !detail ? (
          <div role="status" aria-label={t('loading')} className={css.previewLoading}>
            <span className={css.skeletonLine} />
            <span className={css.skeletonShort} />
          </div>
        ) : (
          <>
            {pane === 'instructions' ? (
              <>
                {detail.skill.diagnostics.map(message => (
                  <p className={css.notice} role="alert" key={message}>
                    {message}
                  </p>
                ))}
                <div className={css.document}>
                  <h3>{t('document')}</h3>
                  {editing ? (
                    <>
                      <CodeEditor
                        value={document}
                        onChange={setDocument}
                        label={t('document')}
                        language="markdown"
                        disabled={busy}
                      />
                    </>
                  ) : (
                    <div className={css.markdownBody}>
                      <MarkdownText
                        text={detail.document.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '')}
                        labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }}
                      />
                    </div>
                  )}
                </div>
              </>
            ) : pane === 'structure' ? (
              <SkillStructure tree={detail.tree} t={t} />
            ) : (
              <>
                <section className={css.sourceBlock}>
                  <header className={css.groupHeader}>
                    <h3>{t('fileInfo')}</h3>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!detail.skill.path}
                      onClick={() => {
                        void props.copy(detail.skill.path)
                      }}
                    >
                      {t('copyPath')}
                    </Button>
                  </header>
                  <dl className={css.fileFacts}>
                    <div>
                      <dt>{t('filePath')}</dt>
                      <dd>{detail.skill.path || t('noFiles')}</dd>
                    </div>
                    <div>
                      <dt>{t('description')}</dt>
                      <dd>{detail.skill.description}</dd>
                    </div>
                    {detail.skill.repository ? (
                      <div>
                        <dt>{t('repository')}</dt>
                        <dd>{detail.skill.repository}</dd>
                      </div>
                    ) : null}
                    {detail.skill.commit ? (
                      <div>
                        <dt>{t('commit')}</dt>
                        <dd>
                          <code>{detail.skill.commit}</code>
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                </section>
                <section className={css.sourceBlock}>
                  <h3>{t('organization')}</h3>
                  <div className={css.organize}>
                    <label className={css.field}>
                      {t('category')}
                      <Input
                        value={category}
                        onChange={(event) => {
                          setCategory(event.target.value)
                        }}
                      />
                    </label>
                    <label className={css.field}>
                      {t('order')}
                      <Input
                        type="number"
                        value={order}
                        onChange={(event) => {
                          setOrder(Number(event.target.value))
                        }}
                      />
                    </label>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        void props.arrange(detail.skill.id, category, order, workspace)
                      }}
                    >
                      {t('organize')}
                    </Button>
                  </div>
                </section>
                {detail.skill.repository ? (
                  <div className={css.editor}>
                    <p className={css.path}>{detail.skill.repository}</p>
                    <div className={css.toolbar}>
                      <Input
                        aria-label={t('ref')}
                        value={ref}
                        onChange={(event) => {
                          setRef(event.target.value)
                        }}
                      />
                      <Button
                        variant="outline"
                        disabled={busy || checking}
                        onClick={() => {
                          setChecking(true)
                          void props
                            .preview(detail.skill.id, ref, workspace)
                            .then(setPreview)
                            .finally(() => {
                              setChecking(false)
                            })
                        }}
                      >
                        {t('checkUpdate')}
                      </Button>
                    </div>
                    {preview ? (
                      <div className={css.editor}>
                        <h3>{t('preview')}</h3>
                        {preview.localModified ? <p className={css.notice}>{t('localModified')}</p> : null}
                        {preview.changes.length === 0 ? (
                          <p>{t('noChanges')}</p>
                        ) : (
                          <ul>
                            {preview.changes.map(change => (
                              <li key={change.path}>
                                <code>
                                  {change.kind}: {change.path}
                                </code>
                              </li>
                            ))}
                          </ul>
                        )}
                        {preview.localModified ? (
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
                        ) : null}
                        <Button
                          variant="primary"
                          disabled={busy || preview.changes.length === 0 || (preview.localModified && !overwrite)}
                          onClick={() => {
                            void props.update(preview.token, overwrite).then((ok) => {
                              if (ok) setPreview(undefined)
                            })
                          }}
                        >
                          {t('update')}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </>
        )}
      </div>
      <footer className={css.dialogFooter}>
        <div>
          {skill.writable ? (
            <Button
              disabled={busy || !detail}
              onClick={() => {
                props.onTrash(skill)
              }}
            >
              {t('remove')}
            </Button>
          ) : null}
        </div>
        <div className={css.dialogActions}>
          {editing ? (
            <>
              <Button variant="outline" disabled={busy} onClick={toggleEditing}>
                {t('cancel')}
              </Button>
              <Button variant="primary" disabled={busy} onClick={save}>
                {t('save')}
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={busy} onClick={close}>
              {t('close')}
            </Button>
          )}
        </div>
      </footer>
    </Modal>
  )
}
