/** A temporary original transfer failure cannot immediately downgrade image quality. */
import { test, expect } from 'vitest'
import { captureAssets } from '../src/capture-media.js'
import { createCapture, resolveCaptureConfig } from '../src/capture.js'
import { failure } from '../src/contracts.js'

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVQImWP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64')
const base = resolveCaptureConfig({ maxImageBytes: 1000, maxTotalImageBytes: 5000, maxImageCandidates: 2 })
const original = 'https://images.example.test/original.png', small = 'https://images.example.test/small.png'
const figures = [{ blockId: 'b1', sourceUrl: original, candidates: [original, small], alt: 'Published original', caption: '', credit: '' }]
const inspectImage = async () => ({ width: 2, height: 2 })
const response = url => ({ bytes, mime: 'image/png', statusCode: 200, url })

test('retries the same original after a transient timeout before selecting a smaller candidate', async () => {
  const calls = [], events = []
  const result = await captureAssets(figures, base, { inspectImage, onProgress: value => events.push(value), request: async url => {
    calls.push(url)
    if (calls.length === 1) throw failure('article-timeout')
    return response(url)
  } })
  expect(calls).toEqual([original, original])
  expect(result.metadata[0].sourceUrl).toBe(original)
  expect(result.transferredBytes).toBe(1000 + bytes.length)
  expect(events.some(e => e.event === 'image-transfer-retry' && e.details.code === 'article-timeout')).toBe(true)
})

test('bounded retries reserve failed attempts and stop when the article budget is exhausted', async () => {
  const calls = []
  const result = await captureAssets(figures, { ...base, maxTotalImageBytes: 1000 }, { inspectImage, request: async url => { calls.push(url); throw failure('article-network') } })
  expect(calls).toEqual([original])
  expect(result.metadata[0]).toMatchObject({ status: 'failed', error: 'image-byte-limit' })
  expect(result.transferredBytes).toBe(1000)
})

test('a disabled retry policy retains the existing ordered candidate fallback', async () => {
  const calls = []
  const result = await captureAssets(figures, { ...base, maxImageTransportRetries: 0 }, { inspectImage, request: async url => {
    calls.push(url); if (url === original) throw failure('article-network'); return response(url)
  } })
  expect(calls).toEqual([original, small]); expect(result.metadata[0].sourceUrl).toBe(small)
})

test('an exhausted transient retry advances candidates while HTTP refusals are not retried', async () => {
  const calls = []
  const result = await captureAssets(figures, base, { inspectImage, request: async url => {
    calls.push(url); if (url === original) throw failure('article-network'); return response(url)
  } })
  expect(calls).toEqual([original, original, small])
  expect(result.metadata[0].sourceUrl).toBe(small)
  expect(result.transferredBytes).toBe(2000 + bytes.length)
  calls.length = 0
  const denied = await captureAssets(figures, base, { inspectImage, request: async url => {
    calls.push(url); return url === original ? { bytes: Buffer.from('Denied'), statusCode: 403, mime: 'text/plain', url } : response(url)
  } })
  expect(calls).toEqual([original, small])
  expect(denied.metadata[0].sourceUrl).toBe(small)
})

test('cancellation and public-policy refusal never retry or choose another candidate', async () => {
  for (const code of ['article-url-blocked', 'article-redirect']) {
    const calls = []
    const result = await captureAssets(figures, base, { inspectImage, request: async url => { calls.push(url); throw failure(code) } })
    expect(calls).toEqual([original]); expect(result.metadata[0].error).toBe(code)
  }
  const controller = new AbortController(), calls = []
  await expect(captureAssets(figures, base, { signal: controller.signal, inspectImage, request: async url => {
    calls.push(url); controller.abort(); throw failure('article-network')
  } })).rejects.toThrow('article-interrupted')
  expect(calls).toEqual([original])
})

test('a decoder startup failure retains source text and failed image positions instead of failing the whole capture', async () => {
  const config = resolveCaptureConfig({ minArticleChars: 1, adapters: [{ id: 'fixture', hosts: ['articles.example.test'], articleSelector: 'article' }] })
  const capture = createCapture(config, { request: async url => response(url), renderer: {
    render: async url => ({ url, statusCode: 200, diagnostics: [], html: `<title>Published reporting</title><article><p>Public reporting remains available when its image decoder is unavailable.</p><img src="${original}"><img src="https://images.example.test/another.png"></article>` }),
    createImageInspector: async () => { throw failure('article-render-unavailable') },
    dispose: async () => {},
  } })
  try {
    const { snapshot } = await capture.capture('https://articles.example.test/story')
    expect(snapshot.blocks.filter(b => b.type === 'paragraph')).toHaveLength(1)
    expect(snapshot.assets).toHaveLength(2)
    expect(snapshot.assets.every(a => a.status === 'failed' && a.error === 'image-invalid')).toBe(true)
    expect(snapshot.quality.status).toBe('partial')
  } finally { await capture.dispose() }
})
