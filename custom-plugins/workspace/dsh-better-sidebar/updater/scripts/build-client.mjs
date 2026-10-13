import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'

/** Compile the local presentation and updater into the same independently installed client artifact. */
export async function buildClient() {
  const result = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['src/client/index.js'], outfile: 'client.js',
    // 独立插件共享 document，保留 CSS Modules 的文件名前缀，避免短类名与其他插件碰撞。
    bundle: true, write: false, minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, format: 'cjs', platform: 'browser', target: 'es2022', legalComments: 'none',
    external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' } })
  const script = result.outputFiles.find(file => file.path.endsWith('.js')).text
  const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? ''
  return `window.__ModuleLoader__.load({id:'dsh-plugin-better-sidebar-updater',factory(require){const module={exports:{}};const exports=module.exports;\n${script}\nconst plugin=module.exports;return {...plugin,apply(ctx){ctx.effect(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);return()=>style.remove()},'Sidebar local settings styles');return plugin.apply(ctx)}}}});\n`
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await writeFile(new URL('../client.js', import.meta.url), await buildClient(), 'utf8')
