/** Build native Client previews without a model, user profile or external media. */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = fileURLToPath(new URL('../../../../../', import.meta.url)), output = resolve(root, '.playwright-mcp/reference-preview-queue')
const require = createRequire(resolve(root, 'packages/client/ui-primitives/package.json'))
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'metadata.json'), '{"ready":true}\n', 'utf8')
await writeFile(resolve(output, 'expected.json'), await readFile(new URL('./reference-preview-queue.expected.json', import.meta.url)))
await build({ absWorkingDir: root, entryPoints: ['custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/reference-preview-queue-ui.mjs'], outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'es2022', alias: { '@deepseek-ai/dsh-client-ui-primitives': resolve(root, 'packages/client/ui-primitives/src/index.ts'), react: dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client'), 'react-dom': dirname(require.resolve('react-dom')) }, loader: { '.module.css': 'local-css', '.webp': 'dataurl', '.png': 'dataurl', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, plugins: [{ name: 'plugin-css-text', setup(api) { api.onLoad({ filter: /visual-curator[\\/]src[\\/]client[\\/]entry\.css$/ }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' })) } }] })
await writeFile(resolve(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>预览连接与窗口验收</title><link rel="icon" href="data:,"><link rel="stylesheet" href="reference-preview-queue-ui.css"><style>body{margin:20px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:system-ui}header{display:flex;gap:12px;margin-bottom:20px}.fixture-grid{display:grid;grid-template-columns:repeat(4,160px);grid-auto-rows:100px;gap:12px;overflow:auto;height:220px;width:700px;align-content:start}.fixture-grid .vc-reference-preview{height:100px;aspect-ratio:auto}</style><body data-ds-dark-theme><div id="root"></div><script src="reference-preview-queue-ui.js"></script></body></html>\n', 'utf8')
console.log(`Built ${output}/index.html`)
