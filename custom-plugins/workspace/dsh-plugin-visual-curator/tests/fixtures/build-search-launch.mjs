/** Build an isolated native-component fixture with keyless production Host projections. */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = fileURLToPath(new URL('../../../../../', import.meta.url)), output = resolve(root, '.playwright-mcp/search-launch-native-fixture')
const require = createRequire(resolve(root, 'packages/client/ui-primitives/package.json'))
await mkdir(output, { recursive: true })
await copyFile(resolve(root, 'custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/search-launch-ui.expected.json'), resolve(output, 'search-launch-ui.expected.json'))
execFileSync(process.execPath, ['--import', 'tsx/esm', resolve(root, 'custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/prepare-search-launch-data.ts'), resolve(output, 'data.js')], { cwd: root, stdio: 'pipe' })
await build({ absWorkingDir: root, entryPoints: ['custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/search-launch-ui.mjs'], outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'es2022', alias: { react: dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client'), 'react-dom': dirname(require.resolve('react-dom')) }, loader: { '.module.css': 'local-css', '.webp': 'dataurl', '.png': 'dataurl' }, plugins: [{ name: 'plugin-css-text', setup(api) { api.onLoad({ filter: /visual-curator[\\/]src[\\/]client[\\/]entry\.css$/ }, async args => ({ contents: await (await import('node:fs/promises')).readFile(args.path, 'utf8'), loader: 'text' })) } }] })
await writeFile(resolve(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>找图启动原生组件验收</title><link rel="stylesheet" href="search-launch-ui.css"><style>html,body,#root{height:100%;margin:0}body{font-family:system-ui;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.vc-workbench{height:100%;box-sizing:border-box;padding:24px}</style><body data-ds-dark-theme><div id="root"></div><script src="data.js"></script><script src="search-launch-ui.js"></script></body></html>\n', 'utf8')
console.log('Native launch fixture built: .playwright-mcp/search-launch-native-fixture/index.html')
