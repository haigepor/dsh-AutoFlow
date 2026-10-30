/** Grouped native and registered skill locations with independent registration actions. */
import { useState } from 'react'
import {
  Button,
  IconCopyOutlineRegular,
  IconFolderOpenOutlineRegular,
  Input,
  Modal,
  Tag,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ManagedDirectory } from '@deepseek-ai/dsh-skill-manager/types'
import type { SkillSettingsProps } from './contract.ts'
import css from './SkillSettings.module.css'

/** Show source ownership and access alongside the exact registered paths.
 * @param props - current directories and registration operations.
 * @returns a bounded native dialog with grouped, scrollable source rows.
 */
export function SkillSourcesDialog(
  props: SkillSettingsProps & { directories: ManagedDirectory[]; onClose: () => void },
) {
  const { t } = props
  const [path, setPath] = useState('')
  const busy = props.useStore(state => state.busy)
  const groups = [
    {
      id: 'local',
      label: t('localDirectories'),
      roots: props.directories.filter(root => !root.external && root.writable),
    },
    {
      id: 'bundled',
      label: t('bundledSource'),
      roots: props.directories.filter(root => !root.external && !root.writable),
    },
    { id: 'external', label: t('externalDirectories'), roots: props.directories.filter(root => root.external) },
  ]
  const close = (): void => {
    if (!busy) props.onClose()
  }
  return (
    <Modal
      open
      title={t('sources')}
      description={t('sourceHelp')}
      closeLabel={t('close')}
      onClose={close}
      closeOnBackdropClick={!busy}
      className={css.sourcesDialog ?? ''}
      contentClassName={css.sourcesContent ?? ''}
      footer={
        <Button variant="outline" disabled={busy} onClick={close}>
          {t('close')}
        </Button>
      }
    >
      <form
        className={css.addSourceForm}
        onSubmit={(event) => {
          event.preventDefault()
          void props.source(path.trim(), false).then((ok) => {
            if (ok) setPath('')
          })
        }}
      >
        <label className={css.field}>
          {t('sourcePath')}
          <Input
            required
            disabled={busy}
            value={path}
            placeholder={t('sourcePlaceholder')}
            onChange={(event) => {
              setPath(event.target.value)
            }}
          />
        </label>
        <Button type="submit" variant="primary" disabled={busy || !path.trim()}>
          {t('addSource')}
        </Button>
      </form>
      <div className={css.sourceGroups}>
        {groups.map(group => (
          <section className={css.sourceGroup} key={group.id}>
            <header className={css.groupHeader}>
              <h3>{group.label}</h3>
              <span className={css.sourceCount}>{group.roots.length}</span>
            </header>
            {group.roots.length ? (
              <ul className={css.directoryList}>
                {group.roots.map(root => (
                  <li className={css.directoryRow} key={root.id}>
                    <span className={css.directoryIcon}>
                      <IconFolderOpenOutlineRegular size={18} />
                    </span>
                    <div className={css.directoryInfo}>
                      <div className={css.directoryTitle}>
                        <span>
                          {t(
                            root.external
                              ? 'registeredSource'
                              : root.source === 'user-dsh'
                                ? 'personalSource'
                                : root.source === 'user-agents'
                                  ? 'sharedSource'
                                  : root.source.startsWith('project-')
                                    ? 'project'
                                    : 'bundledSource',
                          )}
                        </span>
                        <Tag>{t(root.writable ? 'writable' : 'readOnly')}</Tag>
                      </div>
                      <p className={css.path}>{root.path}</p>
                    </div>
                    <div className={css.directoryActions}>
                      <Tooltip label={t('copyPath')} portal>
                        <Button
                          size="sm"
                          disabled={busy}
                          icon={<IconCopyOutlineRegular size={16} />}
                          aria-label={t('copyPath')}
                          onClick={() => {
                            void props.copy(root.path)
                          }}
                        />
                      </Tooltip>
                      {root.external ? (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            void props.source(root.path, true)
                          }}
                        >
                          {t('forgetSource')}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={css.groupEmpty}>{t(group.id === 'external' ? 'noExternalDirectories' : 'noDirectories')}</p>
            )}
          </section>
        ))}
      </div>
    </Modal>
  )
}
