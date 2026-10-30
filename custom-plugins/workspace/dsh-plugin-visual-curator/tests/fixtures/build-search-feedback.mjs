/** Build production components in a keyless, local browser acceptance page. */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = fileURLToPath(new URL('../../../../../', import.meta.url)), output = resolve(root, '.playwright-mcp/search-feedback-native-fixture')
const require = createRequire(resolve(root, 'packages/client/ui-primitives/package.json'))
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'analysis-performance-ui.expected.json'), await readFile(resolve(root, 'custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/analysis-performance-ui.expected.json'), 'utf8'), 'utf8')
await writeFile(resolve(output, 'batch-loading-ui.expected.json'), await readFile(resolve(root, 'custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/batch-loading-ui.expected.json'), 'utf8'), 'utf8')
await writeFile(resolve(output, 'search-feedback-ui.expected.json'), await readFile(resolve(root, 'custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/search-feedback-ui.expected.json'), 'utf8'), 'utf8')
await writeFile(resolve(output, 'preview-search-ui.expected.json'), await readFile(resolve(root, 'custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/preview-search-ui.expected.json'), 'utf8'), 'utf8')
execFileSync(process.execPath, ['--import', 'tsx/esm', resolve(root, 'custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/prepare-search-feedback-data.ts'), output], { cwd: root, stdio: 'inherit' })
await build({ absWorkingDir: root, entryPoints: ['custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/search-feedback-ui.mjs'], outdir: output, bundle: true, platform: 'browser', jsx: 'automatic', format: 'iife', target: 'es2022', alias: { react: dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client'), 'react-dom': dirname(require.resolve('react-dom')) }, loader: { '.module.css': 'local-css', '.webp': 'dataurl', '.png': 'dataurl', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, plugins: [{ name: 'plugin-css-text', setup(api) { api.onLoad({ filter: /visual-curator[\\/]src[\\/]client[\\/]entry\.css$/ }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' })) } }] })
await writeFile(resolve(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Visual Curator 反馈验收</title><link rel="icon" href="data:,"><link rel="stylesheet" href="search-feedback-ui.css"><style>html,body,#root{height:100%;margin:0}body{font-family:system-ui;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}#root{display:flex;flex-direction:column;overflow:hidden}.fixture-toolbar{height:32px;flex:none}.fixture-conversation{width:100%;flex:1;min-height:0}.fixture-chat{width:var(--dsh-chat-content-width);max-width:calc(100% - 32px);margin:40px auto}.fixture-composer{height:100px;margin:20px 16px;background:var(--dsw-specific-menu);border-radius:16px;padding:16px}</style><body data-ds-dark-theme><div id="root"></div><script src="data.js"></script><script src="search-feedback-ui.js"></script></body></html>\n', 'utf8')
console.log('Feedback fixture built: .playwright-mcp/search-feedback-native-fixture/index.html')
