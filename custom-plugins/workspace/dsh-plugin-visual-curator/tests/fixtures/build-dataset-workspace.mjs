/** Build a static native-component fixture beside a prepared, read-only data.js. */
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = fileURLToPath(new URL('../../../../../', import.meta.url)), output = resolve(root, '.playwright-mcp/dataset-native-fixture')
const require = createRequire(resolve(root, 'packages/client/ui-primitives/package.json'))
await mkdir(output, { recursive: true })
await build({ absWorkingDir: root, entryPoints: ['custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/dataset-workspace-ui.mjs'], outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'es2022', alias: { react: dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client'), 'react-dom': dirname(require.resolve('react-dom')) }, loader: { '.module.css': 'local-css', '.webp': 'dataurl', '.png': 'dataurl' }, plugins: [{ name: 'plugin-css-text', setup(api) { api.onLoad({ filter: /visual-curator[\\/]src[\\/]client[\\/]entry\.css$/ }, async args => ({ contents: await (await import('node:fs/promises')).readFile(args.path, 'utf8'), loader: 'text' })) } }] })
await writeFile(resolve(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>数据集原生组件验收</title><link rel="stylesheet" href="dataset-workspace-ui.css"><style>html,body,#root{height:100%;margin:0}body{font-family:system-ui;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.vc-workbench{height:100%;box-sizing:border-box;padding:24px}</style><body data-ds-dark-theme><div id="root"></div><script src="data.js"></script><script src="dataset-workspace-ui.js"></script></body></html>\n', 'utf8')
console.log('Native dataset fixture built: .playwright-mcp/dataset-native-fixture/index.html')
