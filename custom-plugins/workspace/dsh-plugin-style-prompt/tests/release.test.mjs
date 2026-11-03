/** Release metadata and packed entries use Style Prompt's own source. */
import { testReleaseAdapter } from '../../../release-governance/test-release-adapter.mjs'
testReleaseAdapter(new URL('../', import.meta.url), 'dsh-plugin-style-prompt')
