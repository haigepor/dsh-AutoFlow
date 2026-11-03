/** Release metadata and packed entries use the startup animation's own source. */
import { testReleaseAdapter } from '../../../release-governance/test-release-adapter.mjs'
testReleaseAdapter(new URL('../', import.meta.url), 'dsh-boot-animation')
