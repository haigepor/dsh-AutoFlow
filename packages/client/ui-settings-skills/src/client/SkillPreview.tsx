/** Shared skill metadata and resource directory display. */
import { IconCodeOutlineRegular, IconFolderOpenOutlineRegular, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ManagedSkill, ManagedSkillDetail, SkillFileEntry } from '@deepseek-ai/dsh-skill-manager/types'
import type { SkillSettingsProps } from './contract.ts'
import css from './SkillSettings.module.css'

type Translate = SkillSettingsProps['t']

/** Display the copy's effective state and original invocation permissions.
 * @param props - selected skill metadata and translated labels.
 * @returns compact description list.
 */
export function SkillMetadata({ skill, t }: { skill: ManagedSkill; t: Translate }) {
  return (
    <dl className={css.metadata}>
      <div>
        <dt>{t('filter')}</dt>
        <dd>
          <Tag tone={!skill.valid ? 'danger' : skill.effective ? 'success' : 'neutral'}>
            {t(!skill.valid ? 'invalid' : !skill.enabled ? 'disabled' : skill.effective ? 'effective' : 'shadowed')}
          </Tag>
        </dd>
      </div>
      <div>
        <dt>{t('invocation')}</dt>
        <dd>
          {t(
            skill.modelInvocable && skill.userInvocable
              ? 'bothInvocation'
              : skill.userInvocable
                ? 'userOnly'
                : skill.modelInvocable
                  ? 'modelOnly'
                  : 'noInvocation',
          )}
        </dd>
      </div>
      <div>
        <dt>{t('access')}</dt>
        <dd>{t(skill.writable ? 'writable' : 'readOnly')}</dd>
      </div>
    </dl>
  )
}

/** Render collapsible directories from actual relative bundle members.
 * @param props - bounded Host inventory and translated labels.
 * @returns nested directory lists; links remain non-interactive leaves.
 */
export function SkillStructure({ tree, t }: { tree: ManagedSkillDetail['tree']; t: Translate }) {
  const children = new Map<string, SkillFileEntry[]>()
  for (const entry of tree.entries) {
    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
    const siblings = children.get(parent) ?? []
    siblings.push(entry)
    children.set(parent, siblings)
  }
  function branch(parent: string) {
    return (
      <ul>
        {children.get(parent)?.map((entry) => {
          const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
          return (
            <li key={entry.path}>
              {entry.kind === 'directory' ? (
                <details open>
                  <summary>
                    <IconFolderOpenOutlineRegular size={16} />
                    <span>{name}</span>
                  </summary>
                  {branch(entry.path)}
                </details>
              ) : (
                <span className={css.treeFile}>
                  <IconCodeOutlineRegular size={16} />
                  <span>{name}</span>
                  {entry.kind === 'link' ? <Tag>{t('link')}</Tag> : null}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    )
  }
  return (
    <aside className={css.structure} aria-label={t('structure')}>
      <h3>{t('structure')}</h3>
      {tree.entries.length ? <div className={css.tree}>{branch('')}</div> : <p className={css.path}>{t('noFiles')}</p>}
      {!tree.complete ? (
        <p className={css.path} role="status">
          {t('treeIncomplete')}
        </p>
      ) : null}
    </aside>
  )
}
