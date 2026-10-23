/** Evaluation metrics retain every labeled unit in end-to-end recall denominators. */
import type { EvaluationReport, Metric } from '../shared/model.ts'

/** @param numerator Count meeting the criterion. @param denominator Eligible inspected count. @returns An honest unavailable or available rate. */
export function rate(numerator: number, denominator: number): Metric {
  return denominator === 0 ? { status: 'unavailable', numerator: 0, denominator: 0 } : { status: 'available', numerator, denominator, value: numerator / denominator }
}
/** @param items Same-input results for both standards. @returns Per-standard metrics, including full-batch failure and review rates. */
export function evaluationMetrics(items: EvaluationReport['items']): Record<string, Metric> {
  const metrics: Record<string, Metric> = {}
  for (const side of ['left', 'right'] as const) {
    const inspected = items.filter(i => i[side] !== 'technical-failed' && i[side] !== 'unprocessed')
    const positive = items.filter(i => i.humanLabel === 'accept')
    const negative = items.filter(i => i.humanLabel === 'reject')
    const truePositive = positive.filter(i => i[side] === 'pass').length
    const falsePositive = negative.filter(i => i[side] === 'pass').length
    const cropKey = side === 'left' ? 'leftCrop' : 'rightCrop'
    const reviewedCrops = items.filter(i => i.cropReviewed && i[cropKey] !== undefined)
    const crops = reviewedCrops.filter(i => i[cropKey] === 'accepted' || i[cropKey] === 'damaged')
    metrics[`${side}.acceptance`] = rate(truePositive, positive.length)
    metrics[`${side}.recall`] = rate(truePositive, positive.length)
    metrics[`${side}.precision`] = rate(truePositive, truePositive + falsePositive)
    metrics[`${side}.missed`] = rate(positive.filter(i => i[side] === 'reject').length, positive.length)
    metrics[`${side}.falseAcceptance`] = rate(falsePositive, negative.length)
    metrics[`${side}.positiveUnknown`] = rate(positive.filter(i => i[side] === 'needs-review').length, positive.length)
    metrics[`${side}.positiveTechnicalFailure`] = rate(positive.filter(i => i[side] === 'technical-failed').length, positive.length)
    metrics[`${side}.positiveUnprocessed`] = rate(positive.filter(i => i[side] === 'unprocessed').length, positive.length)
    metrics[`${side}.review`] = rate(items.filter(i => i[side] === 'needs-review').length, items.length)
    metrics[`${side}.technicalFailure`] = rate(items.filter(i => i[side] === 'technical-failed').length, items.length)
    metrics[`${side}.unprocessed`] = rate(items.filter(i => i[side] === 'unprocessed').length, items.length)
    metrics[`${side}.completion`] = rate(inspected.length, items.length)
    metrics[`${side}.cropDamage`] = rate(crops.filter(i => i[cropKey] === 'damaged').length, crops.length)
    metrics[`${side}.cropAcceptance`] = rate(reviewedCrops.filter(i => i[cropKey] === 'accepted').length, reviewedCrops.length)
    metrics[`${side}.cropUnknown`] = rate(reviewedCrops.filter(i => i[cropKey] === 'unknown').length, reviewedCrops.length)
  }
  return metrics
}
