import type { ISODate, MilestoneMark } from "@zukunft/domain"

/** 菱形の中心から左右への半幅。Timeline.tsx の SVG パスと同じ値を使う。 */
const DIAMOND_HALF_WIDTH = 6
/** ラベルの開始位置（菱形の中心から）。Timeline.tsx の <text x={x + 10}> と揃える。 */
const LABEL_OFFSET = 10
/** 次のマイルストーンとの最小の隙間。詰まって見えるより、少し空く方を選ぶ。 */
const MIN_GAP = 8

/**
 * 題名の幅の見積もり（px）。
 *
 * DOM を測る手段を新しく持ち込まないための近似。全角（CJK・ひらがな・カタカナ・
 * 全角記号など）は正方形に近く、フォントサイズにほぼ等しい幅になる。半角は
 * その半分強とみなす。見積もりが実測より狭いと文字が重なって読めなくなるが、
 * 広い分には隙間が空くだけなので、多めに出す。
 */
export function estimateLabelWidth(title: string, fontSize: number): number {
  let width = 0
  for (const ch of title) {
    const code = ch.codePointAt(0) ?? 0
    const isWide =
      (code >= 0x1100 && code <= 0x115f) || // ハングル字母
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首拡張〜かな・カナを含む東アジア文字域
      (code >= 0xac00 && code <= 0xd7a3) || // ハングル音節
      (code >= 0xf900 && code <= 0xfaff) || // CJK 互換漢字
      (code >= 0xff00 && code <= 0xff60) || // 全角英数・全角記号
      (code >= 0xffe0 && code <= 0xffe6) // 全角記号（円マークなど）
    width += isWide ? fontSize : fontSize * 0.6
  }
  // 実測より多めに見積もるための余白。
  return width * 1.15
}

/**
 * 重なるマイルストーンを下の段へ送る。
 *
 * 期日の昇順に見て、その段に既に置いたものと重ならない最上段（lane 0 に近い方）
 * へ置く。入る段が無いときだけ新しい段を作るので、「期日が後ろのものだけが
 * 2 段目へ落ちる」という求められた挙動になる。
 *
 * pxPerDay が要るのは菱形の中心を出すため。Timeline.tsx は日の左端ではなく
 * マスの中央（toX + pxPerDay / 2）に菱形を置いており、ここで同じ位置を使わないと
 * 段の判定と実際の描画が半日分ずれる。
 */
export function packMilestones(
  marks: MilestoneMark[],
  toX: (d: ISODate) => number,
  pxPerDay: number,
  fontSize: number,
): { placed: { mark: MilestoneMark; lane: number }[]; laneCount: number } {
  const sorted = [...marks].sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0))

  // 各段の「これまでに置いたものの右端」。次のマイルストーンの左端がこれを
  // 超えていれば、その段に置ける。
  const laneRightEdges: number[] = []
  const placed: { mark: MilestoneMark; lane: number }[] = []

  for (const mark of sorted) {
    const x = toX(mark.dueOn) + pxPerDay / 2
    const left = x - DIAMOND_HALF_WIDTH
    const right = x + LABEL_OFFSET + estimateLabelWidth(mark.title, fontSize) + MIN_GAP

    let lane = laneRightEdges.findIndex((edge) => left >= edge)
    if (lane === -1) {
      lane = laneRightEdges.length
      laneRightEdges.push(right)
    } else {
      laneRightEdges[lane] = right
    }
    placed.push({ mark, lane })
  }

  // 0 件でも帯自体は描くので、段数は 1 を下回らない。
  return { placed, laneCount: Math.max(1, laneRightEdges.length) }
}
