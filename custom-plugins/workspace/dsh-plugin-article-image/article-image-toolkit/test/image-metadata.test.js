/** Current-article image descriptions read only declared data and never widen DOM image scope. */
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createCapture, resolveCaptureConfig } from '../src/capture.js'
import { hashSnapshot } from '../src/capture-contracts.js'

const url = 'https://articles.example.test/report'
const source = 'https://images.example.test/resizer/v2/LEAD.jpg?width=1600&auth=large-signature'
const alt = 'Oficina - Mec\u00e2nico'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVQImWP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64')
const rule = { hosts: ['articles.example.test'], globalPath: ['Fusion', 'globalContent'], identityPath: ['canonical_url'], itemsPath: ['content_elements'], typeKey: 'type', typeValue: 'image', sourcePath: ['additional_properties', 'resizeUrl'], altPath: ['alt_text'] }
const item = (imageUrl = source, description = alt) => ({ type: 'image', additional_properties: { resizeUrl: imageUrl }, alt_text: description })
const currentWindow = (items = [item()], identity = url) => ({ Fusion: { globalContent: { canonical_url: identity, content_elements: items } } })

function page(window) {
  const calls = []
  return { calls, async evaluate(callback, args, unused, isolatedWorld) {
    calls.push({ args, unused, isolatedWorld })
    const value = await vm.runInNewContext('(' + callback.toString() + ')(input)', { window, input: args, URL })
    return structuredClone(value)
  } }
}

async function read(target, targetUrl = url, overrides = {}) {
  const config = resolveCaptureConfig({ imageMetadataSources: [rule], ...overrides })
  const moduleUrl = new URL('../src/capture-image-metadata.js', import.meta.url).href
  const { readImageDescriptions } = await import(moduleUrl)
  return readImageDescriptions(target, targetUrl, config)
}

async function captureDescription(markup, descriptions = []) {
  const requested = []
  const capture = createCapture(resolveCaptureConfig({ minArticleChars: 1, imageMetadataSources: [rule] }), {
    renderer: { render: async () => ({ html: markup, url, statusCode: 200, diagnostics: [], imageDescriptions: descriptions }), dispose: async () => {} },
    inspectImage: async () => ({ width: 2, height: 2, mime: 'image/png' }),
    request: async target => { requested.push(target); return { url: target, bytes: png, statusCode: 200, mime: 'image/png', headers: { 'content-type': 'image/png' } } },
  })
  try { return { ...(await capture.capture(url)), requested } }
  finally { await capture.dispose() }
}

describe('public image description metadata', () => {
  it('reads the exact current article in the main world without changing its declared alternative text', async () => {
    const target = page(currentWindow([item()], url + '#current'))
    expect(await read(target)).toEqual([{ url: source, alt }])
    expect(target.calls).toHaveLength(1)
    expect(target.calls[0].unused).toBeUndefined()
    expect(target.calls[0].isolatedWorld).toBe(false)
  })

  it('resolves published relative source URLs without following recommendation objects or wrong element types', async () => {
    const window = currentWindow([{ ...item(), type: 'text' }, { type: 'related_story', content_elements: [item()] }, item('/images/current.png')])
    window.Fusion.globalContent.recommendations = [item('https://images.example.test/recommended.png', 'Recommended scene')]
    expect(await read(page(window))).toEqual([{ url: 'https://articles.example.test/images/current.png', alt }])
  })

  it('does not evaluate globals when no metadata source is configured or the exact host does not match', async () => {
    const empty = page(currentWindow()), mismatch = page(currentWindow())
    expect(await read(empty, url, { imageMetadataSources: [] })).toEqual([])
    expect(await read(mismatch, 'https://articles.example.test.evil/report')).toEqual([])
    expect(empty.calls).toHaveLength(0)
    expect(mismatch.calls).toHaveLength(0)
  })

  it.each([
    'https://articles.example.test/recommended',
    'https://other.example.test/report',
    'http://articles.example.test/report',
    'https://articles.example.test/report?other=1',
  ])('rejects metadata whose canonical identity is %s', async identity => {
    expect(await read(page(currentWindow([item()], identity)))).toEqual([])
  })

  it.each(['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///private.png', 'https://user:secret@images.example.test/photo.png', ''])('rejects unsafe image source %s', async imageUrl => {
    expect(await read(page(currentWindow([item(imageUrl)])))).toEqual([])
  })

  it.each(['global', 'content', 'identity', 'items', 'array item', 'type', 'source parent', 'source URL', 'alternative text'])('never invokes a %s getter while reading published metadata', async position => {
    const image = item(), items = [image], window = currentWindow(items)
    let invoked = 0
    const getter = (object, key, value) => Object.defineProperty(object, key, { configurable: true, enumerable: true, get() { invoked++; return value } })
    if (position === 'global') getter(window, 'Fusion', window.Fusion)
    if (position === 'content') getter(window.Fusion, 'globalContent', window.Fusion.globalContent)
    if (position === 'identity') getter(window.Fusion.globalContent, 'canonical_url', url)
    if (position === 'items') getter(window.Fusion.globalContent, 'content_elements', items)
    if (position === 'array item') getter(items, '0', image)
    if (position === 'type') getter(image, 'type', 'image')
    if (position === 'source parent') getter(image, 'additional_properties', image.additional_properties)
    if (position === 'source URL') getter(image.additional_properties, 'resizeUrl', source)
    if (position === 'alternative text') getter(image, 'alt_text', alt)
    expect(await read(page(window))).toEqual([])
    expect(invoked).toBe(0)
  })

  it('does not accept inherited metadata fields or alternative text longer than 2000 characters', async () => {
    const inherited = Object.assign(Object.create({ alt_text: alt }), { type: 'image', additional_properties: { resizeUrl: source } })
    expect(await read(page(currentWindow([inherited, item(source, 'x'.repeat(2001))])))).toEqual([])
  })

  it('keeps scanning bounded by maxArticleElements and limits emitted descriptions to maxImages', async () => {
    const beyondBudget = [...Array.from({ length: 100 }, () => ({ type: 'text' })), item()]
    expect(await read(page(currentWindow(beyondBudget)), url, { maxArticleElements: 100 })).toEqual([])
    const items = [item('/one.png', 'One'), item('/two.png', 'Two'), item('/three.png', 'Three')]
    expect(await read(page(currentWindow(items)), url, { maxImages: 2 })).toEqual([])
  })

  it('deduplicates identical declarations and rejects conflicting descriptions for the same published URL', async () => {
    expect(await read(page(currentWindow([item(), item()])))).toEqual([{ url: source, alt }])
    const conflicting = page(currentWindow([item(), item(source, 'Conflicting description')]))
    expect(await read(conflicting)).toEqual([])
  })

  it('rejects excess distinct declarations instead of hiding conflicts behind the output limit', async () => {
    const variant = source.replace('width=1600', 'width=320')
    expect(await read(page(currentWindow([item(), item(variant, 'Conflicting size variant')])), url, { maxImages: 1 })).toEqual([])
  })

  it('rejects exact-URL conflicts before another size variant can conceal them across the browser result', async () => {
    const variant = source.replace('width=1600', 'width=640')
    expect(await read(page(currentWindow([item(), item(source, 'Conflicting description'), item(variant, 'Another size description')])))).toEqual([])
  })

  it('rejects prototype traversal in every metadata path and in its type key', () => {
    for (const path of ['globalPath', 'identityPath', 'itemsPath', 'sourcePath', 'altPath']) for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(() => resolveCaptureConfig({ imageMetadataSources: [{ ...rule, [path]: [key] }] })).toThrow()
    }
    expect(() => resolveCaptureConfig({ imageMetadataSources: [{ ...rule, typeKey: '__proto__' }] })).toThrow()
  })

  it('fills only matched empty DOM alt while preserving captions, image positions, original bytes and the hydrated semantic hash', async () => {
    const selected = 'https://images.example.test/resizer/v2/LEAD.jpg?width=1200&auth=selected-signature'
    const preview = 'https://images.example.test/resizer/v2/LEAD.jpg?width=320&auth=small-signature'
    const second = 'https://images.example.test/resizer/v2/SECOND.jpg?width=1200&auth=second-signature'
    const markup = `<title>Current report</title><article><p>Opening public facts.</p><figure><img data-srcset="${preview} 320w, ${selected} 1200w"><figcaption>Original first caption.</figcaption></figure><figure><img src="${second}" alt="Existing DOM description"><figcaption>Original second caption.</figcaption></figure><p>Closing public facts.</p></article>`
    const descriptions = [{ url: source, alt }, { url: second, alt: 'Replacement must be ignored' }, { url: 'https://images.example.test/resizer/v2/UNRELATED.jpg', alt: 'Unrelated scene' }]
    const result = await captureDescription(markup, descriptions)
    const hydrated = await captureDescription(markup.replace('<img data-srcset=', `<img alt="${alt}" data-srcset=`))
    expect(result.requested).toEqual([selected, second])
    expect(result.snapshot.blocks).toEqual(hydrated.snapshot.blocks)
    expect(result.snapshot.blocks.filter(block => block.type === 'figure').map(block => [block.alt, block.caption])).toEqual([[alt, 'Original first caption.'], ['Existing DOM description', 'Original second caption.']])
    expect(result.snapshot.blocks.map(block => block.type)).toEqual(['paragraph', 'figure', 'figure', 'paragraph'])
    expect(result.assets).toHaveLength(1)
    expect(result.assets[0].bytes).toEqual(png)
    expect(result.snapshot.assets[0].positions).toHaveLength(2)
    expect(result.snapshot.sourceHash).toBe(hydrated.snapshot.sourceHash)
    expect(result.snapshot.sourceHash).toBe(hashSnapshot(result.snapshot))
  })

  it.each([
    ['conflicting normalized descriptions', [{ url: source, alt }, { url: 'https://images.example.test/resizer/v2/LEAD.jpg?width=320&auth=other-signature', alt: 'Conflicting description' }]],
    ['a different resource ID', [{ url: 'https://images.example.test/resizer/v2/OTHER.jpg?width=1600&auth=large-signature', alt }]],
    ['an unrelated identity parameter', [{ url: source + '&id=other', alt }]],
  ])('does not fill a DOM description from %s or introduce another image', async (_kind, descriptions) => {
    const selected = 'https://images.example.test/resizer/v2/LEAD.jpg?width=1200&auth=selected-signature'
    const result = await captureDescription(`<title>Current report</title><article><p>Public reporting.</p><figure><img src="${selected}"><figcaption>Original caption.</figcaption></figure></article>`, descriptions)
    expect(result.requested).toEqual([selected])
    expect(result.snapshot.blocks.filter(block => block.type === 'figure')).toMatchObject([{ alt: '', caption: 'Original caption.' }])
  })

  it('does not use another candidate to hide a conflicting description on the selected original', async () => {
    const selected = 'https://images.example.test/resizer/v2/LEAD.jpg?width=1200&auth=selected-signature'
    const fallback = 'https://images.example.test/resizer/v2/SECOND.jpg?width=320&auth=small-signature'
    const result = await captureDescription(`<title>Current report</title><article><p>Public reporting.</p><figure><img srcset="${fallback} 320w, ${selected} 1200w"><figcaption>Original caption.</figcaption></figure></article>`, [{ url: source, alt }, { url: selected, alt: 'Conflicting description' }, { url: fallback, alt: 'Fallback description' }])
    expect(result.requested).toEqual([selected])
    expect(result.snapshot.blocks.filter(block => block.type === 'figure')).toMatchObject([{ alt: '' }])
  })
})
