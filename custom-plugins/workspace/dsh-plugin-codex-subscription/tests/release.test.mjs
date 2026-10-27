/** Release protocol coverage belongs to this Host-only plugin. */
import { testReleaseAdapter } from '../../../release-governance/test-release-adapter.mjs'
testReleaseAdapter(new URL('../', import.meta.url), 'dsh-plugin-codex-subscription')
