/** Bundle the package Client with the Host's shared React and primitives. */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['src/client/entry.js'], outfile: 'client.js',
  bundle: true, minify: true, format: 'iife', platform: 'browser', loader: { '.css': 'text', '.png': 'dataurl', '.webp': 'dataurl' }, target: 'es2022', legalComments: 'none' })
