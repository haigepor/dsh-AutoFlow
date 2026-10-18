/** Isolated stdio lifecycle fixture; the marker observes completed disposal after stdin EOF. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { start } from '../../src/server.js'
import { resolveConfig } from '../../src/config.js'
import { ArticleService } from '../../src/service.js'
import { hashSnapshot } from '../../src/capture-contracts.js'
const dataDir = process.argv[2]
const service = new ArticleService(resolveConfig({ dataDir }), { capture: {
  async capture(url, options) {
    await options.onProgress?.({ phase: 'rendering', event: 'navigation-start' })
    const snapshot = { schemaVersion: 2, id: '1'.repeat(32), title: 'Public fixture', requestedUrl: url, url, language: 'en',
      capturedAt: '2026-10-17T00:00:00.000Z', extractorVersion: 'fixture/1', sourceHash: '0'.repeat(64),
      blocks: [{ id: 'b1', type: 'paragraph', inline: [{ text: 'Public fixture article.' }] }], assets: [], quality: { status: 'needs-review', reasons: ['unknown-article-scope'] } }
    snapshot.sourceHash = hashSnapshot(snapshot)
    return { snapshot, assets: [] }
  },
  async dispose() {},
} })
const dispose = service.dispose.bind(service)
service.dispose = async () => { await dispose(); await writeFile(join(dataDir, 'disposed'), 'closed\n', 'utf8') }
await start({ dataDir }, { service })
