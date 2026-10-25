/** @jsxRuntime classic */
/** @jsx React.createElement */
/** Current-color visual-analysis glyphs; labels remain owned by the surrounding text. */
const paths = {
  image: 'M2.5 2.5h11v11h-11z M2.5 11l3.5-4 3 3 2-2 2.5 3 M10.5 5h.01',
  color: 'M8 2a6 6 0 1 0 0 12h1a1.5 1.5 0 0 0 1-2.6.8.8 0 0 1 .5-1.4H12a2 2 0 0 0 2-2c0-3.3-2.7-6-6-6Z M5 5.5h.01 M8 4.5h.01 M11 6h.01 M4.5 8.5h.01',
  lighting: 'M8 1v1.5 M8 13.5V15 M1 8h1.5 M13.5 8H15 M3 3l1 1 M12 12l1 1 M3 13l1-1 M12 4l1-1 M11.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0',
  texture: 'M3 2.5v11 M6.5 2.5v11 M10 2.5v11 M13 2.5v11 M2.5 4h11 M2.5 8h11 M2.5 12h11',
  subject: 'M3 5V3h2 M11 3h2v2 M13 11v2h-2 M5 13H3v-2 M10 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M5 11c.5-2 5.5-2 6 0',
  composition: 'M2.5 2.5h11v11h-11z M6 2.5v11 M6 8h7.5',
  density: 'M3 3h1v1H3z M7.5 3h1v1h-1z M12 3h1v1h-1z M3 7.5h1v1H3z M7.5 7.5h1v1h-1z M12 7.5h1v1h-1z M3 12h1v1H3z M7.5 12h1v1h-1z M12 12h1v1h-1z',
  depth: 'M8 2l6 3-6 3-6-3z M2 8l6 3 6-3 M2 11l6 3 6-3',
} as const

/** @param React Host React runtime. @returns Decorative SVG component for visual dimensions and image placeholders. */
export function createAnalysisIcon(React: typeof import('react')) {
  return function AnalysisIcon({ kind, size = 16 }: { kind: string; size?: number }) {
    const key = Object.keys(paths).find((value): value is keyof typeof paths => value === kind) ?? 'image'
    return <svg className="vc-analysis-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[key]} /></svg>
  }
}
