/** Browser authority checks for isolated route fixtures without a live Host connection. */
import { isTrustedApiRequest } from '../src/trust-fence.ts'
import type { SidebarConnection } from '../src/context-types.ts'

/**
 * Build the Connection face used by route-only tests.
 * @param hosts - live authority list owned by the fixture.
 * @returns the shared admission method, rejecting untrusted requests.
 */
export function testConnection(hosts: () => readonly string[] = () => []): SidebarConnection {
  return { requestRejection: request => isTrustedApiRequest(request, hosts()) ? undefined : 403 }
}
