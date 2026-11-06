import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CATEGORY_PROFILES, LANDSCAPE_LOCATION_EXCLUSIONS } from '../src/vendor/auto-afp-img/afp-photo-search.mjs'
import { buildSearchCatalog } from '../src/shared/afp-search-catalog.js'
const root = fileURLToPath(new URL('../', import.meta.url))
const isolated = process.argv[2] === '--outdir' && process.argv[3]
const output = isolated ? resolve(process.argv[3]) : root
const catalog = JSON.stringify(buildSearchCatalog(CATEGORY_PROFILES, LANDSCAPE_LOCATION_EXCLUSIONS), null, 2) + '\n'
if (isolated) await mkdir(resolve(output, 'src/client'), { recursive: true })
await writeFile(isolated ? resolve(output, 'src/client/afp-search-catalog.json') : new URL('../src/client/afp-search-catalog.json', import.meta.url), catalog, 'utf8')
await build({ absWorkingDir: root, entryPoints: ['src/client/afp-client-entry.js'], outfile: resolve(output, 'client.js'), bundle: true, minify: true, format: 'iife', platform: 'browser', loader: { '.css': 'text', '.webp': 'dataurl' }, target: 'es2022', legalComments: 'none',
  plugins: isolated ? [{ name: 'staged-search-catalog', setup(builder) { builder.onLoad({ filter: /[\\/]afp-search-catalog\.json$/ }, () => ({ contents: catalog, loader: 'json' })) } }] : [],
})
