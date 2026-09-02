"use client"

import { type ReactNode, useEffect, useState } from "react"
import { StatusLegend } from "@zukunft/gantt"

type Props = {
  /** Project の Status の定義順。凡例の色はこの並びに対応する */
  statuses: string[]
  onClose: () => void
}

type Section = {
  id: string
  title: string
  /** 目次に添える 1 行。開く前に当たりを付けられるようにする */
  summary: string
}

const SECTIONS: Section[] = [
  { id: "legend", title: "凡例", summary: "画面の色と記号の意味" },
  { id: "hotkeys", title: "ホットキー", summary: "キーボード操作の一覧" },
  { id: "dependency", title: "依存関係", summary: "矢印の出し方と読み方" },
  { id: "sync", title: "同期状態", summary: "GitHub との一致状況の読み方" },
]

const HOTKEYS: [string, string][] = [
  ["Alt+M", "このマニュアルを開く / 閉じる"],
  ["Alt+A", "新規 Issue を起票する（Project 選択中のみ）"],
  ["Alt+R", "スキーマとタスクを読み直す（Project 選択中のみ）"],
  ["Alt+↑ / Alt+↓", "サイドバーの表示を上下に切り替える"],
  ["Ctrl++ / Ctrl+-", "Gantt の横軸を拡大 / 縮小する"],
  ["Alt+Shift+← / →", "ズームを day / week / month の間で移す（Ctrl++/- と同じ）"],
  ["j / k", "Issue の選択を下 / 上に動かす"],
  ["Enter", "選択中の Issue の詳細を開く"],
  ["e", "選択中の Issue を編集モードで開く。詳細を開いた画面でも編集に入る"],
  ["Alt+L", "ログだけの表示と Gantt を切り替える"],
  ["Ctrl+Z", "日付の変更を元に戻す"],
  ["Ctrl+Shift+Z / Ctrl+Y", "元に戻した変更をやり直す"],
  ["Esc", "モーダルを閉じる。開いていなければフルスクリーンを抜ける"],
]

/**
 * アプリの使い方（Alt+M）。
 *
 * ヘッダから凡例と同期状態の表示を外したので、その説明の置き場をここにまとめた。
 * 常時画面を占有させず、必要なときだけ開いて読む形にする。
 *
 * 左の目次で節を選び、右にその節だけを出す。スクロール位置で節を追わせるより、
 * 「いま何を読んでいるか」が目次の見た目と一致する方が迷わない。
 */
export function ManualModal({ statuses, onClose }: Props) {
  const [active, setActive] = useState<string>(SECTIONS[0]!.id)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  return (
    <div
      className="zk-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="マニュアル"
    >
      <div className="zk-modal zk-modal--manual">
        <div className="zk-modal-head">
          <div className="zk-modal-title" style={{ flex: 1 }}>マニュアル</div>
          <button className="zk-button" onClick={onClose} aria-label="閉じる">✕</button>
        </div>

        <div className="zk-manual">
          <nav className="zk-manual-toc" aria-label="目次">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                className="zk-manual-toc-item"
                aria-pressed={active === section.id}
                onClick={() => setActive(section.id)}
              >
                <span className="zk-manual-toc-title">{section.title}</span>
                <span className="zk-manual-toc-summary">{section.summary}</span>
              </button>
            ))}
          </nav>

          <div className="zk-manual-body">
            {active === "legend" && <LegendSection statuses={statuses} />}
            {active === "hotkeys" && <HotkeySection />}
            {active === "dependency" && <DependencySection />}
            {active === "sync" && <SyncSection />}
          </div>
        </div>
      </div>
    </div>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="zk-manual-block">
      <h3 className="zk-manual-heading">{title}</h3>
      {children}
    </section>
  )
}

function LegendSection({ statuses }: { statuses: string[] }) {
  return (
    <>
      <Block title="Status の色">
        {statuses.length === 0 ? (
          <p className="zk-manual-text">
            Project を読み込むと、その Project の Status がここに並びます。
          </p>
        ) : (
          <>
            <StatusLegend statuses={statuses} />
            <p className="zk-manual-text">
              バーの色は Issue の Status に対応します。色は Status の定義順に割り当てるので、
              Project 側で並べ替えると色も入れ替わります。
            </p>
            <p className="zk-manual-text">
              盤面の見た目は Settings で選べます。Default はこれまでの配色、BlueSystem は
              青を基調にして今日とマイルストーンを赤で差したものです。選んだ見た目は
              次の起動でも保たれ、GitHub 側には何も起きません。
            </p>
          </>
        )}
      </Block>

      <Block title="バーの見え方">
        <dl className="zk-manual-list">
          <dt>白い重ね塗り</dt>
          <dd>Progress フィールドの進捗。0% と未設定のときは出ません。</dd>
          <dt>薄いバー</dt>
          <dd>ドラッグ中に残る元の位置。離すまで確定しません。</dd>
          <dt>#123</dt>
          <dd>Issue 番号。バーが短いときは省かれます。</dd>
        </dl>
      </Block>

      <Block title="タイムラインの記号">
        <dl className="zk-manual-list">
          <dt>縦の明るい線</dt>
          <dd>今日。表示期間の外にあるときは出ません。</dd>
          <dt>◆</dt>
          <dd>Milestone の期日。右に Milestone 名が付きます。</dd>
          <dt>表示終了日</dt>
          <dd>
            横軸の右端。既定は「今日から 1 年先」と「進行中の Issue のいちばん先の日付」の
            遠いほうです。日付を入れると固定され、「自動」で既定に戻ります。
          </dd>
        </dl>
      </Block>
    </>
  )
}

function HotkeySection() {
  return (
    <>
      <Block title="キー一覧">
        <dl className="zk-manual-list">
          {HOTKEYS.map(([keys, description]) => (
            <div className="zk-manual-row" key={keys}>
              <dt><kbd className="zk-kbd">{keys}</kbd></dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
      </Block>

      <Block title="補足">
        <p className="zk-manual-text">
          Alt のショートカットは物理キーで判定します。配列を切り替えていても、
          同じ位置のキーで同じ操作になります。文字入力を奪わないよう、
          Ctrl や Command と一緒に押したときは効きません。
        </p>
        <p className="zk-manual-text">
          j / k / e / Enter は修飾キー無しの 1 打鍵です。文字を入力している間と、
          モーダルが開いている間は効きません。裏の一覧が動くと、閉じたときに
          どこを見ていたのか分からなくなるためです。
        </p>
        <p className="zk-manual-text">
          Esc でフルスクリーンを抜けても設定は変わりません。次の起動は Settings で
          選んだ見せ方に戻ります。
        </p>
      </Block>
    </>
  )
}

function DependencySection() {
  return (
    <>
      <Block title="書き方">
        <p className="zk-manual-text">
          Issue の本文に <code className="zk-kbd">blocked-by: #101</code> と書くと、
          その Issue から #101 へ矢印が出ます。<code className="zk-kbd">depends-on:</code> と
          <code className="zk-kbd">依存:</code> も同じ意味です。
          <code className="zk-kbd">blocked-by: #101, #102</code> のように並べて書けます。
        </p>
        <p className="zk-manual-text">
          保存先は Issue の本文そのものです。Project にフィールドを増やす必要はなく、
          GitHub の画面でもそのまま読めます。囲みコード（``` で挟んだ部分）の中は
          書き方の説明とみなして拾いません。
        </p>
        <p className="zk-manual-text">
          本文を手で書かなくても、詳細を編集モードにすると Dependency の欄から
          依存先を付け外しできます。書き換わるのは同じ 1 行なので、どちらで
          直しても結果は同じです。
        </p>
      </Block>

      <Block title="矢印の読み方">
        <dl className="zk-manual-list">
          <dt>色</dt>
          <dd>
            自分の Status の色から、依存先の Status の色へのグラデーションです。
            先端は依存先の色なので、どちらへ向かっているかが色でも分かります。
          </dd>
          <dt>向き</dt>
          <dd>矢印が刺さっている側が依存先。先に片付いている必要がある Issue です。</dd>
          <dt>赤い破線</dt>
          <dd>
            循環した依存です。互いに相手の後を待つ形になっていて、そのままでは
            成立しない日程を表します。線を消すと書き間違いに気づけないので、
            色と破線で残しています。ログにも「循環: #101 → #102 → #101」と出ます。
          </dd>
        </dl>
      </Block>

      <Block title="自動の日程調整">
        <dl className="zk-manual-list">
          <dt>何が動くか</dt>
          <dd>
            依存先の終了日より前に始まっている Issue だけを、その翌日以降まで
            後ろへずらします。期間（日数）は変えません。
          </dd>
          <dt>前倒しはしない</dt>
          <dd>
            間が空いていても詰めません。空きは待ちの余裕として意図されていることが
            あり、勝手に詰めると予定を作り直すことになるためです。
          </dd>
          <dt>戻すとき</dt>
          <dd>まとめて動いた分は 1 回の操作として扱うので、Ctrl+Z 一回で全部戻ります。</dd>
          <dt>循環しているとき</dt>
          <dd>循環に入っている Issue は調整の対象から外します。動かす順番が決まらないためです。</dd>
          <dt>止めたいとき</dt>
          <dd>設定（Settings）で切れます。切ると、掴んだ Issue だけが動きます。</dd>
        </dl>
      </Block>

      <Block title="出ないとき">
        <dl className="zk-manual-list">
          <dt>依存先が Project に無い</dt>
          <dd>この Project に載っていない Issue 番号への参照は線にしません。</dd>
          <dt>どちらかに日付が無い</dt>
          <dd>バーが描かれていないので、線を引く先がありません。</dd>
          <dt>グループを折り畳んでいる</dt>
          <dd>行として出ていない Issue には引きません。開くと出ます。</dd>
        </dl>
      </Block>
    </>
  )
}

function SyncSection() {
  return (
    <>
      <Block title="ログに出る同期の状態">
        <dl className="zk-manual-list">
          <dt>同期されています</dt>
          <dd>送信待ちも未解決の失敗も無く、GitHub と一致している状態です。</dd>
          <dt>未同期 N 件</dt>
          <dd>
            ローカルには反映済みで、まだ GitHub に送っていない変更があります。
            送信は自動で進むので、待てば「同期されています」に変わります。
          </dd>
          <dt>要対応 N 件</dt>
          <dd>
            送信に失敗した、または送る前に GitHub 側が変わっていた変更があります。
            自然には解消しないので、ログの各エントリのボタンで対処してください。
          </dd>
        </dl>
      </Block>

      <Block title="いつログに出るか">
        <p className="zk-manual-text">
          状態が変わったときに 1 行だけ出ます。未同期のまま件数が増えても行は増えません。
          いま同期できているかを確かめたいときは Alt+R で読み直すと、そのときの状態を
          あらためてログに出します。
        </p>
      </Block>

      <Block title="対処のしかた">
        <dl className="zk-manual-list">
          <dt>失敗</dt>
          <dd>「再試行」で送り直します。原因が消えていないうちは同じ結果になります。</dd>
          <dt>競合</dt>
          <dd>
            「GitHub を採用」で自分の変更を捨て、「こちらを採用」で自分の変更を
            上書き送信します。どちらを選んでも、その場でログのエントリは取り下げられます。
          </dd>
          <dt>取り消し</dt>
          <dd>「取り消し」で、その変更を送る前の値に戻します。</dd>
        </dl>
      </Block>
    </>
  )
}
