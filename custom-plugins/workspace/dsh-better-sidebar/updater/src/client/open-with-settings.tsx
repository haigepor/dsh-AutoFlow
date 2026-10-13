/** Local presentation of the built-in editor's existing openWith configuration. */
import { Button, Input, Switch, Tooltip, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { isValidCustomEditor, newCustomEditorId, parseOpenWithConfig, type CustomEditor, type OpenWithConfig } from '../../../src/client/open-with.ts'
import { t } from '../../../src/client/locales.ts'
import css from './settings-fields.module.css'

/** Controlled fields follow the parent's optimistic queue and rollback after failed writes. */
export function OpenWithSettings({ pluginSettings, updatePluginSetting }: {
  pluginSettings: Record<string, unknown>; updatePluginSetting: (key: string, value: unknown) => void
}) {
  const config = parseOpenWithConfig(pluginSettings.openWith)
  const commit = (next: OpenWithConfig) => updatePluginSetting('openWith', next)
  const patch = (id: string, values: Partial<CustomEditor>) => commit({ ...config, customEditors: config.customEditors.map(editor => editor.id === id ? { ...editor, ...values } : editor) })
  return <>
    <div className={css.row}>
      <div className={css.copy}><span className={css.title}>{t('openWithSettingsSshTitle')}</span><span className={css.description}>{t('openWithSettingsSshDesc')}</span></div>
      <Input className={css.input} aria-label={t('openWithSettingsSshTitle')} value={config.sshHost} placeholder={t('openWithSettingsSshPlaceholder')} spellCheck={false}
        onChange={event => commit({ ...config, sshHost: event.currentTarget.value })} />
    </div>
    <div className={css.row}>
      <div className={css.copy}><span className={css.title}>{t('openWithSettingsCustomTitle')}</span><span className={css.description}>{t('openWithSettingsCustomDesc')}</span></div>
      <Button variant="outline" onClick={() => commit({ ...config, customEditors: [...config.customEditors, { id: newCustomEditorId(), name: '', urlTemplate: '', isVscodeFamily: false }] })}>{t('openWithSettingsAdd')}</Button>
    </div>
    <div className={css.editors}>{config.customEditors.map(editor => <div className={css.editor} key={editor.id}>
      <Input className={css.editorInput} aria-label={t('openWithSettingsName')} value={editor.name} placeholder={t('openWithSettingsName')} spellCheck={false} onChange={event => patch(editor.id, { name: event.currentTarget.value })} />
      <Input className={css.editorInput} aria-label={t('openWithSettingsTemplate')} value={editor.urlTemplate} placeholder={t('openWithSettingsTemplate')} spellCheck={false} onChange={event => patch(editor.id, { urlTemplate: event.currentTarget.value })} />
      <Tooltip label={t('openWithSettingsFamilyDesc')} portal><span className={css.family}>
        <Switch label={t('openWithSettingsFamily')} checked={editor.isVscodeFamily} onChange={value => patch(editor.id, { isVscodeFamily: value })} /><span>{t('openWithSettingsFamily')}</span>
      </span></Tooltip>
      <Button size="sm" variant="ghost" aria-label={t('openWithSettingsRemove')} onClick={() => commit({ ...config, customEditors: config.customEditors.filter(item => item.id !== editor.id), pinned: config.pinned.filter(id => id !== `custom:${editor.id}`) })}><IconCloseOutlineRegular size={14} /></Button>
    </div>)}</div>
    {config.customEditors.some(editor => !isValidCustomEditor(editor)) && <div className={css.hint} role="note">{t('openWithSettingsInvalidHint')}</div>}
  </>
}
