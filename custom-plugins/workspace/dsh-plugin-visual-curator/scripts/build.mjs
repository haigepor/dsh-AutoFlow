import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = process.argv[2] === '--outdir' && process.argv[3] ? resolve(process.argv[3]) : root
const pickerRoot = new URL('../../../../packages/host/directory-picker-native/src/', import.meta.url)
const commandRoot = new URL('../../../../packages/util/native-command/src/', import.meta.url)
await build({ absWorkingDir: root, entryPoints: { index: 'src/host/plugin.ts', tools: 'src/host/tools.ts', skill: 'src/host/skill.ts', page: 'src/host/page.ts', 'clarity-worker': 'src/media/clarity-worker.ts' }, outdir: output, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22.19', sourcemap: false,
  plugins: [{ name: 'packaged-native-picker', setup(builder) {
    // Published 0.2.2-alpha.2 omits the image/reference exports used by this plugin.
    builder.onResolve({ filter: /^@deepseek-ai\/dsh-host-directory-picker-native$/ }, () => ({ path: fileURLToPath(new URL('native-picker.ts', pickerRoot)) }))
    builder.onResolve({ filter: /^@deepseek-ai\/dsh-native-command$/ }, () => ({ path: fileURLToPath(new URL('index.ts', commandRoot)) }))
  } }],
})
await build({ absWorkingDir: root, entryPoints: [fileURLToPath(new URL('win32-dialog-worker.ts', pickerRoot))], outfile: resolve(output, 'worker.cjs'), bundle: true, packages: 'external', platform: 'node', format: 'cjs', target: 'node22.19', sourcemap: false })
const client = await build({ absWorkingDir: root, entryPoints: ['src/client/index.ts'], outfile: 'client.js', bundle: true, write: false, format: 'cjs', external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'], platform: 'browser', loader: { '.css': 'text', '.webp': 'dataurl', '.png': 'dataurl' }, target: 'es2022', minify: true, legalComments: 'none' })
await writeFile(resolve(output, 'client.js'), `window.__ModuleLoader__.load({id:'dsh-plugin-visual-curator',factory(require){const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`, 'utf8')
