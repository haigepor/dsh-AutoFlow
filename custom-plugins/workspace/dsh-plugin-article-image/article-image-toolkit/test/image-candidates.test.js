/** Original-image fallback preserves article positions and bounded acquisition. */
import { describe, expect, it, vi } from 'vitest'
import { createCapture, resolveCaptureConfig } from '../src/capture.js'

const url = 'https://articles.example.test/story'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVQImWP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64')

async function captureImages(markup, request, overrides = {}) {
  const requests = [], progress = []
  const capture = createCapture(resolveCaptureConfig({ minArticleChars: 1, ...overrides }), {
    renderer: { async render() { return { html: `<title>Article</title><article><h1>Article</h1><p>Complete public text.</p>${markup}</article>`, url, statusCode: 200, diagnostics: [] } }, async dispose() {} },
    request: async (target, options) => { requests.push(target); return request(target, options) },
    inspectImage: async () => ({ width: 2, height: 2 }),
  })
  try { return { ...(await capture.capture(url, { onProgress: value => { progress.push(value) } })), requests, progress } }
  finally { await capture.dispose() }
}
const image = target => ({ bytes: png, url: target, statusCode: 200, mime: 'image/png' })

describe('article image candidates', () => {
  it('decodes inline PNG bytes without HTTP while keeping safe metadata and repeated positions', async () => {
    const source = `data:image/png;base64,${png.toString('base64')}`
    const result = await captureImages(`<figure><img src="${source}" alt="First scene"><figcaption>First occurrence</figcaption></figure><figure><img src="${source}" alt="Second scene"><figcaption>Second occurrence</figcaption></figure>`, async () => { throw new Error('Inline images must not use HTTP') })
    const figures = result.snapshot.blocks.filter(block => block.type === 'figure')
    expect(result.requests).toEqual([])
    expect(result.assets).toHaveLength(1)
    expect(result.assets[0]).toMatchObject({ status: 'ready', sourceUrl: url, mime: 'image/png', width: 2, height: 2, bytes: png })
    expect(result.snapshot.assets).toHaveLength(1)
    expect(result.snapshot.assets[0]).toMatchObject({ status: 'ready', sourceUrl: url, positions: figures.map(block => block.id) })
    expect(figures.map(block => block.assetId)).toEqual([result.assets[0].id, result.assets[0].id])
    expect(figures.map(block => block.caption)).toEqual(['First occurrence', 'Second occurrence'])
    expect(JSON.stringify(result.snapshot)).not.toContain('data:image/')
    expect(JSON.stringify(result.snapshot)).not.toContain(png.toString('base64'))
  })

  it.each([
    'data:image/png;base64,@@@',
    `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')}`,
  ])('keeps invalid inline image %s as a failed figure instead of dropping it', async source => {
    const result = await captureImages(`<img src="${source}" alt="Published illustration">`, async () => { throw new Error('Inline images must not use HTTP') })
    const figures = result.snapshot.blocks.filter(block => block.type === 'figure')
    expect(result.requests).toEqual([])
    expect(result.assets).toHaveLength(0)
    expect(figures).toHaveLength(1)
    expect(result.snapshot.assets).toHaveLength(1)
    expect(result.snapshot.assets[0]).toMatchObject({ status: 'failed', error: 'image-invalid', sourceUrl: url, positions: [figures[0].id] })
    expect(result.snapshot.quality.status).toBe('partial')
    expect(JSON.stringify(result.snapshot)).not.toContain('data:image/')
  })

  it.each([
    { budget: 'per-image bytes', buffers: [Buffer.concat([png, Buffer.alloc(128)])], overrides: { maxImageBytes: 100, maxTotalImageBytes: 1000 }, ready: 0, error: 'image-byte-limit' },
    { budget: 'total image bytes', buffers: [Buffer.concat([png, Buffer.alloc(150 - png.length, 1)]), Buffer.concat([png, Buffer.alloc(150 - png.length, 2)])], overrides: { maxImageBytes: 200, maxTotalImageBytes: 200 }, ready: 1, error: 'image-byte-limit' },
    { budget: 'image pixels', buffers: [png], overrides: { maxImagePixels: 3 }, ready: 0, error: 'image-dimensions' },
  ])('applies the $budget budget to inline raster images', async ({ buffers, overrides, ready, error }) => {
    const markup = buffers.map(buffer => `<img src="data:image/png;base64,${buffer.toString('base64')}">`).join('')
    const result = await captureImages(markup, async () => { throw new Error('Inline images must not use HTTP') }, overrides)
    expect(result.requests).toEqual([])
    expect(result.snapshot.blocks.filter(block => block.type === 'figure')).toHaveLength(buffers.length)
    expect(result.assets).toHaveLength(ready)
    expect(result.snapshot.assets.at(-1)).toMatchObject({ status: 'failed', error, sourceUrl: url })
    expect(result.snapshot.quality.status).toBe('partial')
  })

  it('uses the original file explicitly referenced by a DIMS image URL', async () => {
    const original = 'https://media.example.test/original.jpg'
    const result = await captureImages(`<img src="https://cdn.example.test/dims3/default/resize/1800/?url=${encodeURIComponent(original)}">`, async target => target === original ? image(target) : { ...image(target), statusCode: 403 })
    expect(result.assets).toHaveLength(1)
    expect(result.assets[0].sourceUrl).toBe(original)
    expect(result.requests[0]).toBe(original)
  })

  it('does not treat unrelated URL query parameters as original-image declarations', async () => {
    const target = 'https://cdn.example.test/redirect?url=https%3A%2F%2Fother.example.test%2Fimage.png'
    const result = await captureImages(`<img src="${target}">`, async source => image(source))
    expect(result.requests).toEqual([target])
  })

  it('does not write malformed srcset or signed URLs to MCP stdout and still uses a valid src', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const result = await captureImages('<img srcset="/private.png?token=private-secret invalid" src="/valid.png">', async target => image(target))
      expect(stdout).not.toHaveBeenCalled()
      expect(result.requests).toEqual(['https://articles.example.test/valid.png'])
      expect(result.assets).toHaveLength(1)
    } finally { stdout.mockRestore() }
  })

  it('keeps commas inside responsive image URLs', async () => {
    const result = await captureImages('<img srcset="/photo,large.png 1600w, /small.png 300w" src="/tiny.png">', async target => image(target))
    expect(result.requests).toEqual(['https://articles.example.test/photo,large.png'])
    expect(result.snapshot.assets[0].sourceUrl).toBe(result.requests[0])
  })

  it('tries a responsive source after the declared original returns an HTTP error', async () => {
    const result = await captureImages('<figure><img data-original="/gone.png" srcset="/large.png 1600w, /small.png 300w" src="/small.png" alt="scene"><figcaption>Public credit</figcaption></figure>', async target => target.endsWith('/gone.png') ? { ...image(target), statusCode: 404 } : image(target))
    expect(result.requests).toEqual(['https://articles.example.test/gone.png', 'https://articles.example.test/large.png'])
    expect(result.snapshot.assets[0]).toMatchObject({ status: 'ready', sourceUrl: 'https://articles.example.test/large.png' })
    expect(result.snapshot.blocks.at(-1)).toMatchObject({ type: 'figure', alt: 'scene', caption: 'Public credit' })
    expect(result.snapshot.quality.status).toBe('needs-review')
    expect(result.progress.some(value => value.event === 'image-candidate-failed')).toBe(true)
  })

  it('falls back after invalid image bytes while keeping repeated occurrences', async () => {
    const result = await captureImages('<figure><img data-original="/invalid.png" src="/valid.png"><figcaption>First</figcaption></figure><figure><img data-original="/invalid.png" src="/valid.png"><figcaption>Second</figcaption></figure>', async target => target.endsWith('/invalid.png') ? { ...image(target), bytes: Buffer.from('not an image') } : image(target))
    expect(result.requests).toEqual(['https://articles.example.test/invalid.png', 'https://articles.example.test/valid.png'])
    const figures = result.snapshot.blocks.filter(value => value.type === 'figure')
    expect(result.assets).toHaveLength(1)
    expect(result.snapshot.assets[0].positions).toEqual(figures.map(value => value.id))
    expect(figures.map(value => value.caption)).toEqual(['First', 'Second'])
  })

  it('does not use another image picture sources within a shared figure', async () => {
    const result = await captureImages('<figure><img src="/first.png"><picture><source srcset="/second-large.png 1600w"><img src="/second.png"></picture></figure>', async target => image(target))
    expect(result.requests).toEqual(['https://articles.example.test/first.png', 'https://articles.example.test/second-large.png'])
  })

  it('keeps a blocked image visible as failed and never hides a network-policy rejection with fallback', async () => {
    const result = await captureImages('<img data-original="http://127.0.0.1/private" src="/other.png">', async () => { throw Object.assign(new Error('article-url-blocked'), { code: 'article-url-blocked' }) })
    expect(result.requests).toEqual(['http://127.0.0.1/private'])
    expect(result.snapshot.assets[0]).toMatchObject({ status: 'failed', error: 'article-url-blocked' })
    expect(result.snapshot.quality.status).toBe('partial')
  })

  it('counts failed response bytes against the total image budget', async () => {
    const limits = []
    const result = await captureImages('<img data-original="/invalid.png" src="/valid.png">', async (target, options) => {
      limits.push(options.maxBytes)
      const value = target.endsWith('/invalid.png') ? { ...image(target), bytes: Buffer.alloc(150) } : image(target)
      if (value.bytes.length > options.maxBytes) throw Object.assign(new Error('article-resource-limit'), { code: 'article-resource-limit' })
      return value
    }, { maxImageBytes: 200, maxTotalImageBytes: 200 })
    expect(limits).toEqual([200, 50])
    expect(result.assets).toHaveLength(0)
    expect(result.snapshot.quality.status).toBe('partial')
  })

  it('bounds candidate attempts and retains the failure when all permitted candidates fail', async () => {
    const result = await captureImages('<img data-original="/first.png" data-src="/second.png" src="/third.png">', async target => ({ ...image(target), statusCode: 404 }), { maxImageCandidates: 2 })
    expect(result.requests).toEqual(['https://articles.example.test/first.png', 'https://articles.example.test/second.png'])
    expect(result.assets).toHaveLength(0)
    expect(result.snapshot.assets[0]).toMatchObject({ status: 'failed', error: 'image-download', positions: ['b3'] })
  })

  it('does not reuse a different occurrence fallback when the primary source is shared', async () => {
    const result = await captureImages('<img data-original="/gone.png" src="/one.png"><img data-original="/gone.png" src="/two.png">', async target => target.endsWith('/gone.png') ? { ...image(target), statusCode: 404 } : image(target))
    expect(result.requests).toEqual(['https://articles.example.test/gone.png', 'https://articles.example.test/one.png', 'https://articles.example.test/two.png'])
    expect(result.assets).toHaveLength(1)
    expect(result.snapshot.assets[0].positions).toHaveLength(2)
  })
})
