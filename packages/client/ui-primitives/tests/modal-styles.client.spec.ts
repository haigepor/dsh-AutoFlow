/** CSS Modules in jsdom do not exercise backdrop sampling during entry motion. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/Modal.module.css', import.meta.url), 'utf8')

describe('Modal entry material', () => {
  it('keeps the material ancestor from becoming an opacity backdrop root', () => {
    const entry = /@keyframes modalEnter\s*\{([\s\S]*?)\n\}/.exec(css)?.[1]
    expect(entry).toBeDefined()
    expect(entry).not.toMatch(/\b(?:opacity|filter|backdrop-filter|mask|clip-path)\s*:/)
    expect(entry).toMatch(/transform\s*:/)
  })

  it('fades the mask, material and standard content independently of the glass ancestor', () => {
    expect(css).toMatch(/@keyframes modalMaskEnter/)
    expect(css).toMatch(/@keyframes modalMaterialEnter/)
    expect(css).toMatch(/@keyframes modalContentEnter/)
    expect(css).toMatch(/var\(--dsw-modal-enter-easing\)/)
    expect(css).toMatch(/prefers-reduced-motion: reduce/)
  })
})
