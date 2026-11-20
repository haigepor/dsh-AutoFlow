/** Catalog navigation and the shared footer contribution. */

/** Right-sidebar page kind scoped to the parent Session. */
export const SUBAGENT_CATALOG_KIND = 'subagentcatalog'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Content below the root Session's subagent tree. */
    'conversation.session.header.actions.subagent.footer': {
      kind: 'list'
      scope: 'session'
    }
  }

  interface SlotFactoryMap {
    /** Renders the same footer contributions in the preview and sidebar list. */
    'subagent.catalog.footer': {
      scope: 'session'
      children: {
        'conversation.session.header.actions.subagent.footer': { kind: 'list'; scope: 'session' }
      }
    }
  }
}
