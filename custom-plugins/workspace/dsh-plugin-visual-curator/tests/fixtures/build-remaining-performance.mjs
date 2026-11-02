/** Build synthetic native component diagnostics without reading a user profile or changing Host assets. */
import { build } from 'esbuild'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = fileURLToPath(new URL('../../../../../', import.meta.url)), output = resolve(root, '.playwright-mcp/remaining-performance')
const require = createRequire(resolve(root, 'packages/client/ui-primitives/package.json'))
await mkdir(output, { recursive: true })
await build({ absWorkingDir: root, entryPoints: ['custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/remaining-performance-ui.mjs'], outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'es2022', alias: { react: dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client'), 'react-dom': dirname(require.resolve('react-dom')) }, loader: { '.module.css': 'local-css', '.webp': 'dataurl', '.png': 'dataurl', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, plugins: [{ name: 'plugin-css-text', setup(api) { api.onLoad({ filter: /visual-curator[\\/]src[\\/]client[\\/]entry\.css$/ }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' })) } }] })
await writeFile(resolve(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Visual Curator list performance</title><link rel="icon" href="data:,"><link rel="stylesheet" href="remaining-performance-ui.css"><style>html,body,#app{height:100%;margin:0}body{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:system-ui}</style><body data-ds-dark-theme><div id="app"></div><script src="remaining-performance-ui.js"></script></body></html>\n', 'utf8')
console.log(`Native synthetic performance fixture built: ${output}/index.html`)
