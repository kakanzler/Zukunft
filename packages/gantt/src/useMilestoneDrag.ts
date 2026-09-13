import { useCallback, useEffect, useRef, useState } from "react"
import { type ISODate, type MilestoneMark, type TimeScale, addDays } from "@zukunft/domain"
import { CLICK_SLOP_PX } from "./useBarDrag"

export type MilestoneDragState = {
  milestoneId: string
  /** 掴んでからの移動量（日）。プレビューの根拠を残すために持つ */
  deltaDays: number
  preview: { dueOn: ISODate }
  pointer: { x: number; y: number }
}

type Options = {
  scale: TimeScale
  onCommit: (milestoneId: string, dueOn: ISODate) => void
  /** ほとんど動かさずに離した場合はドラッグではなくクリックとして扱う */
  onClick?: (milestoneId: string) => void
}

/**
 * 菱形のドラッグ（期日の移動）。
 *
 * useBarDrag を単一日付ぶんに削ったもの。マイルストーンが持つ日付は期日 1 つ
 * だけなので、掴んだ位置で左右の端を分ける hitTest（リサイズ）が意味を持たず、
 * モードは常に「動かす」。日付の加算も applyDrag ではなく addDays で足りる —
 * applyDrag / diffDates は開始日と終了日の組を前提にしており、片方だけの
 * 日付に当てはめる筋がない。
 *
 * それ以外（スナップ・Esc での破棄・クリックとの切り分け）は useBarDrag と
 * 同じ流儀にする。掴んで離すという同じ操作なので、盤面の中で振る舞いが
 * 場所ごとに違ってよい理由が無い。
 */
export function useMilestoneDrag({ scale, onCommit, onClick }: Options) {
  const [drag, setDrag] = useState<MilestoneDragState | null>(null)

  // ポインタ移動のたびに state を読み直さずに済むよう、進行中の情報を ref に持つ。
  const session = useRef<{ mark: MilestoneMark; startX: number } | null>(null)
  const cancelled = useRef(false)

  const begin = useCallback((event: React.PointerEvent<SVGGElement>, mark: MilestoneMark) => {
    if (event.button !== 0) return
    cancelled.current = false
    session.current = { mark, startX: event.clientX }
    setDrag({
      milestoneId: mark.id,
      deltaDays: 0,
      preview: { dueOn: mark.dueOn },
      pointer: { x: event.clientX, y: event.clientY },
    })
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }, [])

  const move = useCallback(
    (event: React.PointerEvent<SVGGElement>) => {
      const current = session.current
      if (!current || cancelled.current) return
      // スナップは TimeScale.toDays が日単位に丸めることで自動的に付く
      // （バーのドラッグと同じ機構。ここで別に丸めると二重に丸まる）。
      const deltaDays = scale.toDays(event.clientX - current.startX)
      setDrag({
        milestoneId: current.mark.id,
        deltaDays,
        preview: { dueOn: addDays(current.mark.dueOn, deltaDays) },
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
        // 掴んだだけで動かさなかった → カテゴリの割り当てを開く
        onClick?.(current.mark.id)
        return
      }
      const dueOn = addDays(current.mark.dueOn, scale.toDays(event.clientX - current.startX))
      // 何日か指は動いたが、丸めた先が元の日と同じことはある。GitHub への
      // 書き込みなので、値が変わらないときは送らない。
      if (dueOn !== current.mark.dueOn) onCommit(current.mark.id, dueOn)
    },
    [scale, onCommit, onClick],
  )

  /** 進行中の操作を捨てる。続く pointerup がコミットしないようにする。 */
  const cancel = useCallback(() => {
    cancelled.current = true
    session.current = null
    setDrag(null)
  }, [])

  // Esc は「操作を破棄して元の位置へ戻す」。stopImmediatePropagation まで行うのは
  // useBarDrag と同じ理由 — 同じ window に付いているフルスクリーン解除のハンドラに
  // 渡さないため。菱形を戻すつもりで押した Esc で画面が縮むのは予想外すぎる。
  useEffect(() => {
    if (!drag) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.stopImmediatePropagation()
      cancel()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [drag, cancel])

  return { drag, begin, move, end, cancel }
}
