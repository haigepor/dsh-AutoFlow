import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@deepseek-ai/dsh-atomic-write': fileURLToPath(new URL('../../../packages/util/atomic-write/src/index.ts', import.meta.url)) } },
  test: { include: ['tests/*.test.js'], testTimeout: 15000 },
})
