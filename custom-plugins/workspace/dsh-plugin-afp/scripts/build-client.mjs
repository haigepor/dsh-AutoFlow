import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { CATEGORY_PROFILES, LANDSCAPE_LOCATION_EXCLUSIONS } from '../src/vendor/auto-afp-img/afp-photo-search.mjs'
import { buildSearchCatalog } from '../src/shared/afp-search-catalog.js'
const root = fileURLToPath(new URL('../', import.meta.url))
await writeFile(new URL('../src/client/afp-search-catalog.json', import.meta.url), JSON.stringify(buildSearchCatalog(CATEGORY_PROFILES, LANDSCAPE_LOCATION_EXCLUSIONS), null, 2) + '\n', 'utf8')
await build({ absWorkingDir: root, entryPoints: ['src/client/afp-client-entry.js'], outfile: 'client.js', bundle: true, minify: true, format: 'iife', platform: 'browser', loader: { '.css': 'text' }, target: 'es2022', legalComments: 'none' })
