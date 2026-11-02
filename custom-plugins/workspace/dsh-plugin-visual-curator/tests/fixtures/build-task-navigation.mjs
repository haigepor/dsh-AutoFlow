/** Build the isolated navigation page beside the existing native card fixtures. */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = fileURLToPath(new URL('../../../../../', import.meta.url)), output = resolve(root, '.playwright-mcp/search-feedback-native-fixture')
const require = createRequire(resolve(root, 'packages/client/ui-primitives/package.json'))
await mkdir(output, { recursive: true })
try { await access(resolve(output, 'data.js')) } catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  execFileSync(process.execPath, ['--import', 'tsx/esm', resolve(root, 'custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/prepare-search-feedback-data.ts'), output], { cwd: root, stdio: 'inherit' })
}
await build({ absWorkingDir: root, entryPoints: ['custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/task-navigation-ui.mjs'], outdir: output, bundle: true, platform: 'browser', jsx: 'automatic', format: 'esm', target: 'es2022',
  alias: { react: dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client'), 'react-dom': dirname(require.resolve('react-dom')) },
  loader: { '.module.css': 'local-css', '.webp': 'dataurl', '.png': 'dataurl', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
  plugins: [{ name: 'plugin-css-text', setup(api) { api.onLoad({ filter: /visual-curator[\\/]src[\\/]client[\\/]entry\.css$/ }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' })) } }],
})
await writeFile(resolve(output, 'task-navigation.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Task navigation acceptance</title><link rel="icon" href="data:,"><link rel="stylesheet" href="task-navigation-ui.css"><style>html,body,#root{height:100%;margin:0}body{font-family:system-ui;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}#root{display:flex;flex-direction:column;overflow:hidden}.fixture-toolbar{height:36px;flex:none}.vc-page-frame{flex:1;min-height:0}</style><body data-ds-dark-theme><div id="root"></div><script src="data.js"></script><script type="module" src="task-navigation-ui.js"></script></body></html>\n', 'utf8')
console.log('Navigation fixture built: .playwright-mcp/search-feedback-native-fixture/task-navigation.html')
