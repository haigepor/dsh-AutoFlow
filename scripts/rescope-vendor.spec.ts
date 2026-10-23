/** Recorded npm evidence stays intact while authored files and exact edits remain checked. */

import { describe, expect, it } from 'vitest'
import { exactEditState, isRescopeExcluded, rescopeText } from './rescope-vendor.ts'

const ANCHOR = '\n## Sync procedure'
const INSERTED = `\n15. **rescope**: one log entry.\n${ANCHOR}`

describe('rescope file selection', () => {
  it('preserves product ids without hiding imports in the same file', () => {
    const file = 'packages/client/ui-agent-preset/src/client/CreatePluginMenuItem.tsx'
    const source = "import { Context } from 'cordis'\nconst preset = 'cordis'\nconst pkg = import('cordis')\n"
    const scoped = "import { Context } from '@deepseek-ai/cordis'\nconst preset = 'cordis'\nconst pkg = import('@deepseek-ai/cordis')\n"
    expect(rescopeText(source, file)).toBe(scoped)
    expect(rescopeText(scoped, file)).toBe(scoped)
    expect(rescopeText(scoped, file, true)).toBe(source)
    expect(rescopeText("import 'cordis'\ndeclare module 'cordis' {}\nrequire.resolve('cordis')", file))
      .not.toContain("'cordis'")
    expect(rescopeText("import\n 'cordis'\nexport { Context } from\n 'cordis'", file))
      .not.toContain("'cordis'")
  })

  it('keeps declared event names but still checks actual package subpaths', () => {
    const file = 'snapshots/session/cordis-inspect-liveness/client-fixture.mjs'
    expect(rescopeText("ctx.on('cordis/inspect-query', handler)", file))
      .toBe("ctx.on('cordis/inspect-query', handler)")
    expect(rescopeText("import 'cordis/inspect-query'", file)).toBe("import '@deepseek-ai/cordis/inspect-query'")
    expect(rescopeText("import 'cordis/context'", file)).toBe("import '@deepseek-ai/cordis/context'")
    expect(rescopeText('name: cordis', 'packages/bundle/web-app/cordis.patch.yml')).toBe('name: @deepseek-ai/cordis')
  })
  it('preserves the recorded npm resolution', () => {
    expect(isRescopeExcluded('scripts/dependency-catalog/package-lock.json')).toBe(true)
  })

  it.each([
    'scripts/dependency-catalog/package.json',
    'scripts/dependency-catalog/source.ts',
    'scripts/other/package-lock.json',
    'packages/example/src/index.ts',
    'packages/example/package.json',
  ])('keeps %s subject to upstream package-name checks', (file) => {
    expect(isRescopeExcluded(file)).toBe(false)
  })
})

describe('exactEditState', () => {
  it('classifies an insertion by its target form, so a duplicate is invalid', () => {
    expect(exactEditState(`log\n${ANCHOR}\n`, ANCHOR, INSERTED, 1)).toBe('pending')
    expect(exactEditState(`log${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('applied')
    // The anchor survives an insertion, so counting the source form would have
    // called this pending and inserted the entry a second time.
    expect(exactEditState(`log${INSERTED}${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('invalid')
    expect(exactEditState('log\n', ANCHOR, INSERTED, 1)).toBe('invalid')
  })

  it('classifies a deletion by its source form, and requires its remainder to survive', () => {
    const remainder = 'exclude:\n'
    const withEntries = 'exclude:\n  - cordis@4\n'
    expect(exactEditState(withEntries, withEntries, remainder, 1)).toBe('pending')
    expect(exactEditState(remainder, withEntries, remainder, 1)).toBe('applied')
    // Upstream dropped the whole field: the source form is gone, but so is the
    // remainder, so this is a moved site rather than a completed deletion.
    expect(exactEditState('unrelated:\n', withEntries, remainder, 1)).toBe('invalid')
  })

  it('requires a replacement to leave no source form and the exact target count', () => {
    expect(exactEditState('a = 1\n', 'a = 1', 'b = 2', 1)).toBe('pending')
    expect(exactEditState('b = 2\n', 'a = 1', 'b = 2', 1)).toBe('applied')
    expect(exactEditState('b = 2\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    // A moved or partially applied site: neither state is complete.
    expect(exactEditState('a = 1\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    expect(exactEditState('x\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
  })
})
