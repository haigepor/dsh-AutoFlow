/** Byte limits and stream cleanup for repository and marketplace response bodies. */
import { expect, it } from 'vitest'
import { readDownload } from '../src/download.ts'
import { ManagementError } from '../src/files.ts'

it('accepts a response exactly at the byte limit and releases its reader', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([11, 22]))
      controller.enqueue(new Uint8Array([33]))
      controller.close()
    },
  })
  expect(Array.from(await readDownload(new Response(body), 3))).toEqual([11, 22, 33])
  expect(body.locked).toBe(false)
})

it('rejects an oversized body and cancels the remaining stream', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([11, 22, 33, 44]))
    },
    cancel() { cancelled = true },
  })
  await expect(readDownload(new Response(body), 3)).rejects.toMatchObject({ code: 'too-large' })
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})

it('rejects unsuccessful responses and missing bodies as download failures', async () => {
  await expect(readDownload(new Response(null, { status: 404 }), 3)).rejects.toEqual(new ManagementError('network'))
  await expect(readDownload(new Response(null), 3)).rejects.toEqual(new ManagementError('network'))
})
