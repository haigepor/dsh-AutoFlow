import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../../vitest.shared.ts'

export default defineConfig({
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: [fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url))], loose: true })],
  test: { include: ['tests/analysis*.test.js', 'tests/rules*.test.js'], pool: 'forks', execArgv: vitestExecArgv, testTimeout: 30000, hookTimeout: 30000 },
})
