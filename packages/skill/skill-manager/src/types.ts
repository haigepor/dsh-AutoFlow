/** Skill management records shared by trusted settings clients and the Host. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of one concrete skill copy, not its invocation name. */
export type ManagedSkillId = Branded<'ManagedSkillId'>
/** Identity of a configured skill directory. */
export type SkillDirectoryId = Branded<'SkillDirectoryId'>
/** Identity of a retained file backup. */
export type SkillBackupId = Branded<'SkillBackupId'>

/** One authoritative local source; external sources can restrict calls without editing their files. */
export interface ManagedDirectory {
  id: SkillDirectoryId
  path: string
  source: string
  writable: boolean
  enabled: boolean
  external: boolean
}
/** A file or runtime skill, including invalid and shadowed copies. */
export interface ManagedSkill {
  id: ManagedSkillId
  directoryId: SkillDirectoryId
  name: string
  description: string
  path: string
  revision: string
  enabled: boolean
  modelInvocable: boolean
  userInvocable: boolean
  writable: boolean
  valid: boolean
  diagnostics: string[]
  effective: boolean
  category: string
  order: number
  repository?: string
  commit?: string
}
/** A relative bundle member; linked entries are displayed without following them. */
export interface SkillFileEntry {
  path: string
  kind: 'file' | 'directory' | 'link'
}
/** Full editor input and bounded file inventory; revision protects external edits. */
export interface ManagedSkillDetail {
  skill: ManagedSkill
  document: string
  tree: { entries: SkillFileEntry[]; complete: boolean }
}
/** Management inventory for one explicitly selected workspace. */
export interface SkillManagementSnapshot {
  directories: ManagedDirectory[]
  skills: ManagedSkill[]
  workspaces: string[]
  categories: string[]
  complete: boolean
  limits: { maxBytes: number; maxFiles: number }
}
/** A recoverable deleted or replaced skill directory. */
export interface SkillBackup {
  id: SkillBackupId
  name: string
  target: string
  time: string
  kind: 'trash' | 'update'
}
/** Files uploaded by a browser; paths remain relative to the selected import directory. */
export interface SkillImportFile {
  path: string
  base64: string
}
/** An explicitly selected public repository skill. */
export interface RepositorySkill {
  repository: string
  commit: string
  path: string
  name: string
  description: string
}
/** Public marketplace discovery result; identity is revalidated before download. */
export interface MarketplaceSkill {
  catalog: 'skills.sh' | 'clawhub'
  owner: string
  slug: string
  name: string
  description: string
  repository: string
}
/** A version-pinned update preview, including local-change detection. */
export interface SkillUpdatePreview {
  id: ManagedSkillId
  token: string
  commit: string
  localModified: boolean
  changes: { path: string; kind: 'added' | 'modified' | 'removed' }[]
}
/** Expected management failure presented by localized settings clients. */
export type SkillManagementError =
  | 'invalid'
  | 'not-found'
  | 'read-only'
  | 'conflict'
  | 'unsafe-path'
  | 'too-large'
  | 'network'
  | 'storage'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Skill files or management policy committed; readers refetch their own scope.
     * @mode emit

 */
    'skill-management/changed'(): void
  }
}

/** Persisted outcome consumed by localized settings clients. */
export type SkillOperationResult = { status: 'saved' } | { status: 'rejected'; code: SkillManagementError }
