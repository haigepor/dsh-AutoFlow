/** Build the local long-transcript measurement without real account or model data. */
import { build } from 'esbuild'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
const root = fileURLToPath(new URL('../../../../../', import.meta.url)), baseline = process.argv.includes('--baseline'), output = resolve(root, '.playwright-mcp/analysis-long-list', baseline ? 'baseline' : '.')
const require = createRequire(resolve(root, 'packages/client/ui-primitives/package.json'))
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'analysis-long-list-ui.expected.json'), await readFile(new URL('./analysis-long-list-ui.expected.json', import.meta.url)))
await build({ absWorkingDir: root, entryPoints: ['custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/analysis-long-list-ui.mjs'], outdir: output, bundle: true, platform: 'browser', jsx: 'automatic', format: 'iife', target: 'es2022', alias: { react: dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client'), 'react-dom': dirname(require.resolve('react-dom')) }, loader: { '.module.css': 'local-css', '.webp': 'dataurl', '.png': 'dataurl', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, plugins: [{ name: 'plugin-css-text', setup(api) { api.onLoad({ filter: /visual-curator[\\/]src[\\/]client[\\/]entry\.css$/ }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' })); if (baseline) api.onLoad({ filter: /visual-curator[\\/]src[\\/]client[\\/]analysis-dialog\.tsx$/ }, args => ({ contents: execFileSync('git', ['show', 'HEAD:custom-plugins/workspace/dsh-plugin-visual-curator/src/client/analysis-dialog.tsx'], { cwd: root, encoding: 'utf8' }), loader: 'tsx', resolveDir: dirname(args.path) })) } }] })
await writeFile(resolve(output, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="./analysis-long-list-ui.css"><body data-ds-dark-theme><div id="root"></div><script src="./analysis-long-list-ui.js"></script>', 'utf8')
console.log(output)
