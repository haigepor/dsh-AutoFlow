/** Shared ordering behavior for the two editable model catalogs. */
import { useState } from 'react'
import type { Dispatch, DragEvent, SetStateAction } from 'react'

interface ModelReorderOptions<T> {
  models: readonly T[]
  onChange: (models: T[]) => void
  setEditing: Dispatch<SetStateAction<ReadonlyMap<string, string>>>
  setExpanded: Dispatch<SetStateAction<ReadonlySet<number>>>
  disabled: boolean
}

/** Move an index and keep row-indexed editor state attached to its model. */
function movedIndex(index: number, from: number, to: number): number {
  if (index === from) return to
  if (from < to && index > from && index <= to) return index - 1
  if (to < from && index >= to && index < from) return index + 1
  return index
}

/**
 * Give both catalogs the same drag and keyboard ordering behavior.
 * @param options - Model rows, array write, and row-local editor state.
 * @returns Drag handlers, visual state, and keyboard move action.
 */
export function useModelReorder<T>(options: ModelReorderOptions<T>): {
  dragged: number | null
  over: number | null
  move: (from: number, to: number) => void
  dragStart: (index: number, event: DragEvent<HTMLButtonElement>) => void
  dragOver: (index: number, event: DragEvent<HTMLDivElement>) => void
  dragEnd: () => void
  drop: (index: number, event: DragEvent<HTMLDivElement>) => void
} {
  const { models, onChange, setEditing, setExpanded, disabled } = options
  const [dragged, setDragged] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)

  const move = (from: number, to: number): void => {
    if (disabled || from === to || from < 0 || to < 0 || from >= models.length || to >= models.length) return
    const next = [...models]
    const [item] = next.splice(from, 1)
    if (item === undefined) return
    next.splice(to, 0, item)
    setEditing(current => new Map([...current].map(([key, value]) => {
      const separator = key.indexOf(':')
      const index = Number(key.slice(0, separator))
      return [`${String(movedIndex(index, from, to))}${key.slice(separator)}`, value]
    })))
    setExpanded(current => new Set([...current].map(index => movedIndex(index, from, to))))
    onChange(next)
  }

  const dragStart = (index: number, event: DragEvent<HTMLButtonElement>): void => {
    if (disabled) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
    setDragged(index)
  }
  const dragOver = (index: number, event: DragEvent<HTMLDivElement>): void => {
    if (dragged === null || disabled) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setOver(index === dragged ? null : index)
  }
  const dragEnd = (): void => { setDragged(null); setOver(null) }
  const drop = (index: number, event: DragEvent<HTMLDivElement>): void => {
    if (dragged === null) return
    event.preventDefault()
    move(dragged, index)
    dragEnd()
  }

  return { dragged, over, move, dragStart, dragOver, dragEnd, drop }
}
