/** Deterministic layout protects source subjects and keeps diagnostic and lock-screen layers separate. */
import sharp from 'sharp'
import { wallpaperClockSvg } from './wallpaper-clock.ts'
import type { WallpaperFramingObservation, WallpaperPlan, WallpaperSettings, WallpaperCompositionMode } from '../shared/wallpaper.ts'
import { wallpaperProcessingSchema } from '../shared/wallpaper-policy.ts'
import { CuratorError } from '../shared/errors.ts'
import type { PixelRect } from '../shared/model.ts'
import { wallpaperGeometry, type WallpaperSourceLayout } from '../shared/wallpaper-geometry.ts'

export { wallpaperGeometry } from '../shared/wallpaper-geometry.ts'

/** Mark source-only boxes and real frame contacts without suggesting a feasible target placement.
 * @param bytes Original source pixels; never a generated candidate.
 * @param size Oriented source dimensions.
 * @param observation Saved source coordinates, including a partial subject's meaningful focus.
 * @returns Separate annotated PNG; the original remains unchanged.
 */
export async function wallpaperFramingAnnotation(bytes: Uint8Array, size: { width: number; height: number }, observation: WallpaperFramingObservation) {
  const { width, height } = size
  const marks = observation.objectRoles.filter(object => object.role !== 'supporting').map((object, index) => {
    const box = object.rect, focus = object.sourceIntent.layoutFocus
    const rectangle = (rect: typeof box, color: string, dashed = false) => {
      const geometry = `x="${rect.x * width}" y="${rect.y * height}" width="${rect.width * width}" height="${rect.height * height}" fill="none"${dashed ? ' stroke-dasharray="14 10"' : ''}`
      return `<rect ${geometry} stroke="#000" stroke-opacity=".65" stroke-width="10"/><rect ${geometry} stroke="${color}" stroke-width="6"/>`
    }
    const edges = object.sourceEdges.map(edge => edge === 'left' || edge === 'right' ? `M${edge === 'left' ? 3 : width - 3} ${box.y * height}V${(box.y + box.height) * height}` : `M${box.x * width} ${edge === 'top' ? 3 : height - 3}H${(box.x + box.width) * width}`).join('')
    return rectangle(box, '#92d5ff') + (focus ? rectangle(focus, '#ffb84d', true) : '') + `<path d="${edges}" fill="none" stroke="#000" stroke-opacity=".65" stroke-width="13"/><path d="${edges}" fill="none" stroke="#f44848" stroke-width="9"/><text x="${box.x * width + 8}" y="${box.y * height + 30}" font-size="30" fill="white" stroke="#000" stroke-width="3" paint-order="stroke">${index + 1}</text>`
  }).join('')
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${marks}</svg>`)
  return sharp(bytes).composite([{ input: svg }]).png().toBuffer()
}

/** Convert one complete provider canvas to the target PNG without adding pixels from another image.
 * @param bytes Complete generated image, optionally reconstructed before this call.
 * @param settings Frozen target dimensions.
 * @param placementCrop Optional viewport of that same image in target-canvas pixel coordinates.
 * @returns The rendered canvas and its measured input size.
 */
export async function renderCompleteWallpaper(bytes: Uint8Array, settings: Pick<WallpaperSettings, 'width' | 'height'>, placementCrop?: PixelRect) {
  const generated = await sharp(bytes).metadata()
  if (!generated.width || !generated.height || Math.abs(generated.width - generated.height * settings.width / settings.height) > 1) throw new CuratorError('constraint-conflict', 'wallpaper-background', 'The complete provider canvas has a different aspect ratio from the wallpaper.')
  const canvas = sharp(bytes)
  if (placementCrop) {
    const x = generated.width / settings.width, y = generated.height / settings.height
    const left = Math.round(placementCrop.x * x), top = Math.round(placementCrop.y * y)
    canvas.extract({ left, top, width: Math.round((placementCrop.x + placementCrop.width) * x) - left,
      height: Math.round((placementCrop.y + placementCrop.height) * y) - top })
  }
  return { image: await canvas.resize(settings.width, settings.height, { fit: 'fill' }).toColourspace('srgb').png().toBuffer(), generatedSize: { width: generated.width, height: generated.height } }
}

/** @param native Uncropped provider frame. @param delivered Delivery pixels. @returns Whether normalized, low-frequency pixels corroborate unchanged framing after resampling. */
export async function wallpaperSameFullFrame(native: Uint8Array, delivered: Uint8Array): Promise<boolean> {
  const sample = (bytes: Uint8Array) => sharp(bytes).resize(128, 128, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer()
  const [before, after] = await Promise.all([sample(native), sample(delivered)])
  let totalDifference = 0, changedSamples = 0
  for (const [index, value] of before.entries()) {
    const difference = Math.abs(value - after[index]!)
    totalDifference += difference
    if (difference > 16) changedSamples++
  }
  // Interpolation can move the color at a sampled hard edge without moving the scene.
  return totalDifference <= before.length * 2 && changedSamples <= before.length / 100
}

/** Render a crop or diagnostic source placement, or deliver an entire generated canvas without restoring source pixels.
 * @param bytes Verified oriented original.
 * @param plan Inferred layout.
 * @param settings Frozen template.
 * @param background Optional complete generated canvas; omission leaves transparent uncovered pixels.
 * @param compositionMode Historical modes can prepare diagnostic placements except retired source-intent restoration; only generated-canvas-v1 permits generated output.
 * @returns Actual image, alpha mask and measured transform.
 */
export async function renderWallpaper(bytes: Uint8Array, plan: WallpaperPlan, settings: WallpaperSettings, background?: Uint8Array, compositionMode: WallpaperCompositionMode = 'generated-canvas-v1', sourceLayout?: WallpaperSourceLayout) {
  if (compositionMode === 'source-intent-background-v1' || background && compositionMode !== 'generated-canvas-v1') throw new CuratorError('constraint-conflict', 'wallpaper-render', 'Source and candidate pixel overlays are disabled. Use one complete provider canvas; saved historical files remain readable.')
  const metadata = await sharp(bytes).metadata()
  if (!metadata.width || !metadata.height) throw new CuratorError('invalid-input', 'wallpaper-render', 'Source dimensions are unavailable.')
  const geometry = wallpaperGeometry({ width: metadata.width, height: metadata.height }, plan, settings, sourceLayout)
  // Native-size crops retain decoded pixels; scaled placements resample once from the original.
  const placed = geometry.width === metadata.width && geometry.height === metadata.height ? sharp(bytes) : sharp(bytes).resize(geometry.width, geometry.height, { fit: 'fill', kernel: sharp.kernel.lanczos3, withoutEnlargement: sourceLayout?.version !== 'source-intent-v2' })
  const patch = await placed.extract({ left: geometry.target.left - geometry.left, top: geometry.target.top - geometry.top, width: geometry.target.width, height: geometry.target.height }).png().toBuffer()
  const canvas = { width: settings.width, height: settings.height, channels: 4 as const, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  const seed = await sharp({ create: canvas }).composite([{ input: patch, left: geometry.target.left, top: geometry.target.top }]).png().toBuffer()
  const mask = await sharp(seed).ensureAlpha().extractChannel('alpha').raw().toBuffer({ resolveWithObject: true })
  geometry.needsOutpaint ||= mask.data.some(alpha => alpha < 255)
  const raw = { width: settings.width, height: settings.height, channels: 1 as const }
  let protection = mask.data, blend = mask.data
  if (geometry.needsOutpaint && settings.backgroundTransitionPixels > 0) {
    const blurred = await sharp(mask.data, { raw }).blur(settings.backgroundTransitionPixels / 2).toColourspace('b-w').raw().toBuffer()
    protection = Buffer.alloc(mask.data.length); blend = Buffer.alloc(mask.data.length)
    for (let i = 0; i < blend.length; i++) {
      blend[i] = Math.min(mask.data[i]!, Math.max(0, 2 * blurred[i]! - 255))
      protection[i] = blend[i] === 255 ? 255 : 0
    }
    for (const region of geometry.regions) {
      const left = Math.max(0, Math.floor(region.left)), right = Math.min(settings.width, Math.ceil(region.left + region.width))
      const top = Math.max(0, Math.floor(region.top)), bottom = Math.min(settings.height, Math.ceil(region.top + region.height))
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const index = y * settings.width + x
        protection[index] = mask.data[index]!; blend[index] = mask.data[index]!
      }
    }
    for (let i = 0; i < blend.length; i++) { protection[i] = Math.min(protection[i]!, mask.data[i]!); blend[i] = Math.min(blend[i]!, mask.data[i]!) }
  }
  if ((geometry.needsOutpaint || compositionMode === 'protected-context-v2') && (compositionMode === 'protected-context-v1' || compositionMode === 'protected-context-v2')) {
    const regions = geometry.regions.map(region => ({ left: Math.max(0, Math.floor(region.left)), right: Math.min(settings.width, Math.ceil(region.left + region.width)), top: Math.max(0, Math.floor(region.top)), bottom: Math.min(settings.height, Math.ceil(region.top + region.height)) }))
    const protectedPixels = Buffer.alloc(mask.data.length)
    for (const region of regions) for (let y = region.top; y < region.bottom; y++) protectedPixels.fill(255, y * settings.width + region.left, y * settings.width + region.right)
    blend = Buffer.from(blend)
    for (let y = 0; y < settings.height; y++) for (let x = 0; x < settings.width; x++) {
      const index = y * settings.width + x
      if (!mask.data[index]) continue
      if (protectedPixels[index]) { blend[index] = mask.data[index]!; continue }
      let distanceSquared = Infinity
      for (const region of regions) { const dx = Math.max(region.left - x, 0, x - (region.right - 1)), dy = Math.max(region.top - y, 0, y - (region.bottom - 1)); distanceSquared = Math.min(distanceSquared, dx * dx + dy * dy) }
      const distance = Math.sqrt(distanceSquared), context = settings.backgroundContextPixels, feather = settings.backgroundTransitionPixels
      const weight = distance <= context ? 1 : distance >= context + feather ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * (distance - context) / feather)
      blend[index] = Math.round(blend[index]! * weight)
    }
    if (compositionMode === 'protected-context-v2') {
      // Generation and composition share the editable background; V1 keeps its original request mask for saved receipts.
      protection = Buffer.alloc(mask.data.length)
      for (let i = 0; i < protection.length; i++) protection[i] = protectedPixels[i] || blend[i] === 255 ? mask.data[i]! : 0
    }
  }
  const editMask = await sharp({ create: { width: settings.width, height: settings.height, channels: 3, background: { r: 255, g: 255, b: 255 } } }).joinChannel(sourceLayout?.version === 'source-intent-v2' && compositionMode === 'generated-canvas-v1' ? mask.data : protection, { raw }).png().toBuffer()
  let image: Buffer<ArrayBufferLike> = seed
  let generatedSize: { width: number; height: number } | undefined
  if (background) {
    const complete = await renderCompleteWallpaper(background, settings)
    image = complete.image; generatedSize = complete.generatedSize
  }
  return { image, mask: editMask, geometry, generatedSize }
}

/** Reject the retired candidate-restoration operation; historical callers cannot create pasted outputs.
 * @param candidate Saved complete-candidate pixels. @param plan Its one uniform placement. @param settings Frozen target geometry. @param generated Provider background pixels. @param subjectsOnly Restore protected subject rectangles while leaving defective background editable.
 * @returns Never resolves because source and candidate restoration is disabled.
 */
export async function lockWallpaperCandidate(candidate: Uint8Array, plan: WallpaperPlan, settings: WallpaperSettings, generated: Uint8Array, subjectsOnly = false): Promise<Buffer> {
  const native = await sharp(generated).metadata()
  const composed = await renderWallpaper(candidate, plan, subjectsOnly ? { ...settings, backgroundContextPixels: 0, backgroundTransitionPixels: 0 } : settings, generated, subjectsOnly ? 'protected-context-v2' : 'generated-canvas-protected-v2')
  return sharp(composed.image).resize(native.width, native.height, { fit: 'fill' }).png().toBuffer()
}

/** Measure visible discontinuities where generated pixels meet the exact retained source.
 * @param image Native composed canvas before optional super-resolution.
 * @param target Placed source intersection with the canvas.
 * @param settings Frozen segmentation and jump thresholds.
 * @param comparison Generated candidates compare with the placed source interior; source-restored composites compare with both sides.
 * @returns Edge segments whose cross-boundary color jump greatly exceeds the selected adjacent rows or columns.
 */
export async function wallpaperSourceSeams(image: Uint8Array, target: { left: number; top: number; width: number; height: number }, settings: WallpaperSettings, comparison: 'both' | 'source-interior' = 'both') {
  const decoded = await sharp(image).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = decoded.info, pixels = decoded.data
  const policy = wallpaperProcessingSchema.parse(settings.processing ?? {}).sourceSeam
  const value = (x: number, y: number, channel: number) => pixels[(y * width + x) * channels + channel]!
  const defects: { edge: 'top' | 'bottom' | 'left' | 'right'; from: number; to: number; across: number; adjacent: number }[] = []
  const assess = (edge: 'top' | 'bottom' | 'left' | 'right', start: number, end: number, boundary: number, vertical: boolean) => {
    for (let from = start; from < end; from += policy.segmentPixels) {
      const to = Math.min(end, from + policy.segmentPixels)
      let before = 0, across = 0, after = 0
      for (let position = from; position < to; position++) for (let channel = 0; channel < 3; channel++) {
        const sample = (offset: number) => vertical ? value(position, boundary + offset, channel) : value(boundary + offset, position, channel)
        before += Math.abs(sample(-2) - sample(-1))
        across += Math.abs(sample(-1) - sample(0))
        after += Math.abs(sample(0) - sample(1))
      }
      const count = (to - from) * 3, crossMean = across / count
      const neighborMean = (comparison === 'source-interior' ? edge === 'top' || edge === 'left' ? after : before : Math.max(before, after)) / count
      if (crossMean >= policy.minimumCrossMean && crossMean >= policy.minimumRelative * neighborMean) defects.push({ edge, from, to, across: Math.round(crossMean * 10) / 10, adjacent: Math.round(neighborMean * 10) / 10 })
    }
  }
  if (target.top >= 2 && target.top + 1 < height) assess('top', target.left, target.left + target.width, target.top, true)
  const bottom = target.top + target.height
  if (bottom >= 2 && bottom + 1 < height) assess('bottom', target.left, target.left + target.width, bottom, true)
  if (target.left >= 2 && target.left + 1 < width) assess('left', target.top, target.top + target.height, target.left, false)
  const right = target.left + target.width
  if (right >= 2 && right + 1 < width) assess('right', target.top, target.top + target.height, right, false)
  return defects
}

/** Check authorized source-frame contacts in the native generated image before super-resolution can hide a hard cut.
 * @param image Complete native generated candidate.
 * @param target Placed source rectangle in target-canvas pixels.
 * @param canvas Frozen target-canvas dimensions.
 * @param native Actual candidate dimensions.
 * @param edges Source edges with authorized local continuation.
 * @param settings Frozen seam thresholds.
 * @returns Measured hard cuts at authorized contacts only.
 */
export async function wallpaperGeneratedFrameSeams(image: Uint8Array, target: { left: number; top: number; width: number; height: number }, canvas: { width: number; height: number }, native: { width: number; height: number }, edges: readonly ('top' | 'bottom' | 'left' | 'right')[], settings: WallpaperSettings) {
  if (!edges.length) return []
  const left = Math.round(target.left * native.width / canvas.width), top = Math.round(target.top * native.height / canvas.height)
  const right = Math.round((target.left + target.width) * native.width / canvas.width)
  const bottom = Math.round((target.top + target.height) * native.height / canvas.height)
  return (await wallpaperSourceSeams(image, { left, top, width: right - left, height: bottom - top }, settings, 'source-interior')).filter(seam => edges.includes(seam.edge))
}

/** Locate hard edges near a positioned source or a previously confirmed artifact for native review.
 * @param image Complete native candidate before reconstruction.
 * @param target Placed source rectangle in target-canvas pixels, if the generation request used one.
 * @param settings Frozen canvas dimensions and seam thresholds.
 * @param previousArtifact Confirmed artifact bounds in the previous complete canvas's normalized coordinates.
 * @param screen Frozen task selection for paired edges and optional isolated partial cuts.
 * @returns Detail rectangles in native normalized coordinates for visual confirmation.
 */
export async function wallpaperPositionedSeamRegions(image: Uint8Array, target: { left: number; top: number; width: number; height: number } | undefined, settings: Pick<WallpaperSettings, 'processing'> & { width: number; height: number }, previousArtifact?: { x: number; y: number; width: number; height: number }, screen: 'positioned-edge-pair-v1' | 'positioned-edge-v2' | 'positioned-edge-v3' | 'positioned-edge-v4' = 'positioned-edge-pair-v1') {
  if (!target && !previousArtifact) return []
  const { data, info } = await sharp(image).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const policy = wallpaperProcessingSchema.parse(settings.processing ?? {}).sourceSeam
  const x = width / settings.width, y = height / settings.height
  const retryEdgeDrift = 0.025
  const inspect = (vertical: boolean, first: number, second: number, start: number, end: number, mode: 'paired' | 'repeated' | 'isolated' | 'fragmented') => {
    const acrossSize = vertical ? width : height, alongSize = vertical ? height : width
    const segment = Math.max(32, Math.round(policy.segmentPixels * (vertical ? y : x)))
    const search = mode === 'repeated' ? Math.min(Math.ceil(acrossSize * retryEdgeDrift), Math.floor((second - first) / 4)) : Math.ceil(segment / 32)
    if (mode === 'paired' && (first < search + 8 || second + search + 8 >= acrossSize)) return []
    const strongLine = (line: number, from: number, to: number, radius = 2) => {
      let across = 0, before = 0, after = 0, count = 0
      for (let p = from; p < to; p += 2) for (let c = 0; c < channels; c++) {
        const pixel = (offset: number) => data[(vertical ? p * width + line + offset : (line + offset) * width + p) * channels + c]!
        across += Math.abs(pixel(-radius) - pixel(radius))
        before += Math.abs(pixel(-4 * radius) - pixel(-2 * radius))
        after += Math.abs(pixel(2 * radius) - pixel(4 * radius))
        count++
      }
      return across >= policy.minimumCrossMean * count && across >= policy.minimumRelative * Math.max(before, after)
    }
    const details = (a: number, b: number, from: number) => {
      const padding = Math.min(a, acrossSize - b, Math.ceil(segment / 2))
      return [a, b].map(edge => vertical
        ? { x: (edge - padding) / width, y: from / height, width: 2 * padding / width, height: segment / height }
        : { x: from / width, y: (edge - padding) / height, width: segment / width, height: 2 * padding / height })
    }
    const detect = (edge: number, from: number) => {
      for (let line = edge - search; line <= edge + search; line++) if (strongLine(line, from, from + segment)) return true
      return false
    }
    const directionStart = Math.max(0, start), directionEnd = Math.min(alongSize, end)
    const isolatedDetail = (line: number, first: number, last: number, span: number, padding: number) => {
      const crossStart = Math.max(0, line - 2 * span), crossEnd = Math.min(acrossSize, line + 2 * span)
      const alongStart = Math.max(0, first - padding), alongEnd = Math.min(alongSize, last + span + padding)
      return [vertical
        ? { x: crossStart / width, y: alongStart / height, width: (crossEnd - crossStart) / width, height: (alongEnd - alongStart) / height }
        : { x: alongStart / width, y: crossStart / height, width: (alongEnd - alongStart) / width, height: (crossEnd - crossStart) / height }]
    }
    if (mode === 'fragmented') {
      const fragment = Math.max(16, Math.floor(segment / 4)), step = Math.floor(fragment / 4), radius = 4
      const acrossDrift = Math.ceil(acrossSize * retryEdgeDrift), alongDrift = Math.ceil(alongSize * retryEdgeDrift)
      const from = Math.max(0, directionStart - alongDrift), to = Math.min(alongSize, directionEnd + alongDrift)
      const exterior = [{ from: from - fragment, to: from }, { from: to, to: to + fragment }]
        .filter(span => span.from >= 0 && span.to <= alongSize)
      if (!exterior.length) return []
      let nearest: { line: number; first: number; last: number; distance: number } | undefined
      // The boundary can blend between interrupted objects. Require separated fragments on one line and prefer evidence nearer a predicted frame corner.
      for (const edge of [first, second]) for (let line = Math.max(4 * radius, edge - acrossDrift); line <= Math.min(acrossSize - 4 * radius - 1, edge + acrossDrift); line++) {
        if (exterior.some(span => strongLine(line, span.from, span.to, radius))) continue
        let firstHit: number | undefined, gap = false
        for (let begin = from; begin + fragment <= to; begin += step) {
          if (!strongLine(line, begin, begin + fragment, radius)) {
            if (firstHit !== undefined && begin - firstHit >= fragment) gap = true
            continue
          }
          if (firstHit === undefined || begin - firstHit > segment) { firstHit = begin; gap = false; continue }
          if (!gap || begin - firstHit < 2 * fragment) continue
          const distance = Math.abs(line - edge) + Math.min(Math.abs(firstHit - directionStart), Math.abs(begin + fragment - directionEnd))
          if (!nearest || distance < nearest.distance) nearest = { line, first: firstHit, last: begin, distance }
          firstHit = begin
          gap = false
        }
      }
      return nearest ? isolatedDetail(nearest.line, nearest.first, nearest.last, fragment, step) : []
    }
    if (mode === 'isolated') {
      const step = Math.floor(segment / 2)
      const exterior = [{ from: Math.max(0, directionStart - segment), to: directionStart }, { from: directionEnd, to: Math.min(alongSize, directionEnd + segment) }]
        .filter(({ from, to }) => to - from >= step)
      const fullSpan = (screen === 'positioned-edge-v3' || screen === 'positioned-edge-v4') && directionStart < step && alongSize - directionEnd < step
      if (!fullSpan && !exterior.length) return []
      // The crop proves no defect by itself. A full-span cut has no exterior at either end to sample.
      for (const edge of [first, second]) for (let line = Math.max(8, edge - search); line <= Math.min(acrossSize - 9, edge + search); line++) {
        if (exterior.some(({ from, to }) => strongLine(line, from, to))) continue
        let firstHit: number | undefined
        for (let from = directionStart; from + segment <= directionEnd; from += step) {
          if (!strongLine(line, from, from + segment)) continue
          if (firstHit === undefined || !fullSpan && from - firstHit > 2 * segment) { firstHit = from; continue }
          if (from - firstHit < segment) continue
          return isolatedDetail(line, firstHit, from, segment, step)
        }
      }
      return []
    }
    if (mode === 'repeated') {
      // A retry can move both hard edges. Require matching nonoverlapping segments on the same two lines.
      const starts: number[] = []
      for (let from = directionStart; from + segment <= directionEnd; from += segment) starts.push(from)
      if (starts.length < 2) return []
      const matches = (edge: number) => {
        const lines: { line: number; spans: number[] }[] = []
        for (let line = Math.max(8, edge - search); line <= Math.min(acrossSize - 9, edge + search); line++) {
          const spans = starts.filter(from => strongLine(line, from, from + segment))
          if (spans.length >= 2) lines.push({ line, spans })
        }
        return lines
      }
      const outside = Math.ceil(alongSize * retryEdgeDrift)
      const before = directionStart - outside, after = directionEnd + outside
      const firstLines = matches(first)
      if (!firstLines.length) return []
      const secondLines = matches(second)
      for (const a of firstLines) for (const b of secondLines) {
        const [from, next] = a.spans.filter(start => b.spans.includes(start))
        if (from === undefined || next === undefined) continue
        // A pair continuing through both sides of the artifact bounds is consistent with full-width bands.
        if (before >= 16 && alongSize - after >= 16 &&
          [a.line, b.line].every(line => strongLine(line, Math.max(0, before - segment), before) && strongLine(line, after, Math.min(alongSize, after + segment)))) continue
        return details(a.line, b.line, from)
      }
      return []
    }
    for (let from = directionStart; from + segment <= directionEnd; from += Math.floor(segment / 2)) {
      if (detect(first, from) && detect(second, from)) return details(first, second, from)
    }
    return []
  }
  const check = (left: number, top: number, right: number, bottom: number, mode: 'paired' | 'repeated' | 'isolated' | 'fragmented') => {
    const vertical = inspect(true, left, right, top, bottom, mode)
    return vertical.length ? vertical : inspect(false, top, bottom, left, right, mode)
  }
  if (previousArtifact) {
    const repeated = check(Math.round(previousArtifact.x * width), Math.round(previousArtifact.y * height), Math.round((previousArtifact.x + previousArtifact.width) * width), Math.round((previousArtifact.y + previousArtifact.height) * height), 'repeated')
    if (repeated.length) return repeated
  }
  if (!target) return []
  const box = [Math.round(target.left * x), Math.round(target.top * y), Math.round((target.left + target.width) * x), Math.round((target.top + target.height) * y)] as const
  const paired = check(...box, 'paired')
  if (paired.length || screen === 'positioned-edge-pair-v1') return paired
  const isolated = check(...box, 'isolated')
  return isolated.length || screen !== 'positioned-edge-v4' ? isolated : check(...box, 'fragmented')
}

/** Produce separate annotations and a simulated lock screen; clean output bytes remain unchanged.
 * @param image Actual seed or final pixels.
 * @param geometry Inferred-region transform.
 * @param settings Frozen template.
 * @returns Diagnostic and simulated images.
 */
export async function wallpaperOverlays(image: Uint8Array, geometry: ReturnType<typeof wallpaperGeometry>, settings: WallpaperSettings) {
  const { width, height, safe } = settings
  const topBuffer = settings.processing?.clockContrast ? settings.topBuffer : 0
  const regions = geometry.regions.map((region, i) => `<rect x="${region.left}" y="${region.top}" width="${region.width}" height="${region.height}" fill="none" stroke="${region.role === 'critical' ? '#ffb84d' : '#92d5ff'}" stroke-width="6"/><text x="${region.left + 8}" y="${region.top + 30}" font-size="30" fill="white">${i + 1}</text>`).join('')
  const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`)
  const guides = svg(`<rect width="${width}" height="${safe.top}" fill="#f44848" fill-opacity=".18"/><rect x="${safe.left}" y="${safe.top}" width="${safe.width}" height="${safe.height}" fill="#41d88d" fill-opacity=".08"/>${topBuffer ? `<rect y="${safe.top}" width="${width}" height="${topBuffer}" fill="#ffb84d" fill-opacity=".16"/>` : ''}<path d="M${safe.left} 0V${height}M${safe.left + safe.width} 0V${height}M0 ${safe.top}H${width}M0 ${safe.top + safe.height}H${width}" stroke="#32d8e8" stroke-width="5"/><path d="M${width / 2} 0V${height}M0 ${height / 2}H${width}${topBuffer ? `M0 ${safe.top + topBuffer}H${width}` : ''}" stroke="#fff" stroke-opacity=".4" stroke-width="3" stroke-dasharray="14 14"/>${regions}`)
  const clock = wallpaperClockSvg(settings)
  return { analysis: await sharp(image).composite([{ input: guides }]).png().toBuffer(), simulation: await sharp(image).composite([{ input: clock }]).png().toBuffer() }
}
