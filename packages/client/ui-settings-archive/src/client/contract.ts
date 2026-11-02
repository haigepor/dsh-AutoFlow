/** Props supplied by the settings slot and registration-owned archive operations. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ArchiveKey } from './locales.ts'
import type { ArchiveOperations } from './operations.ts'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ArchivePreferences } from '../types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.archive': ArchiveKey }
}

/** Live progress and callbacks keep transport and Host services outside React. */
export interface ArchiveInjected {
  readonly hooks: {
    operation: ArchiveOperations['state']
    favorites: ConfigForm<ArchivePreferences>
  }
  readonly run: ArchiveOperations['run']
  readonly favorite: ArchiveOperations['favorite']
  readonly retry: ArchiveOperations['retry']
  readonly dismissResult: () => void
  readonly dismissNotice: () => void
  readonly refresh: () => Promise<void>
  readonly open: (id: SessionId) => void
  readonly canChange: (id: SessionId, archived: boolean) => boolean
  readonly canDelete: (id: SessionId) => boolean
}

/** The page reads the existing Session and Workspace standard hooks. */
export type ArchivePageProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.archive'> & InjectFace<ArchiveInjected>
/** Feedback has no dependency on the mounted settings section. */
export type ArchiveFeedbackProps = PropsLocale<'settings.archive'> & InjectFace<ArchiveInjected>
