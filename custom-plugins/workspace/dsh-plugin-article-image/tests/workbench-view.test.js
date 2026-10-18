import { describe, expect, it } from 'vitest'
import { assetUrl, createRichArticle, runPresentation, sceneChanged, promptSyncState, updatePlanShot } from '../src/client/workflow-view.js'

const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) }
const flatten = value => value && typeof value === 'object' ? [value, ...value.children.flatMap(flatten)] : []

describe('safe article reading', () => {
  it('retains structure and safe emphasis without accepting page HTML or unsafe links', () => {
    const RichArticle = createRichArticle(React)
    const tree = RichArticle({ snapshot: { id: 'a'.repeat(32), assets: [], blocks: [
      { id: 'b1', type: 'heading', level: 2, inline: [{ text: 'Title', bold: true }] },
      { id: 'b2', type: 'paragraph', inline: [{ text: '<script>bad()</script>', href: 'javascript:bad()' }, { text: 'Source', italic: true, href: 'https://example.com/story' }] },
      { id: 'b3', type: 'list', ordered: true, items: [{ inline: [{ text: 'First' }], children: [{ ordered: true, items: [{ inline: [{ text: 'Nested' }], children: [] }] }] }] },
      { id: 'b4', type: 'quote', inline: [{ text: 'Quoted' }] },
      { id: 'b5', type: 'table', rows: [{ cells: [{ inline: [{ text: 'Header' }], header: true, rowSpan: 1, colSpan: 1 }] }] },
    ] }, t: key => key })
    const nodes = flatten(tree)
    expect(nodes.some(node => node.type === 'h2')).toBe(true)
    expect(nodes.filter(node => node.type === 'ol')).toHaveLength(2)
    expect(nodes.some(node => node.type === 'blockquote')).toBe(true)
    expect(nodes.some(node => node.type === 'th')).toBe(true)
    expect(nodes.some(node => node.type === 'strong')).toBe(true)
    expect(nodes.some(node => node.type === 'em')).toBe(true)
    expect(nodes.filter(node => node.type === 'a').map(node => node.props.href)).toEqual(['https://example.com/story'])
    expect(nodes.every(node => !('dangerouslySetInnerHTML' in node.props))).toBe(true)
    expect(nodes.some(node => node.children.includes('<script>bad()</script>'))).toBe(true)
  })

  it('reads available originals only through same-origin opaque asset IDs and preserves missing figures', () => {
    expect(assetUrl('a'.repeat(32), 'b'.repeat(32))).toBe('api/article-image/asset?snapshot=' + 'a'.repeat(32) + '&asset=' + 'b'.repeat(32))
    expect(assetUrl('../private', 'b'.repeat(32))).toBe('')
    expect(assetUrl('a'.repeat(32), '../private')).toBe('')
    const tree = createRichArticle(React)({ snapshot: { id: 'a'.repeat(32), assets: [{ id: 'b'.repeat(32), status: 'ready', width: 960, height: 640 }], blocks: [
      { id: 'b1', type: 'figure', assetId: 'b'.repeat(32), alt: 'Original', caption: 'Caption', credit: 'Photographer' },
      { id: 'b2', type: 'figure', assetId: 'missing', alt: 'Unavailable', caption: 'Still visible' },
    ] }, t: key => key })
    const nodes = flatten(tree)
    expect(nodes.filter(node => node.type === 'img')).toHaveLength(1)
    expect(nodes.find(node => node.type === 'img').props.src).toMatch(/^api\/article-image\/asset\?snapshot=/)
    expect(nodes.filter(node => node.type === 'figure')).toHaveLength(2)
    expect(nodes.some(node => node.children.includes('Still visible'))).toBe(true)
    expect(nodes.some(node => node.children.includes('assetUnavailable'))).toBe(true)
  })
})

describe('observable workflow progress', () => {
  it('keeps model activity indeterminate and reports committed counters without a synthetic percentage', () => {
    const value = runPresentation({ id: 'run', stage: 'understanding', status: 'running', counts: { blocks: 18, images: 3 }, startedAt: '2026-10-17T01:00:00Z' })
    expect(value.active).toBe(true)
    expect(value.indeterminate).toBe(true)
    expect(value.percentage).toBeUndefined()
    expect(value.counts).toEqual({ blocks: 18, images: 3 })
    expect(value.canStop).toBe(true)
  })

  it('offers explicit resume for interrupted work and has no active spinner after cancellation', () => {
    expect(runPresentation({ id: 'run', stage: 'planning', status: 'interrupted' }).canResume).toBe(true)
    expect(runPresentation({ id: 'run', stage: 'planning', status: 'cancelled' })).toMatchObject({ active: false, canStop: false, canResume: true })
    expect(runPresentation({ id: 'run', stage: 'review', status: 'review' }).canResume).toBe(false)
  })

  it('advances elapsed time only for active work and freezes finished duration at the persisted update', () => {
    const run = { id: 'run', stage: 'planning', status: 'running', startedAt: '2026-10-17T01:00:00Z', updatedAt: '2026-10-17T01:00:45Z' }
    const current = Date.parse('2026-10-17T01:01:35Z')
    expect(runPresentation(run, current).elapsedMs).toBe(95000)
    expect(runPresentation({ ...run, status: 'review' }, current).elapsedMs).toBe(45000)
    expect(runPresentation({ ...run, status: 'cancelled' }, current + 60000).elapsedMs).toBe(45000)
  })
})

describe('scene and prompt edits', () => {
  const shot = { purpose: 'cover', subject: 'River', action: 'Flowing', ratio: '16:9', prompt: 'A river', sceneHash: 'old', promptSceneHash: 'old' }

  it('marks scene changes as needing confirmation and does not mutate a polled source plan', () => {
    const plan = { shots: [shot] }
    const changed = updatePlanShot(plan, 0, 'subject', 'Forest')
    expect(plan.shots[0].subject).toBe('River')
    expect(sceneChanged(shot, changed.shots[0])).toBe(true)
    expect(promptSyncState(changed, plan, [])).toEqual([0])
    expect(promptSyncState(changed, plan, [0])).toEqual([])
  })

  it('keeps prompt-only edits separate and requires rechecking changed source rationale', () => {
    expect(sceneChanged(shot, { ...shot, prompt: 'New river prompt' })).toBe(false)
    expect(sceneChanged(shot, { ...shot, rationale: 'Supports conclusion' })).toBe(true)
    expect(promptSyncState({ shots: [{ ...shot, sceneHash: 'new' }] }, null, [])).toEqual([0])
  })

  it('requires every dependent shot to be checked when the understanding summary changes', () => {
    const saved = { brief: { theme: 'River' }, shots: [shot, { ...shot, purpose: 'inline' }] }
    const draft = { ...saved, brief: { theme: 'Forest' } }
    expect(promptSyncState(draft, saved, [])).toEqual([0, 1])
    expect(promptSyncState(draft, saved, [0])).toEqual([1])
  })
})
