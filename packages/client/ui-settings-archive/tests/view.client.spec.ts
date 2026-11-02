/** Date expectations come from inclusive local calendar-day semantics. */
import { describe, expect, it } from 'vitest'
import { dateInput, matchesDates, presetDates } from '../src/client/view.ts'

describe('archive update-date filters', () => {
  it('includes both selected days and excludes the next midnight', () => {
    const dates = { from: '2026-03-08', to: '2026-03-09' }
    expect(matchesDates(new Date(2026, 2, 8, 0, 0, 0).getTime(), dates)).toBe(true)
    expect(matchesDates(new Date(2026, 2, 9, 23, 59, 59, 999).getTime(), dates)).toBe(true)
    expect(matchesDates(new Date(2026, 2, 10, 0, 0, 0).getTime(), dates)).toBe(false)
    expect(matchesDates(new Date(2026, 2, 7, 23, 59, 59, 999).getTime(), dates)).toBe(false)
  })

  it('keeps unknown timestamps visible only with no date filter', () => {
    expect(matchesDates(0, { from: '', to: '' })).toBe(true)
    expect(matchesDates(0, { from: '2026-01-01', to: '' })).toBe(false)
  })

  it('uses seven inclusive calendar days across a month boundary', () => {
    expect(presetDates('week', new Date(2026, 2, 2))).toEqual({ from: '2026-02-24', to: '2026-03-02' })
    expect(presetDates('month', new Date(2026, 2, 2))).toEqual({ from: '2026-02-01', to: '2026-03-02' })
    expect(dateInput(new Date(2026, 0, 9))).toBe('2026-01-09')
  })
})
