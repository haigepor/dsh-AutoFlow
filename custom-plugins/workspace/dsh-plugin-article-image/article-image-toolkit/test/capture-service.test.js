/** Standalone MCP rich snapshots remain separate from legacy article records. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, symlink, mkdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { ArticleService } from '../src/service.js'
import { resolveConfig } from '../src/config.js'
import { createTools } from '../src/tools.js'
import { hashSnapshot } from '../src/capture-contracts.js'

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function result(text = '正文', bytes = Buffer.from('verified fixture asset')) {
  const contentHash = createHash('sha256').update(bytes).digest('hex'), assetId = contentHash.slice(0, 32)
  const snapshot = { id: randomBytes(16).toString('hex'), schemaVersion: 2, title: '富文本文章', requestedUrl: 'https://example.com/story', url: 'https://example.com/story', language: 'zh', capturedAt: new Date().toISOString(), extractorVersion: 'fixture/1', sourceHash: '0'.repeat(64),
    blocks: [{ id: 'b1', type: 'paragraph', inline: [{ text }] }, { id: 'b2', type: 'figure', assetId, alt: '原图', caption: '', credit: '' }],
    assets: [{ id: assetId, status: 'ready', sourceUrl: 'https://example.com/image.png', contentHash, mime: 'image/png', width: 100, height: 100, byteLength: bytes.length, positions: ['b2'], alt: '原图', caption: '', credit: '', error: null }], quality: { status: 'needs-review', reasons: ['unknown-article-scope'] } }
  snapshot.sourceHash = hashSnapshot(snapshot)
  return { snapshot, assets: [{ ...snapshot.assets[0], bytes }] }
}
async function setup(captureResult, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'article-image-capture-source-'))
  const engine = { calls: 0, closed: 0, async capture() { this.calls++; return captureResult ?? result() }, async readiness() { return { available: true } }, async dispose() { this.closed++ } }
  const service = new ArticleService(resolveConfig({ dataDir: dir, ...overrides }), { capture: engine })
  cleanups.push(async () => { await service.dispose(); await rm(dir, { recursive: true, force: true }) })
  const tools = new Map(createTools(service).map(tool => [tool.name, tool]))
  return { dir, engine, service, tools }
}

describe('standalone rich capture tools', () => {
  it('persists rich content and original bytes through the shared capture entry without changing schema:1 state', async () => {
    const value = result(), { dir, tools, engine } = await setup(value)
    const legacy = '{"schema":1,"source":null,"items":[]}\n'
    await writeFile(join(dir, 'state.json'), legacy, 'utf8')
    const summary = await tools.get('article_image_capture_source').run({ url: value.snapshot.url })
    expect(summary).toMatchObject({ snapshotId: value.snapshot.id, blocks: 2, images: 1, quality: { status: 'needs-review' }, generationAvailable: false })
    expect(JSON.stringify(summary)).not.toMatch(/bytes|base64|capture-sources/)
    expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe(legacy)
    expect(await readFile(join(dir, 'capture-sources', value.snapshot.id, `${value.assets[0].id}.bin`))).toEqual(value.assets[0].bytes)
    const page = await tools.get('article_image_source_page').run({ snapshotId: summary.snapshotId, offset: 0 })
    expect(page.blocks).toEqual(value.snapshot.blocks)
    expect(page.assets).toEqual(value.snapshot.assets)
    expect(page.nextOffset).toBeNull()
    expect(engine.calls).toBe(1)
  })

  it('reads every byte of an oversized rich block through bounded JSON fragments', async () => {
    const value = result('长文🙂'.repeat(12000)), { tools } = await setup(value, { toolResultBytes: 8000 })
    const summary = await tools.get('article_image_capture_source').run({ url: value.snapshot.url })
    let offset = 0, fragments = [], seenAssets = []
    do {
      const page = await tools.get('article_image_source_page').run({ snapshotId: summary.snapshotId, offset })
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8000)
      fragments.push(...page.fragments.filter(fragment => fragment.kind === 'block'))
      seenAssets.push(...page.assets)
      offset = page.nextOffset
    } while (offset !== null)
    expect(JSON.parse(fragments.map(fragment => fragment.json).join(''))).toEqual(value.snapshot.blocks[0])
    expect(seenAssets).toEqual(value.snapshot.assets)
  })

  it('rejects path-shaped IDs, wrong bytes and disk budgets without publishing a half snapshot', async () => {
    const value = result('x'.repeat(1000)), { tools, dir } = await setup(value, { maxCaptureDiskBytes: 1000 })
    await expect(tools.get('article_image_source_page').run({ snapshotId: '../outside', offset: 0 })).rejects.toThrow('invalid-request')
    await expect(tools.get('article_image_capture_source').run({ url: value.snapshot.url })).rejects.toThrow('capture-storage-size')
    expect((await readdir(join(dir, 'capture-sources')).catch(error => { if (error.code === 'ENOENT') return []; throw error })).filter(name => /^[a-f0-9]{32}$/.test(name))).toEqual([])
    const invalid = result(); invalid.assets[0].bytes = Buffer.from('wrong')
    const broken = await setup(invalid)
    await expect(broken.tools.get('article_image_capture_source').run({ url: invalid.snapshot.url })).rejects.toThrow('capture-asset-integrity')
  })

  it('rejects mismatched requested sources and symlinked parent directories', async () => {
    const value = result(); value.snapshot.requestedUrl = 'https://other.example.com/story'
    const wrong = await setup(value)
    await expect(wrong.tools.get('article_image_capture_source').run({ url: 'https://example.com/story' })).rejects.toThrow('capture-snapshot-integrity')
    const normal = await setup(result()), outside = await mkdtemp(join(tmpdir(), 'article-image-capture-outside-'))
    cleanups.push(async () => { await rm(outside, { recursive: true, force: true }) })
    await symlink(outside, join(normal.dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const linked = new ArticleService(resolveConfig({ dataDir: join(normal.dir, 'linked', 'nested') }), { capture: normal.engine })
    try {
      await expect(linked.captureSource({ url: 'https://example.com/story' })).rejects.toThrow('capture-storage-path')
      expect(await readdir(outside)).toEqual([])
    } finally { await linked.dispose() }
  })

  it('recovers an abandoned stale heartbeat lock', async () => {
    const { dir, tools } = await setup(result())
    await mkdir(join(dir, 'capture-sources'))
    const lock = join(dir, 'capture-sources', 'writer.lock')
    await mkdir(lock)
    await utimes(lock, new Date(0), new Date(0))
    const saved = await tools.get('article_image_capture_source').run({ url: 'https://example.com/story' })
    expect(saved.snapshotId).toMatch(/^[a-f0-9]{32}$/)
    expect(await readdir(join(dir, 'capture-sources'))).not.toContain('writer.lock')
  })
})
