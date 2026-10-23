import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { crc32 } from 'node:zlib'
import sharp from 'sharp'
import { AssetFiles, MediaError, resolveCrop } from '../src/media/index.ts'
import type { MediaLimits } from '../src/media/index.ts'

const limits: MediaLimits = { maxFileBytes: 1024 * 1024, maxPixels: 1000000, maxDimension: 1000, previewMaxDimension: 32, maxStorageBytes: 8 * 1024 * 1024 }
const hasCode = (code: string) => (error: unknown) => error instanceof MediaError && error.code === code

test('imports original bytes immutably, reuses exact digest blobs and applies EXIF orientation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'visual-media-'))
  try {
    const files = new AssetFiles(directory, limits)
    const bytes = await sharp({ create: { width: 80, height: 40, channels: 3, background: 'red' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const first = await files.importBytes(bytes, 'image/jpeg')
    const repeated = await files.importBytes(bytes)
    assert.deepEqual(repeated, first)
    assert.deepEqual(await files.read(first.originalBlob), bytes)
    assert.equal(first.normalized.width, 40)
    assert.equal(first.normalized.height, 80)
    assert.equal(first.normalized.sourceOrientation, 6)
    assert.equal(first.preview.width, 16)
    assert.equal(first.preview.height, 32)
    const normalized = await sharp(await files.read(first.normalized.blob)).metadata()
    assert.equal(normalized.orientation, undefined)
    assert.equal(normalized.space, 'srgb')
    const path = join(directory, 'source.jpg')
    await writeFile(path, bytes)
    const importedFile = await files.importFile(path)
    await writeFile(path, 'replaced', 'utf8')
    assert.deepEqual(await files.read(importedFile.originalBlob), bytes)
    assert.notDeepEqual(await readFile(path), bytes)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('rejects mismatched MIME, malformed files, byte/pixel limits and animations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'visual-media-'))
  try {
    const files = new AssetFiles(directory, limits)
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer()
    await assert.rejects(files.importBytes(png, 'image/jpeg'), hasCode('invalid-input'))
    await assert.rejects(files.importBytes(Buffer.from('not pixels')), hasCode('invalid-input'))
    await assert.rejects(files.importBytes(Buffer.alloc(limits.maxFileBytes + 1)), hasCode('invalid-input'))
    const tinyPixels = new AssetFiles(directory, { ...limits, maxPixels: 32 })
    await assert.rejects(tinyPixels.importBytes(png), hasCode('invalid-input'))
    const animated = await sharp(Buffer.concat([Buffer.alloc(8 * 8 * 3, 0), Buffer.alloc(8 * 8 * 3, 255)]), { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer()
    await assert.rejects(files.importBytes(animated, 'image/webp'), hasCode('invalid-input'))
    const chunk = Buffer.alloc(20)
    chunk.writeUInt32BE(8, 0); chunk.write('acTL', 4, 'ascii'); chunk.writeUInt32BE(2, 8); chunk.writeUInt32BE(crc32(chunk.subarray(4, 16)), 16)
    const apng = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)])
    await assert.rejects(files.importBytes(apng, 'image/png'), hasCode('invalid-input'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('resolves the largest exact integer ratio inside rounded suggestions and rejects unsafe geometry', () => {
  const usage = { aspectP: 9, aspectQ: 16, targetWidth: 90, targetHeight: 160 }
  assert.deepEqual(resolveCrop({ x: 0, y: 0, width: 1, height: 1 }, { width: 3840, height: 2160 }, usage).effectivePixelRect, { left: 1312, top: 0, width: 1215, height: 2160 })
  const region = resolveCrop({ x: 0.101, y: 0.101, width: 0.599, height: 0.799 }, { width: 100, height: 100 }, { aspectP: 2, aspectQ: 3, targetWidth: 20, targetHeight: 30 })
  assert.deepEqual(region.effectivePixelRect, { left: 14, top: 11, width: 52, height: 78 })
  for (const rect of [{ x: -0.1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1.1, height: 1 }, { x: 0, y: 0, width: Number.NaN, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }]) assert.throws(() => resolveCrop(rect, { width: 100, height: 100 }, usage), hasCode('invalid-input'))
  assert.throws(() => resolveCrop({ x: 0, y: 0, width: 1, height: 1 }, { width: 100, height: 100 }, usage), hasCode('invalid-input'))
  assert.throws(() => resolveCrop({ x: 0, y: 0, width: 1, height: 1 }, { width: 100, height: 100 }, { aspectP: 2, aspectQ: 4, targetWidth: 20, targetHeight: 40 }), hasCode('invalid-input'))
})

test('writes actual exact-size crop pixels without replacing parent, rejects changed/missing/path-escaped blobs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'visual-media-'))
  try {
    const files = new AssetFiles(directory, limits)
    const red = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'red' } }).png().toBuffer()
    const green = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#00ff00' } }).png().toBuffer()
    const original = await sharp({ create: { width: 200, height: 100, channels: 3, background: 'black' } }).composite([{ input: red, left: 0, top: 0 }, { input: green, left: 100, top: 0 }]).png().toBuffer()
    const imported = await files.importBytes(original)
    const crop = await files.crop(imported.normalized.blob, imported.normalized, { x: 0.5, y: 0, width: 0.5, height: 1 }, { aspectP: 1, aspectQ: 1, targetWidth: 50, targetHeight: 50 })
    const actual = await sharp(await files.read(crop.blob)).raw().toBuffer({ resolveWithObject: true })
    assert.equal(actual.info.width, 50)
    assert.equal(actual.info.height, 50)
    assert.deepEqual([...actual.data.subarray(0, 3)], [0, 255, 0])
    assert.equal(crop.processing.parentDigest, imported.normalized.blob.digest)
    assert.deepEqual(await files.read(imported.originalBlob), original)
    await assert.rejects(files.read({ ...crop.blob, storageRef: '../source' }), hasCode('reference-unavailable'))
    await writeFile(join(directory, crop.blob.storageRef), Buffer.alloc(crop.blob.byteLength))
    await assert.rejects(files.read(crop.blob), hasCode('reference-unavailable'))
    await assert.rejects(files.read({ ...crop.blob, digest: 'a'.repeat(64), storageRef: `blobs/aa/${'a'.repeat(64)}` }), hasCode('reference-unavailable'))
    const cancelled = AbortSignal.abort()
    await assert.rejects(files.importBytes(original, undefined, cancelled), hasCode('cancelled'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('enforces private blob storage quota before publishing references', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'visual-media-'))
  try {
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).png().toBuffer()
    await assert.rejects(new AssetFiles(directory, { ...limits, maxStorageBytes: bytes.length - 1 }).importBytes(bytes), hasCode('budget-exhausted'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('refuses a blob parent junction before writing outside private storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'visual-media-'))
  const outside = await mkdtemp(join(tmpdir(), 'visual-outside-'))
  try {
    await symlink(outside, join(directory, 'blobs'), 'junction')
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer()
    await assert.rejects(new AssetFiles(directory, limits).importBytes(bytes), hasCode('reference-unavailable'))
    assert.deepEqual(await readdir(outside), [])
  } finally { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})
