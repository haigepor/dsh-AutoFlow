import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['src/client/demo-client-entry.js'], outfile: 'client.js', bundle: true, format: 'iife', platform: 'browser', target: 'es2022', legalComments: 'none' })
