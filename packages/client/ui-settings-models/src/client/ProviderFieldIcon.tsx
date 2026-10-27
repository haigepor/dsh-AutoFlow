/** Compact, currentColor field marks for provider identity and connection inputs. */
import type { ReactNode } from 'react'

/**
 * Render the field's purpose without adding another interactive control.
 * @param props - provider name, endpoint or credential mark.
 * @returns a decorative 16px SVG using the surrounding label color.
 */
export function ProviderFieldIcon({ kind }: { kind: 'name' | 'endpoint' | 'key' }): ReactNode {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'name' ? <><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M5 6h6M5 9h4" /></>
      : kind === 'endpoint' ? <><path d="m6.5 5.5 2-2a2.83 2.83 0 0 1 4 4l-2 2M9.5 10.5l-2 2a2.83 2.83 0 0 1-4-4l2-2M6 10l4-4" /></>
        : <><circle cx="5.25" cy="5.5" r="3" /><path d="m7.4 7.65 5.85 5.85M10 10.25l1.5-1.5M11.75 12l1.5-1.5" /></>}
  </svg>
}
