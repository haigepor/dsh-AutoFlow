/** The requested default and decoded bytes are checked through the upstream media implementation. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { ClipRegistry } from '../src/host/clip-registry.js'
import { ClipResolver } from '../src/host/clip-resolver.js'
import { MediaServer } from '../src/host/media-server.js'
import { CLIPS } from '../lib/clips.meta.js'

test('offers only cyberpunk and falls back to it when a retired clip was selected', () => {
  const registry = new ClipRegistry({ embedded: CLIPS, scanDirs: () => [] })
  let selectedClipId: string | null = null
  const resolver = new ClipResolver({
    registry,
    selection: { read: () => ({ randomPlayback: false, selectedClipId }), conversationOverrideOf: () => null },
    random: { pick: () => null },
  })
  assert.deepEqual(CLIPS.map(clip => clip.id), ['cyberpunk'])
  assert.equal(resolver.resolveActive().clip?.id, 'builtin:cyberpunk')
  selectedClipId = 'builtin:brand'
  assert.equal(registry.get(selectedClipId), null)
  assert.equal(resolver.resolveActive().clip?.id, 'builtin:cyberpunk')
})

test('serves the exact cyberpunk bytes recorded in the upstream clip metadata', async () => {
  const media = new MediaServer({ dataModulePath: new URL('../lib/clips.data.js', import.meta.url).href })
  const video = await media.embeddedBuffer('cyberpunk')
  assert.equal(video?.length, 1_856_280)
  assert.equal(createHash('sha256').update(video!).digest('hex').slice(0, 16), 'beabf5956e0b467e')
  assert.ok(video!.indexOf('moov') < video!.indexOf('mdat'))
})
