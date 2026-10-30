/** Stable task-local phrase order and 10–14 second transitions, independent of component lifetime. */

function hash(value: string): number {
  let result = 2166136261
  for (const character of value) result = Math.imul(result ^ character.codePointAt(0)!, 16777619)
  return result >>> 0
}

/** One phrase and the adjacent transition instants in the task's loading timeline. */
export interface ImageStatusFrame { index: number; changedAt: number; nextAt: number }

/** Resolve a repeatable randomized loading phrase without saving model or Session data.
 * @param taskId Unique image task identity.
 * @param createdAt Task creation time in milliseconds.
 * @param now Current time in milliseconds.
 * @returns Phrase index and transition instants; neighboring transitions are 10–14 seconds apart.
 */
export function imageStatusFrame(taskId: string, createdAt: number, now: number): ImageStatusFrame {
  const order = [0, 1, 2, 3, 4, 5]
  for (let i = order.length - 1; i > 0; i--) {
    const other = hash(`${taskId}:order:${i}`) % (i + 1)
    ;[order[i], order[other]] = [order[other]!, order[i]!]
  }
  // 相邻边界只偏移 0–2 秒，使实际间隔始终落在 10–14 秒，切回会话也不会重置。
  const boundary = (index: number) => createdAt + index * 12_000 + (index === 0 ? 0 : hash(`${taskId}:time:${index}`) % 2001)
  let index = Math.max(0, Math.floor((now - createdAt) / 12_000))
  if (index > 0 && now < boundary(index)) index--
  return { index: order[index % order.length]!, changedAt: boundary(index), nextAt: boundary(index + 1) }
}
