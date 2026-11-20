import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const conversationCss = readFileSync(fileURLToPath(new URL(
  '../src/client/skeleton/ConversationRoot.module.css',
  import.meta.url,
)), 'utf8')

describe('conversation width styles', () => {
  it('leaves the reserved scrollbar gutter free of width handles', () => {
    expect(conversationCss).toMatch(/\.scrollBody\s*\{[^}]*scrollbar-gutter:\s*stable;/s)
    expect(conversationCss).not.toContain('.widthHandle')
  })
})
