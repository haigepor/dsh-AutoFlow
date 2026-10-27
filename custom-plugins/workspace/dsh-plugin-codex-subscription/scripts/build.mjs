/** Bundle the Host service and optional native-tool row. */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
await build({ absWorkingDir: root, entryPoints: { index: 'src/host/plugin.ts', tools: 'src/host/tools.ts' }, outdir: '.', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22.19', sourcemap: false })
