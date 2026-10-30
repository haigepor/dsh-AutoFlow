/** Bundle project-owned components and tokens for isolated browser acceptance. */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = fileURLToPath(new URL('../../../../../', import.meta.url)), output = resolve(root, '.playwright-mcp/incremental-references')
const require = createRequire(resolve(root, 'packages/client/ui-primitives/package.json'))
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'analysis-diagnostics-ui.expected.json'), await readFile(new URL('./analysis-diagnostics-ui.expected.json', import.meta.url)))
execFileSync(process.execPath, ['--import', 'tsx/esm', resolve(root, 'custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/prepare-search-feedback-data.ts'), output], { cwd: root, stdio: 'inherit' })
await build({ absWorkingDir: root, entryPoints: ['custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/incremental-references-ui.mjs'], outdir: output, bundle: true, platform: 'browser', jsx: 'automatic', format: 'iife', target: 'es2022', alias: { react: dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client'), 'react-dom': dirname(require.resolve('react-dom')) }, loader: { '.module.css': 'local-css', '.webp': 'dataurl', '.png': 'dataurl', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, plugins: [{ name: 'plugin-css-text', setup(api) { api.onLoad({ filter: /visual-curator[\\/]src[\\/]client[\\/]entry\.css$/ }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' })) } }] })
await writeFile(resolve(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>引用增量分析验收</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/incremental-references-ui.css"><body data-ds-dark-theme><div id="root"></div><script src="/data.js"></script><script src="/incremental-references-ui.js"></script>', 'utf8')
console.log(output)
