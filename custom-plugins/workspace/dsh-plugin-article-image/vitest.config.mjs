import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import runtimeConfig from './tests/analysis-runtime.config.mjs'

export default mergeConfig(runtimeConfig, defineConfig({
  resolve: { alias: { '@deepseek-ai/dsh-atomic-write': fileURLToPath(new URL('../../../packages/util/atomic-write/src/index.ts', import.meta.url)) } },
  test: { include: ['tests/*.test.js'], testTimeout: 30000 },
}))
