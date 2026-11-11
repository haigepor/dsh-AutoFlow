import assert from 'node:assert/strict'
import test from 'node:test'
import { FLOW_ARROW_LIMIT, workflowArrowFrames, workflowArrowLayout } from '../src/client/workflow-arrow-layout.ts'

test('short curves use fewer arrows while long curves never exceed five', () => {
  assert.equal(workflowArrowLayout(60, 144, 900).count, 1)
  assert.equal(workflowArrowLayout(200, 144, 900).count, 2)
  assert.equal(workflowArrowLayout(600, 144, 900).count, 5)
  assert.equal(workflowArrowLayout(3000, 144, 900).count, 5)
})

test('all visible arrow bands maintain one spacing and one travel speed regardless of length', () => {
  for (const length of [40, 140, 200, 600, 3000]) {
    const layout = workflowArrowLayout(length, 144, 900)
    const starts: number[] = []
    for (let index = 0; index < layout.count; index++) {
      const frames = workflowArrowFrames(layout, index), start = parseFloat(frames[0]!.offsetDistance), end = parseFloat(frames.at(-1)!.offsetDistance)
      assert(Math.abs((end - start) / layout.duration - 40 / 900) < 1e-10)
      starts.push(start)
    }
    for (let index = 1; index < starts.length; index++) assert(Math.abs(starts[index]! - starts[index - 1]! - layout.pitch) < 1e-10)
  }
})

test('unused slots and arrows at clamped endpoints stay invisible', () => {
  const layout = workflowArrowLayout(70, 144, 900)
  for (let index = 0; index < FLOW_ARROW_LIMIT; index++) {
    const frames = workflowArrowFrames(layout, index)
    assert.equal(frames[0]!.offset, 0); assert.equal(frames.at(-1)!.offset, 1)
    if (index >= layout.count) assert(frames.every(frame => frame.opacity === 0))
    for (const frame of frames) if (parseFloat(frame.offsetDistance) >= layout.length || parseFloat(frame.offsetDistance) === 0) assert.equal(frame.opacity, 0)
  }
})

test('fractional SVG curve lengths keep every Web Animations offset within its closed interval', () => {
  for (const length of [0.1, 1.1, 40.1, 70.1, 200.1, 728.3, 1170.957275390625]) {
    const layout = workflowArrowLayout(length, 144, 900)
    for (let index = 0; index < FLOW_ARROW_LIMIT; index++) {
      const frames = workflowArrowFrames(layout, index)
      assert.equal(frames[0]!.offset, 0)
      assert.equal(frames.at(-1)!.offset, 1)
      for (const frame of frames) assert(frame.offset >= 0 && frame.offset <= 1)
    }
  }
})
