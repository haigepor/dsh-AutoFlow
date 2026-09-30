import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
await build({ absWorkingDir: root, entryPoints: ['src/client/afp-client-entry.js'], outfile: 'client.js', bundle: true, format: 'iife', platform: 'browser', loader: { '.css': 'text' }, target: 'es2022', legalComments: 'none' })
