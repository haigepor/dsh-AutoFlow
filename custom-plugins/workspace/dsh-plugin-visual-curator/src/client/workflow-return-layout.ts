/** Rework routing keeps intermediate processing cards and the return label clear. */
/** @param source Review input port. @param target Production output port. @param top Clear horizontal corridor above the affected cards. @returns SVG path and label center. */
export function workflowReturnPath(source: { x: number; y: number }, target: { x: number; y: number }, top: number): readonly [string, number, number] {
  const path = `M${source.x},${source.y} C${source.x - 32},${source.y} ${source.x - 32},${top} ${source.x - 64},${top} L${target.x + 64},${top} C${target.x + 32},${top} ${target.x + 32},${target.y} ${target.x},${target.y}`
  return [path, (source.x + target.x) / 2, top]
}
