/** Prepare a new skill-authoring conversation without sending a model request. */
import { useState } from 'react'
import { Button, IconInfoOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillSettingsProps } from './contract.ts'
import { SkillChoice } from './SkillChoice.tsx'
import css from './SkillSettings.module.css'

/** Choose an execution workspace and a real catalog model before opening the composer.
 * @param props - framework sources and the conversation preparation callback.
 * @returns a native creation dialog with loading and failure states.
 */
export function SkillCreateDialog(props: SkillSettingsProps & { onClose: () => void }) {
  const { t } = props
  const workspaces = props.useWorkspaces(state => state.items)
  const [workspaceId, setWorkspaceId] = useState<string>(workspaces[0]?.workspaceId ?? '')
  const catalog = props.useResource<'skill-models'>('dsh-resource://skill-models/list')
  const [modelKey, setModelKey] = useState<string>()
  const [opening, setOpening] = useState(false)
  const choices =
    catalog.value?.groups.flatMap(group =>
      group.models.map(model => ({
        id: JSON.stringify([group.id, model.id]),
        label: `${model.name} · ${group.name}`,
        selection: { provider: group.id, model: model.id },
      })),
    ) ?? []
  const defaultKey = catalog.value ? JSON.stringify([catalog.value.default.provider, catalog.value.default.model]) : ''
  const selectedKey = modelKey ?? (choices.some(item => item.id === defaultKey) ? defaultKey : (choices[0]?.id ?? ''))
  const workspace = workspaces.find(item => item.workspaceId === workspaceId)
  const model = choices.find(item => item.id === selectedKey)
  const close = (): void => {
    if (!opening) props.onClose()
  }
  return (
    <Modal
      open
      title={t('create')}
      description={t('createHelp')}
      closeLabel={t('cancel')}
      onClose={close}
      className={css.compactDialog ?? ''}
      closeOnBackdropClick={!opening}
      footer={
        <>
          <Button variant="outline" disabled={opening} onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={opening || !workspace || !model}
            onClick={() => {
              if (!workspace || !model) return
              setOpening(true)
              void props
                .createConversation(workspace.workspaceId, model.selection)
                .then((ok) => {
                  if (ok) props.onClose()
                })
                .finally(() => {
                  setOpening(false)
                })
            }}
          >
            {t(opening ? 'openingConversation' : 'openConversation')}
          </Button>
        </>
      }
    >
      <div className={css.editor}>
        <label className={css.field}>
          {t('executionWorkspace')}
          <SkillChoice
            label={t('executionWorkspace')}
            value={workspaceId}
            items={workspaces.map(item => ({ id: item.workspaceId, label: item.path }))}
            onChange={setWorkspaceId}
            disabled={opening}
          />
        </label>
        {!workspaces.length ? <p className={css.path}>{t('noWorkspace')}</p> : null}
        <label className={css.field}>
          {t('model')}
          <SkillChoice
            label={t('model')}
            value={selectedKey}
            items={choices}
            onChange={setModelKey}
            disabled={opening}
          />
        </label>
        {catalog.status === 'failed' ? (
          <p role="alert" className={css.notice}>
            {t('modelsFailed')}
            <Button onClick={props.refresh}>{t('retry')}</Button>
          </p>
        ) : !catalog.value ? (
          <p role="status" className={css.path}>
            {t('modelsLoading')}
          </p>
        ) : !choices.length ? (
          <p className={css.path}>{t('noModels')}</p>
        ) : null}
        {catalog.value?.failures.length ? (
          <p className={css.path} role="status">
            {t('modelsIncomplete')}
          </p>
        ) : null}
        <div className={css.creationHint}>
          <IconInfoOutlineRegular size={16} />
          <p>{t('creatorHint')}</p>
        </div>
      </div>
    </Modal>
  )
}
