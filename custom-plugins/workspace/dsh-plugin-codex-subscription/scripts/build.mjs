/** Build the Host service, optional native-tool row and conversation image UI. */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
await build({ absWorkingDir: root, entryPoints: { index: 'src/host/plugin.ts', tools: 'src/host/tools.ts' }, outdir: '.', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22.19', sourcemap: false })
await build({ absWorkingDir: root, entryPoints: ['src/client/index.ts'], outfile: 'client.js', bundle: true, format: 'iife', platform: 'browser', loader: { '.css': 'text' }, target: 'es2022', minify: true, legalComments: 'none' })
