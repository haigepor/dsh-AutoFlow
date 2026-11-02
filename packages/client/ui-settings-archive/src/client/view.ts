/** Pure filtering over authoritative Session metadata; no cold logs are opened. */
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'

/** Local-date filter, inclusive at both ends. */
export interface ArchiveDates { readonly from: string; readonly to: string }

/**
 * Check a Session update against local calendar dates, including DST transitions.
 * @param updatedAt - Host update epoch milliseconds.
 * @param dates - HTML date input values; empty endpoints are unbounded.
 * @returns whether the timestamp lies in the requested inclusive dates.
 */
export function matchesDates(updatedAt: number, dates: ArchiveDates): boolean {
  if (dates.from === '' && dates.to === '') return true
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false
  const instant = (value: string, nextDay: boolean): number => {
    const [year = 0, month = 0, day = 0] = value.split('-').map(Number)
    return new Date(year, month - 1, day + (nextDay ? 1 : 0)).getTime()
  }
  return (dates.from === '' || updatedAt >= instant(dates.from, false))
    && (dates.to === '' || updatedAt < instant(dates.to, true))
}

/**
 * Format a local calendar date for the date-range editor.
 * @param value - local calendar date.
 * @returns value accepted by a native date input.
 */
export function dateInput(value: Date): string {
  return `${String(value.getFullYear())}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

/**
 * Resolve a preset to an inclusive local-date range.
 * @param preset - supported rolling date range.
 * @param now - current local day.
 * @returns inclusive calendar dates.
 */
export function presetDates(preset: string, now: Date): ArchiveDates {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (preset === 'week' || preset === 'month') {
    start.setDate(start.getDate() - (preset === 'week' ? 6 : 29))
    return { from: dateInput(start), to: dateInput(now) }
  }
  if (preset === 'older') {
    start.setDate(start.getDate() - 30)
    return { from: '', to: dateInput(start) }
  }
  return { from: '', to: '' }
}

/**
 * Order the filtered catalog without changing the shared Session list.
 * @param items - filtered catalog rows.
 * @param sort - user-selected order.
 * @returns a sorted copy with stable id tie breaks.
 */
export function sortSessions(items: readonly SessionSummary[], sort: string): SessionSummary[] {
  return [...items].sort((left, right) => {
    const compared = sort === 'title' ? (left.title ?? '').localeCompare(right.title ?? '')
      : sort === 'oldest' ? left.updatedAt - right.updatedAt : right.updatedAt - left.updatedAt
    return compared || left.id.localeCompare(right.id)
  })
}
