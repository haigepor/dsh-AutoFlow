import { isIP } from 'node:net';

/** Reject local, private and non-unicast literal addresses for preview and delivery reads.
 * @param {string} hostname Parsed URL hostname; DNS names remain subject to each caller's allowlist.
 * @returns {boolean} Whether the hostname must be rejected before requesting media.
 */
export function isBlockedMediaHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
  }
  return isIP(host) === 6 && (host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd')
    || /^fe[89ab]/.test(host) || host.startsWith('ff') || host.startsWith('::ffff:'));
}
