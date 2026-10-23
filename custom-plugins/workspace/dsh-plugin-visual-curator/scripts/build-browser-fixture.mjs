/** Build the test overlay; only dsh profiles launch an application. */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['tests/fixtures/browser-plugin.ts'], outfile: 'tests/fixtures/browser-plugin.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22.19' })
