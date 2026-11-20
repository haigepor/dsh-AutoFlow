import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { wallpaperPositionedSeamRegions } from '../src/media/wallpaper-render.ts'
import { wallpaperProcessingSchema } from '../src/shared/wallpaper-policy.ts'

const canvas = { width: 480, height: 854, processing: wallpaperProcessingSchema.parse({ sourceSeam: { segmentPixels: 64 } }) }
const target = { left: 65, top: 270, width: 350, height: 254 }
const previousArtifact = { x: target.left / canvas.width, y: target.top / canvas.height, width: target.width / canvas.width, height: target.height / canvas.height }

async function candidate(markup: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}"><rect width="100%" height="100%" fill="#283443"/>${markup}</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

test('a shifted interior patch is localized on the retry pixels before reconstruction', async () => {
  const top = target.top - 16, bottom = target.top + target.height + 10
  const generated = await candidate(`<rect x="47" y="${top}" width="388" height="${bottom - top}" fill="#c1a092"/>`)
  assert.deepEqual(await wallpaperPositionedSeamRegions(generated, target, canvas), [])

  const details = await wallpaperPositionedSeamRegions(generated, undefined, canvas, previousArtifact)
  assert.equal(details.length, 2)
  assert.ok(details.every(rect => rect.x > 0 && rect.x + rect.width < 1 && rect.y > 0 && rect.y + rect.height < 1))
  for (const edge of [top, bottom]) assert.ok(details.some(rect => rect.y * canvas.height < edge && (rect.y + rect.height) * canvas.height > edge))
})

test('a repeated-artifact search excludes strong bands continuing across the whole canvas', async () => {
  const band = await candidate('<rect x="0" y="255" width="480" height="280" fill="#d29b61"/>')
  assert.deepEqual(await wallpaperPositionedSeamRegions(band, undefined, canvas, previousArtifact), [])
})

test('two short unrelated marks in the previous artifact area do not match a recurring seam', async () => {
  const linework = await candidate('<rect x="70" y="258" width="68" height="12" fill="#bdced8"/><rect x="70" y="513" width="68" height="9" fill="#d29b61"/>')
  assert.deepEqual(await wallpaperPositionedSeamRegions(linework, undefined, canvas, previousArtifact), [])
})

test('a bounded single cut across a placed source edge is localized in the current screen', async () => {
  const cut = await candidate('<path d="M65 270 C210 281 290 324 320 375 C310 450 202 510 65 510 Z" fill="#c1a092"/>')
  assert.deepEqual(await wallpaperPositionedSeamRegions(cut, target, canvas), [])
  const [detail, extra] = await wallpaperPositionedSeamRegions(cut, target, canvas, undefined, 'positioned-edge-v2')
  assert.ok(detail)
  assert.equal(extra, undefined)
  assert.ok(detail.x < (target.left - 40) / canvas.width)
  assert.ok(detail.x + detail.width > (target.left + 100) / canvas.width)
  assert.ok(detail.height >= canvas.processing.sourceSeam.segmentPixels * 2 / canvas.height)
})

test('the current screen leaves a single aligned wood joint that continues through the canvas alone', async () => {
  const straight = await candidate('<path d="M65 0H480V854H65Z" fill="#875d47"/>')
  const diagonal = await candidate('<path d="M100 0L8 854H480V0Z" fill="#875d47"/>')
  assert.deepEqual(await wallpaperPositionedSeamRegions(straight, target, canvas, undefined, 'positioned-edge-v2'), [])
  assert.deepEqual(await wallpaperPositionedSeamRegions(diagonal, target, canvas, undefined, 'positioned-edge-v2'), [])
  assert.deepEqual(await wallpaperPositionedSeamRegions(straight, target, canvas, undefined, 'positioned-edge-v4'), [])
  assert.deepEqual(await wallpaperPositionedSeamRegions(diagonal, target, canvas, undefined, 'positioned-edge-v4'), [])
})

test('fragmented hard cuts near a shifted inset corner take priority over later contour alignment', async () => {
  const left = target.left - 10
  const cut = await candidate(`<path d="M${left} 292C123 291 151 301 144 309C134 317 85 312 ${left} 315Z" fill="#b44139"/><path d="M${left} 339C102 337 139 345 129 355C119 365 82 363 ${left} 365Z" fill="#f4cc77"/><rect x="65" y="409" width="50" height="16" fill="#846557"/><rect x="65" y="447" width="50" height="16" fill="#846557"/>`)
  assert.deepEqual(await wallpaperPositionedSeamRegions(cut, target, canvas, undefined, 'positioned-edge-v3'), [])
  const [detail, extra] = await wallpaperPositionedSeamRegions(cut, target, canvas, undefined, 'positioned-edge-v4')
  assert.ok(detail)
  assert.equal(extra, undefined)
  assert.ok(detail.x * canvas.width < left && (detail.x + detail.width) * canvas.width > left)
  assert.ok(detail.y * canvas.height < 315 && (detail.y + detail.height) * canvas.height > 339)
})

test('short contours on different lines do not form a fragmented source seam', async () => {
  const separate = await candidate('<path d="M56 292C123 291 151 301 144 309C134 317 85 312 56 315Z" fill="#b44139"/><path d="M74 339C102 337 139 345 129 355C119 365 82 363 74 365Z" fill="#f4cc77"/>')
  assert.deepEqual(await wallpaperPositionedSeamRegions(separate, target, canvas, undefined, 'positioned-edge-v4'), [])
})

test('a nearly full-width positioned frame can have one hard seam with distant discontinuities on the same line', async () => {
  const fullSpan = { left: 0, top: 270, width: canvas.width - 12, height: canvas.height - 270 }
  const pixels = await candidate('<rect x="20" y="270" width="20" height="300" fill="#c1a092"/><rect x="302" y="270" width="118" height="300" fill="#51834a"/>')
  assert.deepEqual(await wallpaperPositionedSeamRegions(pixels, fullSpan, canvas), [])
  assert.deepEqual(await wallpaperPositionedSeamRegions(pixels, fullSpan, canvas, undefined, 'positioned-edge-v2'), [])
  const [detail, extra] = await wallpaperPositionedSeamRegions(pixels, fullSpan, canvas, undefined, 'positioned-edge-v3')
  assert.ok(detail)
  assert.equal(extra, undefined)
  assert.ok(detail.x < 20 / canvas.width && detail.x + detail.width > 320 / canvas.width)
  assert.ok(detail.y < 270 / canvas.height && detail.y + detail.height > 270 / canvas.height)
})
