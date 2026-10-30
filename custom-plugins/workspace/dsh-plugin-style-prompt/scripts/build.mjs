/** Build independent Host and Client entries using the application's React runtime. */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
await build({ absWorkingDir: root, entryPoints: ['src/host/plugin.ts'], outfile: 'index.js', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22.19' })
await build({ absWorkingDir: root, entryPoints: ['src/client/index.ts'], outfile: 'client.js', bundle: true, format: 'iife', platform: 'browser', loader: { '.css': 'text', '.webp': 'dataurl' }, target: 'es2022', minify: true, legalComments: 'none' })
