/** Axis-aligned crop in normalized, orientation-corrected source coordinates. */
export interface CropRect { x: number; y: number; width: number; height: number }

/** Check a positive selection against the source bounds.
 * @param rect Normalized selection.
 * @returns Whether the Host can accept its coordinates.
 */
export function validCropRect(rect: CropRect): boolean {
  return Object.values(rect).every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0
    && rect.x + rect.width <= 1 && rect.y + rect.height <= 1
}

/** Fit a selection to the physical output ratio without enlarging beyond the source.
 * @param rect Current selection or numeric field edit.
 * @param sourceWidth Orientation-corrected source width.
 * @param sourceHeight Orientation-corrected source height.
 * @param aspect Physical output width divided by height; absent for free selection.
 * @param anchor Edited dimension, or fit to preserve the current selection center.
 * @returns A bounded selection; nonpositive numeric edits remain invalid until corrected.
 */
export function fitCropRect(rect: CropRect, sourceWidth: number, sourceHeight: number, aspect?: number, anchor: 'width' | 'height' | 'fit' = 'fit'): CropRect {
  if (!Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return rect
  let { width, height } = rect
  if (aspect) {
    const normalizedRatio = aspect * sourceHeight / sourceWidth
    if (anchor === 'height') width = height * normalizedRatio
    else if (anchor === 'width') height = width / normalizedRatio
    else { width = Math.min(width, height * normalizedRatio); height = width / normalizedRatio }
  }
  const scale = Math.min(1, 1 / width, 1 / height)
  width *= scale; height *= scale
  const x = rect.x + (anchor === 'fit' ? (rect.width - width) / 2 : 0)
  const y = rect.y + (anchor === 'fit' ? (rect.height - height) / 2 : 0)
  return { x: Math.max(0, Math.min(x, 1 - width)), y: Math.max(0, Math.min(y, 1 - height)), width, height }
}
