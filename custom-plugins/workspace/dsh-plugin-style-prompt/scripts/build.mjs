/** Build independent Host and Client entries using the application's React runtime. */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'

const root = fileURLToPath(new URL('../', import.meta.url))
await build({ absWorkingDir: root, entryPoints: ['src/host/plugin.ts'], outfile: 'index.js', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22.19' })
const client = await build({ absWorkingDir: root, entryPoints: ['src/client/index.ts'], outfile: 'client.js', bundle: true, write: false, format: 'cjs', external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'], platform: 'browser', loader: { '.css': 'text', '.webp': 'dataurl' }, target: 'es2022', minify: true, legalComments: 'none' })
await writeFile(new URL('../client.js', import.meta.url), `window.__ModuleLoader__.load({id:'dsh-plugin-style-prompt',factory(require){const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`, 'utf8')
