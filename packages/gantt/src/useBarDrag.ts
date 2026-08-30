import { useCallback, useEffect, useRef, useState } from "react"
import {
  type DateChange,
  type DragMode,
  type ISODate,
  type ScheduledTask,
  type TimeScale,
  applyDrag,
  diffDates,
  hitTest,
} from "@zukunft/domain"

export type DragState = {
  taskId: string
  mode: DragMode
  deltaDays: number
  preview: { startDate: ISODate; endDate: ISODate }
  pointer: { x: number; y: number }
}

type Options = {
  scale: TimeScale
  onCommit: (taskId: string, change: DateChange) => void
  /** ほとんど動かさずに離した場合はドラッグではなくクリックとして扱う */
  onClick?: (taskId: string) => void
}

/** これ以下の移動量ならクリック扱いにする (px)。 */
const CLICK_SLOP_PX = 3

/**
 * バーのドラッグ / リサイズ（企画書 §6.3.3）。
 *
 * - スナップは TimeScale.toDays が日単位に丸めることで保証する
 * - Esc で破棄。ミューテーションは発行しない
 * - 確定はポインタ解放時、かつ値が実際に変化した場合のみ
 */
export function useBarDrag({ scale, onCommit, onClick }: Options) {
  const [drag, setDrag] = useState<DragState | null>(null)

  // ポインタ移動のたびに state を読み直さずに済むよう、進行中の情報を ref に持つ。
  const session = useRef<{ task: ScheduledTask; mode: DragMode; startX: number } | null>(null)
  const cancelled = useRef(false)

  const begin = useCallback(
    (event: React.PointerEvent<SVGGElement>, task: ScheduledTask, barX: number, barWidth: number) => {
      if (event.button !== 0) return
      const offsetX = event.clientX - event.currentTarget.getBoundingClientRect().left
      const mode = hitTest(offsetX, barWidth)
      cancelled.current = false
      session.current = { task, mode, startX: event.clientX }
      setDrag({
        taskId: task.id,
        mode,
        deltaDays: 0,
        preview: { startDate: task.startDate, endDate: task.endDate },
        pointer: { x: event.clientX, y: event.clientY },
      })
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
      void barX
    },
    [],
  )

  const move = useCallback(
    (event: React.PointerEvent<SVGGElement>) => {
      const current = session.current
      if (!current || cancelled.current) return
      const deltaDays = scale.toDays(event.clientX - current.startX)
      setDrag({
        taskId: current.task.id,
        mode: current.mode,
        deltaDays,
        preview: applyDrag(current.task, current.mode, deltaDays),
        pointer: { x: event.clientX, y: event.clientY },
      })
    },
    [scale],
  )

  const end = useCallback(
    (event: React.PointerEvent<SVGGElement>) => {
      const current = session.current
      session.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      setDrag(null)
      if (!current || cancelled.current) {
        cancelled.current = false
        return
      }
      const movedPx = Math.abs(event.clientX - current.startX)
      if (movedPx <= CLICK_SLOP_PX) {
        // 掴んだだけで動かさなかった → 詳細を開く
        onClick?.(current.task.id)
        return
      }
      const deltaDays = scale.toDays(event.clientX - current.startX)
      const after = applyDrag(current.task, current.mode, deltaDays)
      const change = diffDates(current.task, after)
      if (change) onCommit(current.task.id, change)
    },
    [scale, onCommit, onClick],
  )

  // Esc は「操作を破棄して元の位置へ戻す」。session を落とすことで
  // 続く pointerup がコミットしないようにする。
  useEffect(() => {
    if (!drag) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      cancelled.current = true
      session.current = null
      setDrag(null)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [drag])

  return { drag, begin, move, end }
}
