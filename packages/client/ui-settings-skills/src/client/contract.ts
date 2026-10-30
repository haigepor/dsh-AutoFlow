/** Slot-derived inputs for the native skill settings page. */
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ManagedSkillDetail,
  ManagedSkillId,
  MarketplaceSkill,
  RepositorySkill,
  SkillBackup,
  SkillBackupId,
  SkillDirectoryId,
  SkillImportFile,
  SkillManagementSnapshot,
  SkillUpdatePreview,
} from '@deepseek-ai/dsh-skill-manager/types'
import type { createSkillSettingsStore } from './store.ts'
import type { SkillsLocaleKey } from './locales.ts'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.skills': SkillsLocaleKey
  }
  interface ResourceProtocolMap {
    'skill-inventory': SkillManagementSnapshot
    'skill-detail': ManagedSkillDetail
    'skill-backups': SkillBackup[]
    'skill-repositories': { repository: string; ref: string }[]
    'skill-models': ModelCatalog
  }
}
/** Registration-owned callbacks; UI components never receive Remote service objects. */
export interface SkillSettingsInjected {
  createConversation: (workspaceId: WorkspaceId, model: ModelSelection) => Promise<boolean>
  refresh: () => void
  setEnabled: (id: string, enabled: boolean, workspace: string) => Promise<boolean>
  save: (id: ManagedSkillId, document: string, revision: string, workspace: string) => Promise<boolean>
  importFiles: (
    directory: SkillDirectoryId,
    files: SkillImportFile[],
    overwrite: boolean,
    workspace: string,
  ) => Promise<boolean>
  trash: (id: ManagedSkillId, workspace: string) => Promise<boolean>
  restore: (id: SkillBackupId, remove: boolean, workspace: string) => Promise<boolean>
  source: (path: string, remove: boolean) => Promise<boolean>
  arrange: (id: ManagedSkillId, category: string, order: number, workspace: string) => Promise<boolean>
  discover: (repository: string, ref: string) => Promise<RepositorySkill[] | undefined>
  install: (
    candidate: RepositorySkill,
    directory: SkillDirectoryId,
    overwrite: boolean,
    workspace: string,
  ) => Promise<boolean>
  preview: (id: ManagedSkillId, ref: string, workspace: string) => Promise<SkillUpdatePreview | undefined>
  update: (token: string, overwrite: boolean) => Promise<boolean>
  subscribe: (repository: string, ref: string, remove: boolean) => Promise<boolean>
  marketplace: (catalog: MarketplaceSkill['catalog'], query: string) => Promise<MarketplaceSkill[] | undefined>
  installMarketplace: (
    skill: MarketplaceSkill,
    directory: SkillDirectoryId,
    overwrite: boolean,
    workspace: string,
  ) => Promise<boolean>
  setCategoryEnabled: (category: string, enabled: boolean, workspace: string) => Promise<boolean>
  copy: (document: string) => Promise<void>
}
/** Native page inputs provided by the settings registration. */
export type SkillSettingsProps = PropsRuntime<'settings.section'> &
  PropsStore<ReturnType<typeof createSkillSettingsStore>> &
  PropsLocale<'settings.skills'> &
  InjectFace<SkillSettingsInjected>
/** Overlay shares operation state and locale without a settings owner. */
export type SkillFeedbackProps = PropsStore<ReturnType<typeof createSkillSettingsStore>> &
  PropsLocale<'settings.skills'>
