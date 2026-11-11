import test from 'node:test'
import assert from 'node:assert/strict'
import { workflowReturnPath } from '../src/client/workflow-return-layout.ts'

test('the review return path and its label clear the intermediate clarity card', () => {
  const [path, labelX, labelY] = workflowReturnPath({ x: 2500, y: 82 }, { x: 1830, y: 82 }, -64)
  const blocked = (x: number, y: number) => x >= 2000 && x <= 2330 && y >= 0 && y <= 480
  const commands = path.match(/[A-Za-z][^A-Za-z]*/g)!
  let point = { x: 0, y: 0 }
  for (const command of commands) {
    const values = command.slice(1).trim().split(/[ ,]+/).map(Number)
    if (command[0] === 'M') { point = { x: values[0]!, y: values[1]! }; continue }
    if (command[0] === 'C') {
      for (let index = 0; index <= 100; index++) {
        const t = index / 100, u = 1 - t
        const x = u ** 3 * point.x + 3 * u ** 2 * t * values[0]! + 3 * u * t ** 2 * values[2]! + t ** 3 * values[4]!
        const y = u ** 3 * point.y + 3 * u ** 2 * t * values[1]! + 3 * u * t ** 2 * values[3]! + t ** 3 * values[5]!
        assert.equal(blocked(x, y), false, 'The return curve must not run through the clarity card')
      }
      point = { x: values[4]!, y: values[5]! }
    } else if (command[0] === 'L') {
      for (let index = 0; index <= 100; index++) assert.equal(blocked(point.x + (values[0]! - point.x) * index / 100, point.y + (values[1]! - point.y) * index / 100), false)
      point = { x: values[0]!, y: values[1]! }
    } else assert.fail('Unexpected SVG command')
  }
  assert.deepEqual(point, { x: 1830, y: 82 })
  assert.equal(blocked(labelX, labelY - 16), false)
})
