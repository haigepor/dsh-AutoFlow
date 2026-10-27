/** Release protocol coverage includes all Visual Curator runtime faces. */
import { testReleaseAdapter } from '../../../release-governance/test-release-adapter.mjs'
testReleaseAdapter(new URL('../', import.meta.url), 'dsh-plugin-visual-curator')
