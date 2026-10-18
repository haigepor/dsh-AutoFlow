/** Bounded progress publication retains source timing and exposes safe root causes. */
import { test, expect, vi } from 'vitest'
import { createRunProgress } from '../src/host/run-progress.js'
import { failureDetails } from '../src/host/run-diagnostics.js'

test('batches progress and drains the final partial batch before returning', async () => {
  const batches = [], writer = createRunProgress({ batchSize: 3, flushMs: 10000, write: async batch => batches.push(batch), onFailure() {} })
  try {
    await writer.push({ event: 'document-loaded', details: { bytes: 20 } })
    await writer.push({ phase: 'assets', completed: 1, total: 2 })
    expect(batches).toHaveLength(0)
    await writer.push({ phase: 'assets', completed: 2, total: 2 })
    expect(batches).toHaveLength(1)
    expect(batches[0].map(e => e.event)).toEqual(['document-loaded', 'assets', 'assets'])
    expect(batches[0].every(e => Number.isFinite(Date.parse(e.at)))).toBe(true)
    await writer.push({ event: 'source-extracted' })
    await writer.close()
    expect(batches).toHaveLength(2)
    await expect(writer.push({ event: 'late-event' })).rejects.toThrow('progress-closed')
  } finally { await writer.close().catch(() => {}) }
})

test('flushes quiet progress on its owned timer and close leaves no timer', async () => {
  vi.useFakeTimers()
  const write = vi.fn(async () => {}), writer = createRunProgress({ batchSize: 8, flushMs: 200, write, onFailure() {} })
  try {
    await writer.push({ event: 'navigation-start' })
    await vi.advanceTimersByTimeAsync(200)
    expect(write).toHaveBeenCalledTimes(1)
    await writer.close()
    expect(vi.getTimerCount()).toBe(0)
  } finally { await writer.close().catch(() => {}); vi.useRealTimers() }
})

test('contains a failed timed write, stops the producer and rejects final drain with the original error', async () => {
  vi.useFakeTimers()
  const error = Object.assign(new Error('private path and token=secret'), { code: 'EPERM' }), failures = []
  const writer = createRunProgress({ batchSize: 8, flushMs: 200, write: async () => { throw error }, onFailure: value => failures.push(value) })
  try {
    await writer.push({ event: 'document-loaded' })
    await vi.advanceTimersByTimeAsync(200)
    expect(failures).toEqual([error]); expect(writer.error).toBe(error)
    await expect(writer.close()).rejects.toBe(error)
  } finally { await writer.close().catch(() => {}); vi.useRealTimers() }
})

test('diagnostics retain filesystem and lock causes without upstream messages or paths', () => {
  const fsError = Object.assign(new Error('C:/private/profile?token=secret'), { code: 'EPERM' })
  const wrapped = new Error('Sensitive remote response', { cause: fsError })
  const details = failureDetails(wrapped, 'progress-write')
  expect(details).toMatchObject({ operation: 'progress-write', causeCode: 'fs-eperm' })
  expect(JSON.stringify(details)).not.toMatch(/private|secret|Sensitive|response|C:/)
  expect(failureDetails(new Error('atomic-write: timed out waiting for the writer lock at C:/private'), 'state-commit')).toMatchObject({ causeCode: 'storage-lock-timeout' })
  expect(failureDetails(Object.assign(new Error('secret'), { code: 'article-restricted' }), 'capture')).toMatchObject({ causeCode: 'article-restricted' })
})
