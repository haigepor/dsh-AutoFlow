import { defineConfig } from 'tsdown'
import { decoratorPlugin } from '../../typert/generator/lib/types/tsdown-plugin.js'

export default defineConfig(({ env }) => ({
  entry: env?.DSH_BUILD_FACE === 'client' ? '' : ['lib/types/index.js', 'lib/types/settings.js'],
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
  plugins: [decoratorPlugin()],
}))
