import { clientBundle } from '../tsdown.client.ts'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundle = clientBundle('@deepseek-ai/dsh-client-ui-agent-preset', ['lib/types/index.js'])

export default ((options) => bundle(options).map(config => ({
  ...config,
  plugins: [...(config.plugins ?? []), {
    name: 'agent-preset-illustration-assets',
    resolveId(source: string) {
      if (!/^\.\/assets\/[^/]+\.webp$/.test(source)) return null
      return fileURLToPath(new URL(`./src/client/assets/${basename(source)}`, import.meta.url))
    },
    async load(id: string) {
      if (!/\/ui-agent-preset\/src\/client\/assets\/[^/]+\.webp$/.test(id.replaceAll('\\', '/'))) return null
      this.addWatchFile(id)
      const data = await readFile(id)
      return `export default ${JSON.stringify(`data:image/webp;base64,${data.toString('base64')}`)}`
    },
  }],
}))) satisfies typeof bundle
