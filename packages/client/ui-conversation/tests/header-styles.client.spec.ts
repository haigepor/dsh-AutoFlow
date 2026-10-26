/** Conversation navigation preserves collapsible AutoFlow header geometry. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url), 'utf8')

describe('conversation header geometry', () => {
  it('allows the header to shrink when the view row collapses', () => {
    expect(css.match(/\.header\s*\{([^}]*)\}/)?.[1]).toContain('min-height: 0')
    expect(css.match(/\.viewTabs\s*\{([^}]*)\}/)?.[1]).toContain('min-height: 25px')
    expect(css.match(/\.tab\s*\{([^}]*)\}/)?.[1]).toContain('min-height: 25px')
    expect(css.match(/\.tab\s*\{([^}]*)\}/)?.[1]).toContain('padding: 0 0 9px')
  })

  it('keeps the AutoFlow view-label spacing alongside the new action gap', () => {
    expect(css.match(/\.viewTabs\s*\{([^}]*)\}/)?.[1]).toContain('gap: 36px')
    expect(css.match(/\.tabs\s*\{([^}]*)\}/)?.[1]).toContain('gap: 16px 20px')
  })
})
