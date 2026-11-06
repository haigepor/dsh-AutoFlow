/** Build the Host service, optional native-tool row and conversation image UI. */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const output = process.argv[2] === '--outdir' && process.argv[3] ? resolve(process.argv[3]) : root
await build({ absWorkingDir: root, entryPoints: { index: 'src/host/plugin.ts', tools: 'src/host/tools.ts' }, outdir: output, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22.19', sourcemap: false })
await build({ absWorkingDir: root, entryPoints: ['src/client/index.ts'], outfile: resolve(output, 'client.js'), bundle: true, format: 'iife', platform: 'browser', loader: { '.css': 'text' }, target: 'es2022', minify: true, legalComments: 'none' })
