/** Build an isolated transcript fixture with no application account or model connection. */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const baseline = process.argv.includes('--baseline')
const output = resolve(root, '.playwright-mcp/analysis-stream-stability', baseline ? 'baseline' : 'candidate')
const require = createRequire(resolve(root, 'packages/client/ui-primitives/package.json'))
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'analysis-stream-stability-ui.expected.json'), await readFile(new URL('./analysis-stream-stability-ui.expected.json', import.meta.url)))
await build({
  absWorkingDir: root,
  entryPoints: ['custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/analysis-stream-stability-ui.mjs'],
  outdir: output, bundle: true, platform: 'browser', jsx: 'automatic', format: 'esm', target: 'es2022',
  alias: { react: dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client'), 'react-dom': dirname(require.resolve('react-dom')) },
  loader: { '.module.css': 'local-css', '.webp': 'dataurl', '.png': 'dataurl', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
  plugins: [{ name: 'fixture-source', setup(api) {
    api.onLoad({ filter: /visual-curator[\\/]src[\\/]client[\\/]entry\.css$/ }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }))
    if (baseline) api.onLoad({ filter: /visual-curator[\\/]src[\\/]client[\\/](?:analysis-dialog\.tsx|analysis-virtual-list\.ts|analysis-markdown\.ts|store\.ts)$/ }, args => ({ contents: execFileSync('git', ['show', `HEAD:${args.path.slice(root.length).replaceAll('\\', '/')}`], { cwd: root, encoding: 'utf8' }), loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: dirname(args.path) }))
  } }],
})
await writeFile(resolve(output, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="./analysis-stream-stability-ui.css"><body data-ds-dark-theme><div id="root"></div><script type="module" src="./analysis-stream-stability-ui.js"></script>', 'utf8')
console.log(output)
