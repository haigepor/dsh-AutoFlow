/** Reset the built-in DeepSeek user layer without withdrawing its provider. */
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsOperations } from './operations.ts'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import { deriveKeyRef } from './store.ts'

/** Captured confirmation and completed stages, retained for a failed-stage retry. */
export interface ProviderReset {
  ns: string
  revision: number
  fields: readonly string[]
  credentialRef?: string
  settingsCleared: boolean
  credentialCleared: boolean
}

/**
 * Capture removable overrides and an unshared page-managed credential.
 * @param row - built-in provider whose configuration is being reset.
 * @param namespace - current redacted settings layers and revision.
 * @param rows - providers that may share its credential.
 * @returns reset stages, without mutating settings or credentials.
 */
export function providerResetTarget(row: ProviderRow, namespace: SettingsNamespaceView, rows: readonly ProviderRow[]): ProviderReset {
  const user = namespace.user
  const fields = typeof user === 'object' && user !== null && !Array.isArray(user) ? Object.keys(user) : []
  const ref = row.apiKeyEnv
  const managed = ref === 'DEEPSEEK_API_KEY' || ref === deriveKeyRef(row.entry.provider)
  const shared = rows.some(other => other.entry.provider !== row.entry.provider && other.apiKeyEnv === ref)
  const credentialRef = managed && !shared && row.credential?.configured === true && row.credential.writable ? ref : undefined
  return { ns: namespace.ns, revision: namespace.revision, fields,
    ...(credentialRef === undefined ? {} : { credentialRef }), settingsCleared: false, credentialCleared: false }
}

/**
 * Clear settings first, then recheck credential ownership before clearing the key.
 * @param operations - authenticated settings and credential operations.
 * @param controller - provider snapshot refreshed after each completed stage.
 * @param target - captured revision and resumable stage progress.
 * @param unavailable - localized message for an unavailable credential read.
 * @returns failure text, or undefined after all eligible stages complete.
 */
export async function resetProviderConfiguration(operations: ModelsOperations, controller: ModelsSettingsStore,
  target: ProviderReset, unavailable: string): Promise<string | undefined> {
  if (!target.settingsCleared) {
    if (target.fields.length > 0) {
      const result = await operations.writeSettings(target.ns,
        target.fields.map(field => ({ op: 'unset', path: [field] })), target.revision)
      if (result.kind !== 'written') return result.message
    }
    target.settingsCleared = true
  }
  await controller.load()
  const state = controller.store.getSnapshot()
  // 被更新的刷新取代时不能使用尚未收敛的共享关系删除凭据。
  if (state.status !== 'ready') return state.error ?? unavailable
  if (!target.credentialCleared && target.credentialRef !== undefined) {
    const ref = target.credentialRef
    // 设置恢复后重新检查共享关系，不能按确认框打开时的旧快照删除其他提供商的密钥。
    const shared = state.rows.some(row => row.entry.provider !== 'deepseek-official' && row.apiKeyEnv === ref)
    if (!shared) {
      const info = await operations.describeCredential(ref)
      if (info === undefined) return unavailable
      if (info.configured && info.writable) {
        const failure = await operations.removeCredential(ref)
        if (failure !== undefined) return failure
      }
    }
    target.credentialCleared = true
  }
  await controller.load()
  const refreshed = controller.store.getSnapshot()
  return refreshed.status === 'ready' ? undefined : refreshed.error ?? unavailable
}
