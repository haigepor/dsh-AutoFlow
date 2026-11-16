import { defineConfig } from 'tsdown'

export default defineConfig(async ({ env }) => {
  if (env?.DSH_BUILD_FACE === 'client') return []
  // Host lowering loads after Typert emits; Client source checks need no built artifacts.
  const { decoratorPlugin } = await import('../../typert/generator/lib/types/tsdown-plugin.js')
  return {
    entry: ['lib/types/index.js', 'lib/types/settings.js'],
    outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
    plugins: [decoratorPlugin()],
  }
})
