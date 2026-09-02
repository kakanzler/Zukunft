# GitHub Issue × Gantt Schedule Desktop App 企画書

## 0. 本書の位置づけ

本書は、GitHub Issue を正本としたスケジュール管理アプリケーション「Zukunft」の企画書である。

初版は方向性の宣言を目的としていたが、本改訂では**実装に着手できる粒度**へ引き上げることを目的とし、
それまで選択肢として並列に記述されていた項目を決定事項へ置き換えた。

### 0.1 確定した設計判断

| # | 論点 | 決定 | 該当章 |
|---|---|---|---|
| D-1 | スケジュール日付の保存先 | **GitHub Projects v2 の Date 型カスタムフィールド**を正本とする。Issue body へのメタデータ埋め込みは採用しない | §5 / §7.3 |
| D-2 | Gantt UI の実装方法 | **自前実装（React + SVG / CSS）**。既存 Gantt ライブラリは採用しない | §6.3 / §21 |
| D-3 | 編集クライアントの形態 | ローカルで動かす Web アプリではなく、**配布可能なデスクトップアプリ（Tauri）** | §4.1 / §4.3 |
| D-4 | Web 版の役割 | **Vercel 上の読み取り専用ビュー**。GitHub への書き込み権限を持たせない | §4.2 / §4.3 |
| D-5 | 最初のマイルストーン | **M1 = GitHub 読み取り → Gantt ドラッグ編集 → GitHub 書き込み → デスクトップアプリとして動作**まで | §14 |

### 0.2 参照する外部資料

- `specifications/apeearance/appearance_gantt.jpg` — Gantt 画面の意匠リファレンス
- `specifications/apeearance/Appearance_button.jpg` — ボタン・カード・アイコンの意匠リファレンス

---

## 1. 概要

GitHub Issue をタスク管理の基盤として利用し、Issue に設定された情報から Gantt Chart を生成・表示・編集できる Desktop App を開発する。

本システムでは、GitHub を「タスク・スケジュールの正本（Source of Truth）」として扱い、Next.js を中心とした UI で Gantt を視覚的に操作する。

特に、Gantt Chart 上のタスクをドラッグ＆ドロップして開始日・終了日などのスケジュールを変更し、その変更内容を GitHub Issue 側へ反映できることを主要機能とする。

また、Web 上での閲覧・共有用途として Vercel に Next.js アプリケーションをデプロイし、GitHub への書き込みなど認証情報を必要とする操作は Desktop App 側で実行する。

この構成は、Erfolg における「Local を操作・処理の主体、Web を表示・共有の主体」とするアーキテクチャと同様の思想を採用する。

---

## 2. 背景・目的

GitHub Issue はソフトウェア開発におけるタスク管理に非常に適している一方、Issue 一覧だけでは以下のようなスケジュール情報を直感的に把握しにくい。

- タスク間の期間
- 開始日・終了日
- タスクの重なり
- 全体スケジュール
- 進捗と予定の関係
- マイルストーンまでの距離
- タスクを移動した際のスケジュール変化

そこで GitHub Issue をそのままタスクデータとして利用し、その上に Gantt Chart による視覚的なスケジュール管理レイヤーを構築する。

目的は「GitHub を捨てて別のタスク管理ツールを導入する」のではなく、

> **GitHub Issue をデータソースとして維持したまま、Gantt による高度なスケジュール操作を追加する**

ことである。

---

## 3. 基本コンセプト

### 3.1 GitHub First

タスクの正本は GitHub に置く。

```text
GitHub Issues
    ↓
Issue / Project 情報を取得
    ↓
Next.js / Gantt UI
    ↓
ユーザーがドラッグ＆ドロップ
    ↓
スケジュール変更
    ↓
GitHub API
    ↓
Issue / Project へ反映
```

Gantt 側に独自のタスクデータベースを持つことを基本的には避け、GitHub の既存データモデルを最大限利用する。

ローカルに保持するのは**キャッシュと未送信のミューテーションのみ**であり、
アプリのローカルデータを消しても GitHub 側の情報が失われないことを不変条件とする。

### 3.2 Desktop First for Write Operations

GitHub への書き込みには GitHub Token 等の認証情報が必要となる。

そのため、Web アプリケーションを Vercel 上で動作させる場合でも、GitHub への変更操作を Desktop App 側に寄せる。

```text
                ┌─────────────────────┐
                │      GitHub         │
                │ Issues / Projects   │
                └──────────┬──────────┘
                           │
                    GitHub API
                           │
             ┌─────────────┴─────────────┐
             │                           │
             ▼                           ▼
    ┌────────────────┐         ┌────────────────┐
    │ Desktop App    │         │ Vercel / Web   │
    │ (Tauri)        │         │ Next.js        │
    │                │         │                │
    │ Read / Write   │         │ Read / Display │
    │ Gantt Editing  │         │ Sharing        │
    └────────────────┘         └────────────────┘
```

---

## 4. システム構成

### 4.1 Desktop App

Desktop App は、Next.js による UI と Rust による GitHub 操作を一体化した、
**配布可能なネイティブアプリケーション**として構築する。

開発中に `next dev` をブラウザで開くことはあるが、成果物は「ブラウザで開くローカル Web アプリ」ではなく、
インストールして起動する単体のアプリケーションである。

採用技術：

- Next.js（静的エクスポート）
- TypeScript / React
- 自前実装の Gantt Chart（SVG / CSS）
- Tauri（Rust）
- GitHub GraphQL API（Projects v2）／ REST API（補助）

#### 主な責務

| レイヤ | 責務 |
|---|---|
| UI（Next.js / React） | Repository / Project の選択、Gantt 表示、ドラッグ操作、同期状態の可視化 |
| Rust（Tauri command） | GitHub API 呼び出し、OAuth Device Flow、Token の Secure Storage 保管、ローカルキャッシュ、ミューテーションキューの永続化 |

UI 層は GitHub の資格情報を一切保持せず、`invoke()` を通じて Rust 層に処理を依頼する。

### 4.2 Vercel / Web App

Vercel には Next.js の Web アプリケーションをデプロイする。

主目的は「閲覧・共有」であり、GitHub のデータを Gantt UI として表示する。

#### 主な責務

- GitHub データの取得・表示（**読み取りのみ**）
- Gantt Chart の表示
- プロジェクトスケジュールの共有
- Read-only Dashboard
- URL によるアクセス

#### 原則

Vercel 側では GitHub に対する書き込み権限を**持たせない**。

Vercel が使用するのは、対象リポジトリ／Project に対して Read 権限のみを与えた
fine-grained Personal Access Token（または GitHub App のインストールトークン）とし、
環境変数としてサーバ側にのみ配置する。ブラウザへは決して露出させない。

これにより、

- 書き込み可能な Token の管理を Desktop App 側へ集約
- Web 公開時のセキュリティリスク低減
- Backend の永続稼働を不要化
- Vercel の Serverless 制約を回避

できる。

### 4.3 デスクトップ配布と Vercel の両立

Desktop App と Vercel Web を**1つのコードベースから**出すことは可能だが、
Next.js の実行モデルが両者で異なるため、以下の制約を設計の前提とする。

#### 4.3.1 ビルドパイプラインの違い

```text
              packages/domain      packages/gantt
             （型・純粋ロジック）  （React 描画）
                     │                   │
          ┌──────────┴─────────┬─────────┘
          │                    │
          ▼                    ▼
 ┌──────────────────┐   ┌──────────────────┐
 │ apps/desktop     │   │ apps/web         │
 │ next build       │   │ next build       │
 │ output: 'export' │   │ SSR / Server     │
 │        ↓         │   │ Components 可    │
 │   静的 HTML/JS   │   │        ↓         │
 │        ↓         │   │   Vercel Deploy  │
 │  Tauri が同梱    │   └──────────────────┘
 │        ↓         │
 │ .msi / .dmg 等   │
 └──────────────────┘
```

#### 4.3.2 デスクトップ側の制約

Tauri はローカルの静的アセットを WebView で読み込むため、
**デスクトップビルドでは Next.js のサーバ機能が使えない**。

使えないもの：

- SSR / Server Components によるサーバ実行
- Server Actions
- Route Handlers（`app/api/**`）
- ISR / `revalidate`
- 画像最適化 API（`next/image` は `unoptimized` にする）

したがってデスクトップ側の画面はクライアントコンポーネント中心に構成し、
「サーバでやりたい処理」はすべて Rust（Tauri command）に寄せる。

#### 4.3.3 呼び出し経路

```text
React Component
      │  invoke("fetch_project_tasks", { ... })
      ▼
Tauri Command (Rust)
      │  reqwest + Authorization ヘッダ
      ▼
GitHub GraphQL API
      │
      ▼
Rust 側で Domain Model 相当へ整形
      │  Result<Vec<ScheduleTask>, AppError>
      ▼
React Component
```

この経路を採ることで、

- WebView に生の Token を置かずに済む
- ブラウザの CORS / Origin 制約を回避できる
- レート制限やリトライを Rust 側に集約できる

#### 4.3.4 コード共有の境界

| パッケージ | 共有可否 | 理由 |
|---|---|---|
| `packages/domain` | 共有する | 型と純粋関数のみ。実行環境に依存しない |
| `packages/gantt` | 共有する | React 描画コンポーネント。データを props で受け取る |
| `packages/github` | **インタフェースのみ共有** | 実装はデスクトップ（Tauri command 経由）と Web（サーバ側 fetch）で別 |

`packages/github` は `GitHubScheduleRepository`（§8）を公開し、
実装を `repository.tauri.ts` と `repository.server.ts` の2つ持つ。

#### 4.3.5 配布形態

- 対象 OS：Windows / macOS / Linux
- 形式：Tauri のバンドラが生成するインストーラ（`.msi` / `.dmg` / `.AppImage` 等）
- **コード署名・公証・自動更新は M1 の範囲外**とする（§26 の未決事項）

---

## 5. GitHub データモデル

### 5.1 Issue

基本タスクを GitHub Issue とする。

Issue から取得する情報：

- number / title / state
- assignees
- labels
- milestone
- `updatedAt`（競合検出に使用、§16.3）

GitHub Issue 自体には標準の「開始日・終了日」が存在しないため、
**スケジュール情報は Issue ではなく GitHub Projects v2 のフィールドに保持する**（D-1）。

#### 却下した案：Issue body へのメタデータ埋め込み

Issue 本文に以下のようなブロックを埋め込む案も検討したが、採用しない。

```text
<!-- zukunft:schedule
start: 2026-09-01
end:   2026-09-10
-->
```

採用しない理由：

- スケジュール変更のたびに Issue 本文の編集履歴が汚れる
- 本文の書式が壊れると全タスクのパースが失敗し得る
- GitHub 標準 UI 側から値を編集・フィルタ・ソートできない
- 複数人が同時に本文を編集した際の競合が本文全体に及ぶ

### 5.2 GitHub Projects v2

スケジュール情報は GitHub Projects v2 のカスタムフィールドに保持する。

本アプリが要求するフィールド定義：

| フィールド名 | 型 | 必須 | 用途 |
|---|---|---|---|
| `Status` | Single select | 必須 | Gantt の色分け・グルーピング |
| `Start Date` | Date | 必須 | Gantt バーの左端 |
| `Target Date` | Date | 必須 | Gantt バーの右端 |
| `Priority` | Single select | 任意 | 表示・並び替え |
| `Progress` | Number (0–100) | 任意 | バー内の進捗塗り |
| `Iteration` | Iteration | 任意 | 期間のグルーピング |

`Status` の選択肢は、意匠リファレンスに合わせて既定で
`Planning` / `In Progress` / `Review` / `Complete` の4種を想定する。
異なる選択肢を持つ Project も許容し、色は選択肢の並び順に割り当てる。

必須フィールドが存在しない Project を開いた場合の挙動は §7.3.4 に定める。

---

## 6. Gantt Chart

### 6.1 基本機能

Gantt Chart には以下を表示する。

- Issue Number / Title
- Status（色分け）
- Assignee（アバター）
- Start Date / Target Date
- Progress
- Priority
- Milestone（菱形マーカー）
- Dependency（依存関係の矢印。§15.1）

### 6.2 ドラッグ操作

最重要機能の一つ。

ユーザーが Gantt 上のタスクをドラッグすると、

```text
Before

[Task A]  ──────────
          9/1      9/10


After

        [Task A]  ──────────
        9/5       9/14
```

のようにスケジュールが変更される。

変更内容は UI 上だけで完結させず、GitHub 側のデータへ反映する。

```text
Drag
 ↓
Local State 更新（楽観的更新）
 ↓
変更内容の差分生成
 ↓
Mutation Queue
 ↓
GitHub GraphQL API
 ↓
Projects v2 Field 更新
 ↓
GitHub と同期
```

### 6.3 Gantt 自前実装の設計

既存の React 向け Gantt ライブラリは採用せず、自前で実装する（D-2）。

理由：

- 意匠リファレンス（§6.4）のダーク＋ネオン表現を、ライブラリのテーマ機構の制約なしに再現できる
- ドラッグ／リサイズの当たり判定・スナップ・キャンセル挙動を完全に制御できる
- 同期状態（Syncing / Failed / Conflict）をバー自体の表現に組み込みやすい
- 依存を1つ減らし、Tauri の静的エクスポート環境で動作を保証しやすい

#### 6.3.1 座標モデル

タイムラインは「日付 → x 座標」の単一のスケール関数で表現する。

```ts
type TimeScale = {
  origin: Date        // タイムライン左端の日付
  pxPerDay: number    // ズーム段階で決まる
  toX(date: Date): number
  toDate(x: number): Date   // 日単位に丸める
}
```

ズーム段階と `pxPerDay` の対応：

| 段階 | pxPerDay | 目盛 |
|---|---:|---|
| Day | 32 | 日／週 |
| Week（既定） | 12 | 週／月 |
| Month | 4 | 月／四半期 |

行の y 座標は `rowIndex * rowHeight` で決まる固定高とし、可変高は扱わない。

#### 6.3.2 描画構成

左右2ペインを横スクロール同期させる。

```text
┌──────────────────┬──────────────────────────────────────┐
│ Task Pane (DOM)  │ Timeline (SVG)                       │
│                  │  ┌────────────────────────────────┐  │
│ ▼ PLANNING       │  │ 月／週ヘッダ（sticky）          │  │
│   Project Kickoff│  ├────────────────────────────────┤  │
│   Define Objs    │  │  ▭▬▬▬▬                        │  │
│ ▼ DESIGN         │  │        ▬▬▬▬▬▬        ◆        │  │
│   Wireframes     │  │              ▬▬▬▬▬▬▬          │  │
└──────────────────┴──────────────────────────────────────┘
                    ↑ 縦スクロールは両ペイン連動
                      横スクロールは Timeline のみ
```

- タスクペインは通常の DOM（テキスト・アバターの扱いが容易なため）
- タイムラインは単一の `<svg>`。バー・グリッド・マイルストーン・今日線をすべて SVG 要素で描く
- 行数が多い場合は縦方向の仮想化（可視行 ± バッファのみ描画）を行う

#### 6.3.3 ドラッグ / リサイズ仕様

| 操作 | 当たり判定 | 効果 |
|---|---|---|
| バー本体のドラッグ | バーの中央部（両端 8px を除く） | Start / Target を同じ日数だけ平行移動 |
| 左端のドラッグ | バー左端 8px | Start のみ変更 |
| 右端のドラッグ | バー右端 8px | Target のみ変更 |

共通の挙動：

- **スナップ**：常に日単位。`pxPerDay` が小さいズームでも日をまたがない移動は発生しない
- **最小幅**：1日。リサイズで Start > Target になる操作は最小1日で頭打ちにする
- **ゴースト表示**：ドラッグ中は元の位置を半透明で残し、移動先を実線で描く
- **日付ツールチップ**：ドラッグ中はカーソル近傍に変更後の Start / Target を表示
- **Esc**：ドラッグ中に押すと操作を破棄して元の位置へ戻す（ミューテーションを発行しない）
- **確定**：マウスアップ時に、値が実際に変化した場合のみミューテーションを発行する

#### 6.3.4 Undo / Redo

- **1ドラッグ＝1エントリ**。ドラッグ中の中間状態はスタックに積まない
- エントリは「タスク ID・変更前の Start/Target・変更後の Start/Target」を保持する
- Undo は逆向きのミューテーションを新規に発行する（GitHub 側の履歴も前進する）
- 同期に失敗して Rollback された操作は、スタックから取り除く

#### 6.3.5 M1 で実装しないもの

- 行のドラッグによる並べ替え
- タイムライン上での新規 Issue 作成

### 6.4 UI / ビジュアル仕様

意匠は `specifications/apeearance/` の2枚のリファレンス画像に準拠する。

- `appearance_gantt.jpg` — Gantt 画面全体の構成と配色
- `Appearance_button.jpg` — ボタン・カード・アイコンの表現

#### 6.4.1 デザイントークン

ダークテーマを既定かつ唯一のテーマとする（M1 ではライトテーマを用意しない）。

| トークン | 用途 | 参考値 |
|---|---|---|
| `--bg-base` | 画面全体の背景 | `#060B1A`（深い紺） |
| `--bg-surface` | パネル・カードの面 | `#0D1630` |
| `--bg-elevated` | ヘッダ・ツールバー | `#121D3D` |
| `--border-subtle` | 罫線・グリッド | `#1E2A4D` |
| `--border-glow` | 強調枠（ネオン） | `#2D6BFF` |
| `--text-primary` | 見出し・本文 | `#E8EEFF` |
| `--text-secondary` | 補足・目盛 | `#8CA0C8` |
| `--accent` | 主要アクション | `#3B82F6` |
| `--accent-cyan` | ハイライト・グロー | `#22D3EE` |

ステータス4色（バーのグラデーション）：

| Status | 開始色 | 終了色 |
|---|---|---|
| Planning | `#2563EB` | `#3B82F6` |
| In Progress | `#06B6D4` | `#22D3EE` |
| Review | `#7C3AED` | `#A855F7` |
| Complete | `#059669` | `#10B981` |

Project の `Status` が上記4種以外の選択肢を持つ場合は、選択肢の並び順に上記の色を巡回して割り当てる。

#### 6.4.2 レイアウト

```text
┌───────────────────────────────────────────────────────────────┐
│ ● Repo / Project セレクタ      凡例: ●Planning ●InProgress …  │  ← ヘッダ
├──────────────────┬────────────────────────────────────────────┤
│ TASK NAME  OWNER │  MAY 2026            │  JUN 2026           │  ← 月行
│                  │ W1  W2  W3  W4       │ W5  W6  W7  W8      │  ← 週行
├──────────────────┼────────────────────────────────────────────┤
│ ▾ PLANNING       │                                            │
│   Project Kickoff│  ▬▬▬▬                              ◆       │
│   Define Objs   ◍│      ▬▬▬▬▬▬                                │
│ ▾ DESIGN         │                                            │
│   Wireframes    ◍│          ▬▬▬▬▬▬▬▬                          │
├──────────────────┴────────────────────────────────────────────┤
│  ▤ 18 TASKS  │ ▦ 8 WEEKS │ ⚑ 4 MILESTONES │ ✓ 72% COMPLETE   │  ← KPI
└───────────────────────────────────────────────────────────────┘
```

構成要素：

- **ヘッダ**：Repository / Project セレクタ、ズーム切替、同期状態インジケータ（§16.4）、ステータス凡例
- **月・週ヘッダ**：2段。スクロール時も上端に固定
- **グループ見出し**：既定は `Status` によるグループ化。折りたたみ可能
- **Owner 表示**：タスク行の右端にアバター。未アサインはプレースホルダ
- **バー**：角丸、ステータス色のグラデーション、外側に淡いグロー。`Progress` があれば内側に明度の高い塗りを重ねる
- **マイルストーン**：菱形マーカー＋右側にラベル。GitHub の Milestone の期日に配置
- **今日線**：シアンの縦線
- **KPI タイル**：総タスク数／期間週数／マイルストーン数／完了率。表示中の Project の集計値

#### 6.4.3 タイポグラフィ・余白

- 見出し：セミボールド、字間わずかに広げる（リファレンスの見出し表現に合わせる）
- 目盛・ラベル：`--text-secondary`、大文字（`WEEK 1` 等）
- 行高：32px（Week ズーム時）
- 余白の基準単位：4px

#### 6.4.4 ボタン・カード

`Appearance_button.jpg` に準拠する。

- 角丸の枠線カード。背景は `--bg-surface`、枠は `--border-subtle`
- ホバー・選択時は枠を `--border-glow` にし、外側に淡いグローを載せる
- アイコン＋ラベル（必要に応じて2行）の縦積み
- 破壊的操作（同期の取り消し等）のみ枠色を警告色に変える

---

## 7. データ同期戦略

### 7.1 Read

基本的には GitHub を読み取り元とする。

```text
GitHub
  ↓
API
  ↓
Adapter / Wrapper
  ↓
Domain Model
  ↓
Gantt
```

GitHub API のレスポンスを UI に直接渡さず、中間の Domain Model に変換する。

```ts
type SyncState =
  | "synced"
  | "syncing"
  | "pending"
  | "failed"
  | "conflict"

type ScheduleTask = {
  id: string              // Projects v2 の item id
  issueNumber: number
  title: string
  url: string
  startDate: string | null   // YYYY-MM-DD
  endDate: string | null     // YYYY-MM-DD
  status: string | null
  priority: string | null
  assignees: { login: string; avatarUrl: string }[]
  milestone: { title: string; dueOn: string | null } | null
  progress: number | null    // 0-100
  updatedAt: string          // 競合検出用
  syncState: SyncState
}
```

これにより、Gantt の描画コードと GitHub API のデータモデルを分離する。

### 7.2 Write

Gantt の変更を GitHub に反映する。

```text
Gantt Event
    ↓
ScheduleTask Mutation
    ↓
Mutation Queue
    ↓
GitHub Adapter
    ↓
GitHub API
```

直接 API を UI コンポーネントから呼ばず、GitHub Adapter を経由させる。

### 7.3 GitHub Projects v2 データ契約

#### 7.3.1 GraphQL を使う理由

Projects v2 は **REST API を持たない**。フィールド値の読み書きは GraphQL のみで行える。
したがって Project 関連は全て GraphQL、Issue の補助的な取得のみ必要に応じて REST を使う。

#### 7.3.2 読み取り

Project のフィールド定義とアイテムを取得する。概略：

```graphql
query($org: String!, $number: Int!, $after: String) {
  organization(login: $org) {
    projectV2(number: $number) {
      id
      fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id name dataType } } }
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValues(first: 20) { nodes { ...FieldValueFragment } }
          content {
            ... on Issue { number title url updatedAt
                           assignees(first: 5) { nodes { login avatarUrl } }
                           milestone { title dueOn } }
          }
        }
      }
    }
  }
}
```

- ユーザー所有の Project の場合は `organization` を `user` に差し替える
- `items` は 100 件ずつ `endCursor` で辿る
- フィールド定義は `name → { id, dataType, options }` の対応表としてキャッシュする（§7.3.3）

#### 7.3.3 書き込み

日付フィールドの更新は `updateProjectV2ItemFieldValue` を使う。

```graphql
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $date: Date!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId:    $itemId
    fieldId:   $fieldId
    value:     { date: $date }
  }) {
    projectV2Item { id }
  }
}
```

- **フィールド ID の解決**：ミューテーションには `fieldId` が必要だが、アプリが知っているのは
  `Start Date` などのフィールド**名**である。Project を開いた時点で名前 → ID の対応表を取得し、
  Project 単位でキャッシュする。キャッシュは Project 再選択時と、
  フィールド不整合エラーを受け取った時点で破棄する
- **バーの移動は2フィールドの更新**になる（Start と Target）。GraphQL にトランザクションはないため、
  1つ目が成功し2つ目が失敗する状態が起こり得る。この扱いは §16.2 に定める

#### 7.3.4 必須フィールドが無い Project

`Start Date` / `Target Date` / `Status` のいずれかが存在しない Project を開いた場合、
Gantt を描画せずセットアップ画面を表示する。

- 不足しているフィールド名と型を一覧表示する
- M1 では**アプリからフィールドを自動作成しない**。GitHub 上で作成する手順を案内するに留める
  （`createProjectV2Field` による自動作成は M2 以降の検討事項、§26）

#### 7.3.5 レート制限

- GraphQL API はポイント制（既定 5,000 points/hour）
- 1回のフル同期＝ `ceil(items / 100)` 回のクエリ。500 Issue で 5 リクエスト程度
- 日付更新は 1 操作あたり最大 2 ミューテーション
- 通常の利用でポイントを使い切る想定はないが、レスポンスの `rateLimit` を読み、
  残量が閾値を下回った場合は自動再取得を停止して手動更新に切り替える

---

## 8. GitHub API Adapter

GitHub との通信をアプリケーション内部から分離する。

```text
packages/github/
├── repository.ts          # インタフェース定義（共有）
├── repository.tauri.ts    # Desktop 実装：invoke() 経由
├── repository.server.ts   # Web 実装：サーバ側 fetch（読み取りのみ）
├── queries/
│   ├── project.graphql
│   └── items.graphql
└── mutations/
    └── updateFieldValue.graphql
```

公開するインタフェース：

```ts
interface GitHubScheduleRepository {
  listProjects(owner: string): Promise<ProjectSummary[]>
  getProjectSchema(projectId: string): Promise<ProjectSchema>
  getTasks(projectId: string): Promise<ScheduleTask[]>
  updateTaskDates(
    projectId: string,
    taskId: string,
    dates: { startDate?: string; endDate?: string },
    expectedUpdatedAt: string
  ): Promise<ScheduleTask>
}
```

- `expectedUpdatedAt` を必須引数とし、競合検出（§16.3）を呼び出し側が省略できないようにする
- Web 実装は `updateTaskDates` を実装せず、呼び出された場合は明示的にエラーを投げる
- UI は常にこのインタフェースだけを見る。GitHub API の仕様変更の影響をここで吸収する

---

## 9. Desktop と Vercel の役割分担

| 機能 | Desktop App | Vercel Web |
|---|:---:|:---:|
| GitHub Read | ○ | ○ |
| Gantt 表示 | ○ | ○ |
| Gantt Drag | ○ | × |
| GitHub Write | ○ | × |
| GitHub Token 管理 | ○（Write 権限） | △（Read 専用トークン） |
| ローカル設定 | ○ | × |
| キャッシュ | ○ | △（CDN / ISR） |
| スケジュール編集 | ○ | × |
| 共有 | △ | ◎ |
| Dashboard | ○ | ◎ |

Vercel は「表示・共有」に強く、Desktop App は「操作・GitHub への書き込み」に強い。

Web 側の Gantt Drag は「将来的に可」ではなく、
§4.2 の原則（書き込み権限を持たせない）から**恒久的に対象外**とする。

---

## 10. Desktop App 技術選定

### 採用：Tauri

Tauri を採用する。

理由：

- 軽量（Electron に比べバンドルサイズ・メモリ使用量が小さい）
- Rust による Native Backend
- Web UI と Native 処理の分離が明確
- OS の Secure Storage との連携プラグインがあり、Token 管理と相性が良い
- Next.js / React の UI をそのまま利用できる

構成イメージ：

```text
┌───────────────────────────────┐
│          Tauri App            │
│                               │
│  ┌─────────────────────────┐  │
│  │ Next.js / React         │  │
│  │ （静的エクスポート）      │  │
│  │                         │  │
│  │ Gantt UI                │  │
│  │ Issue List              │  │
│  │ Project Dashboard       │  │
│  └────────────┬────────────┘  │
│               │ invoke()      │
│               ▼               │
│  ┌─────────────────────────┐  │
│  │ Tauri / Rust Layer      │  │
│  │                         │  │
│  │ GitHub API              │  │
│  │ Token Storage           │  │
│  │ Local Cache             │  │
│  │ Mutation Queue          │  │
│  └─────────────────────────┘  │
└───────────────────────────────┘
```

Electron も候補としたが、軽量性と Native API との分離を考慮し Tauri を優先する。

トレードオフとして、開発環境に Rust ツールチェーンと各 OS のビルド依存が必要になる点、
WebView が OS ごとに異なる（WebView2 / WKWebView / WebKitGTK）ため
描画差異の検証が必要になる点を受け入れる。

---

## 11. 認証

認証は Desktop App と Vercel Web で**別系統**とする。混同しないことを原則とする。

| | Desktop App | Vercel Web |
|---|---|---|
| 方式 | GitHub OAuth **Device Flow** | fine-grained PAT（環境変数） |
| 権限 | Issues: Read / Projects: Read & Write | Projects: Read のみ |
| 保管先 | OS Secure Storage（Keychain / Credential Manager / Secret Service） | Vercel の環境変数（サーバ側のみ） |
| 保持者 | エンドユーザー個人 | サイト運営者 |

Device Flow を採る理由は、デスクトップアプリにリダイレクト URI を用意する必要がなく、
クライアントシークレットをアプリに埋め込まずに済むため。

プロトタイプ段階では Personal Access Token の手入力も許容するが、
M1 の完了条件には Device Flow の実装を含める。

原則：

> **GitHub の書き込み権限を Vercel の公開 Web アプリに直接持たせない**

Desktop App では Token を平文ファイルへ保存しない。

---

## 12. Web 版の位置づけ

Vercel 上の Web アプリは「スケジュール共有ページ」として利用する。

例えば、

```text
https://zukunft.example.com/project/my-project
```

へアクセスすると、

```text
Project
 ├─ Overview
 ├─ Gantt
 ├─ Issues
 ├─ Milestones
 └─ Progress
```

を確認できる。

将来的には、

- チームメンバーへの共有
- 顧客への進捗共有
- 公開プロジェクトページ
- Read-only URL
- Snapshot
- PDF / Image Export

などへ発展可能。

---

## 13. 「Erfolg」との共通アーキテクチャ

本プロジェクトでは、Erfolg と同様に以下の思想を採用する。

```text
              ┌───────────────┐
              │ External Data │
              │   GitHub      │
              └───────┬───────┘
                      │
              ┌───────▼───────┐
              │ Local Engine  │
              │               │
              │ Read / Write  │
              │ Processing    │
              │ Credentials   │
              └───────┬───────┘
                      │
                Domain Model
                      │
              ┌───────▼───────┐
              │ Web / Next.js │
              │               │
              │ Visualization │
              │ Sharing       │
              └───────────────┘
```

この構造により、

- データの所有権を外部サービス側に維持
- Local で高度な処理を実行
- Web では安全に情報を可視化
- Backend インフラへの依存を減らす

という設計が可能になる。

---

## 14. マイルストーン

### M1：編集可能なデスクトップアプリ（最初のマイルストーン）

GitHub の読み取りからドラッグ編集、GitHub への書き込み、
そしてデスクトップアプリとしての動作までを**一気通貫で成立させる**。

含む作業：

| 区分 | 内容 |
|---|---|
| Read | Repository / Project 選択、Projects v2 のフィールド定義とアイテム取得、Domain Model への変換 |
| 表示 | 自前 Gantt の描画（§6.3）、ダークテーマ意匠（§6.4）、KPI タイル、マイルストーン表示 |
| 編集 | バーの移動・リサイズ、日単位スナップ、Esc キャンセル、Undo / Redo |
| Write | `updateProjectV2ItemFieldValue` による日付反映、ミューテーションキュー、同期状態表示、競合検出、エラー処理 |
| Desktop | Tauri への組み込み、静的エクスポート構成、OAuth Device Flow、Secure Storage、ローカルキャッシュ |

#### M1 の受け入れ条件

1. ビルドしたデスクトップアプリを起動し、GitHub にサインインできる
2. Project を選択すると Issue が Gantt 上に表示される
3. `Start Date` / `Target Date` がバーの位置と長さに正しく反映される
4. バーをドラッグ／リサイズすると日単位で日付が変わる
5. 変更が GitHub Projects v2 のフィールドに反映される
6. アプリを再起動しても変更が保持されている（= GitHub 側に永続化されている）
7. GitHub 側で先に値が変わっていた場合、上書きせず競合として提示する
8. API 失敗時にローカル状態がロールバックされ、失敗が UI に表示される

### M2：Vercel 読み取り専用 Web

- Read-only Gantt（`packages/gantt` を共有）
- Project Dashboard
- URL による共有
- レスポンシブ対応
- 読み取り専用トークンによるサーバ側取得

#### M2 の受け入れ条件

1. 同じ Project を Vercel 上で読み取り専用表示できる
2. Web 側からは一切の書き込みが発生しない（`updateTaskDates` は実装されない）
3. トークンがクライアントに露出しない

### M3：スケジューリング機能の拡張

- 依存関係（§15.1）— v0.1.9 実装済み
- 自動スケジューリング（§15.2）— v0.1.9 実装済み
- AI Schedule Assistant（§15.3）
- オフライン編集キュー

---

## 15. スケジューリング機能

### 15.1 Dependency

Issue 間の依存関係を表現する。

```text
Issue #101
    │
    ▼
Issue #102
    │
    ▼
Issue #103
```

Gantt 上でも dependency line を表示する（v0.1.9 実装済み）。

#### 保存先

**Issue の本文**に持つ。Projects v2 のテキストフィールドに持つ案もあったが、
そちらは Project の設定に手を入れないと使えない。本文なら GitHub の画面でも
そのまま読めて、このアプリを使わない人にも伝わる。

```text
blocked-by: #101, #102
```

`depends-on:` と `依存:` も同じ意味として読む。番号は全角の `＃` も受ける
（日本語入力のまま打つとそちらになるため）。囲みコード（``` で挟んだ部分）の中は
書き方の説明とみなして読まない。

書き込みも同じ規則で行う。詳細モーダルの編集モードにある Dependency 欄で
付け外しすると、本文の宣言だけが差し替わる（`packages/domain/src/dependency.ts`）。

#### 番号の解決

Project には複数のリポジトリの Issue が並びうるので、番号だけでは一意に決まらない。
まず同じリポジトリの中で引き、そこに無いときだけ、Project 全体で番号が 1 つに
定まる場合に限って引く。当てずっぽうで別リポジトリの同じ番号に繋ぐと、線が
出ているのに関係が嘘、という最悪の状態になる。

#### 矢印の見た目

自分の Status の色から依存先の Status の色へのグラデーション。矢尻は依存先の色。
向きだけでなく色でもどちらへ向かっているかを読めるようにする。

#### 循環

循環した依存は成立しない日程を表す。線を消すと書き間違いに気づけないので、
**危険色の破線**で描いたうえで、ログに `循環: #101 → #102 → #101` を 1 行出す。
判定は強連結成分で行う（後退辺だけを拾うと、循環しているのに実線のまま残る辺が出る）。
循環したタスクは §15.2 の自動調整の対象から外す。

### 15.2 自動スケジューリング

依存関係に合わせて日程を後ろへずらす（v0.1.9 実装済み）。

例：

```text
Task A
  ↓
Task B
  ↓
Task C
```

Task A の終了日が変更された場合、

```text
Task A ────────
              ↓
              Task B ────────
                             ↓
                             Task C ─────
```

のように後続タスクを自動的に移動する。

#### 規則

- 制約は「依存タスクは依存先の終了日より**後**に始まる」。
- 破っているタスクだけを、依存先の翌日開始へずらす。**期間は保つ**。
- **押すだけで、前倒しはしない。** 意図して空けた余裕まで詰めると、
  「勝手に動いた」としか見えなくなる。余裕のあるタスクは動かず、
  動かないのでその下流も動かない。
- 依存先が複数あるときは、すべての依存先の終了日の**最も遅いもの**に合わせる。
- 日付未設定のタスクと、循環しているタスクは対象外。

処理は依存先が確定してから依存元を見る順序（トポロジカル順）で行う。素朴な幅優先だと、
依存先を 2 つ持つタスクが片方だけ確定した時点で評価され、同じタスクに 2 回の
書き込みが出てしまう。

#### 1 操作 = 1 Undo

1 ドラッグで複数のタスクが動くため、Undo のエントリは 1 タスクではなくグループを持つ
（§6.3.4）。Ctrl+Z 1 回で操作 1 回分がまとめて戻る。押し出された側もそれぞれ独立した
ミューテーションになるので、送信の直列化と競合の検出は 1 タスクずつ効く。

送信に失敗したタスクを含むエントリは、グループごと Undo スタックから落とす。一部だけ
残すと、依存先より前に始まる日程 — 利用者が一度も見ていない状態 — を Undo で
作れてしまう。

#### 切れること

Settings で無効にできる（既定は有効）。GitHub への書き込みが自分の操作より多く
発生する機能なので、要らない場面で止められるようにする。

### 15.3 AI Schedule Assistant

将来的には AI を組み込み、

- Issue の内容から作業期間を推定
- Issue を分解
- 依存関係を推定
- スケジュールを提案
- 遅延リスクを検出
- 「このリリースに間に合うか？」を分析

などを実装する。

例：

> 「9月30日までにこの Milestone を完了するにはどうすればいい？」

に対して、Issue 群と現在の Gantt を解析してスケジュール案を提示する。

---

## 16. 競合・同期問題

Desktop App と GitHub の間で同時編集が発生する可能性がある。

```text
Desktop App
    │
    │ Task A → 9/10
    │
    ▼
GitHub

別ユーザー
    │
    │ Task A → 9/12
    ▼
GitHub
```

この場合、ローカルの変更を無条件に上書きすると問題が発生する。

### 16.1 同期状態マシン

各タスクは以下の状態を持つ。

```text
        ┌────────┐
        │ Synced │◀───────────────┐
        └───┬────┘                │
   ドラッグ  │                     │ 成功
            ▼                     │
        ┌─────────┐   送信開始  ┌──┴──────┐
        │ Pending │───────────▶│ Syncing │
        └─────────┘             └──┬───┬──┘
             ▲                     │   │
     リトライ │            失敗      │   │ 競合検出
             │                     ▼   ▼
        ┌────┴────┐          ┌──────────┐
        │ Failed  │          │ Conflict │
        └─────────┘          └──────────┘
             │                     │
             │ ロールバック         │ 再読込 / 上書き選択
             ▼                     ▼
        ┌────────┐            ┌────────┐
        │ Synced │            │ Synced │
        └────────┘            └────────┘
```

- **Pending**：ローカルには反映済み。まだ送信していない
- **Syncing**：GitHub へ送信中
- **Synced**：GitHub と一致している
- **Failed**：送信に失敗した。リトライまたはロールバック待ち
- **Conflict**：送信前後で GitHub 側の値が変わっていた

### 16.2 楽観的更新とロールバック

1. ドラッグ確定時にローカルの `ScheduleTask` を即座に更新し、`syncState` を `pending` にする
2. 変更前の値をミューテーションキューのエントリに保存する
3. 送信して成功すれば `synced`、GitHub が返した値でローカルを上書きする
4. 失敗したら `failed` にし、ユーザーがロールバックを選んだ場合は保存しておいた変更前の値へ戻す

Start と Target の2フィールドを更新する場合（§7.3.3）、
1つ目が成功して2つ目が失敗すると GitHub 側が中間状態になる。
この場合は成功した1つ目を元の値へ戻すミューテーションを自動で発行し、
それも失敗した場合はタスクを `failed` のまま残して手動での再取得を促す。

### 16.3 競合検出

- 読み取り時に各タスクの `updatedAt` を保持する
- 書き込み直前にそのアイテムの `updatedAt` だけを再取得する
- 保持していた値と異なれば、書き込まずに `conflict` とする
- ユーザーには「GitHub 側の現在値」「ローカルの変更値」を並べて提示し、
  再読込（ローカル変更を破棄）か上書きかを選ばせる

Projects v2 には楽観的ロック用のバージョン番号が無いため、
この方式は「検出漏れが起こり得る」ことを前提とする。
M1 では検出漏れを許容し、より強い保証は将来の課題とする（§26）。

### 16.4 リトライ

- ネットワークエラー・5xx・二次レート制限：最大3回、指数バックオフ（1s / 4s / 16s）
- 4xx（権限・不正な入力）：リトライせず即 `failed`
- リトライ中も UI は `syncing` を表示する

---

## 17. セキュリティ

特に重要なのは GitHub Token の扱い。

### 原則

- Vercel に書き込み可能な Token を置かない
- Desktop App にのみ GitHub Write 権限を持たせる
- Token を平文で保存しない（OS Secure Storage を使う）
- Token を WebView 側（JavaScript）に渡さない。API 呼び出しは Rust 層で完結させる
- 必要最小限の GitHub 権限のみ要求する
- API 操作を GitHub Adapter に集約する
- ログ・エラーメッセージに Token を出力しない

また、Vercel 側で GitHub の情報を取得する場合も、公開範囲とキャッシュ戦略を明確にする。
Private リポジトリの内容を公開 URL で配信することになるため、
どの Project を Web に出すかは明示的な許可リストで管理する。

---

## 18. エラーハンドリング

GitHub API の失敗を考慮する。

```text
Gantt Drag
   ↓
Local State Update
   ↓
GitHub API
   │
   ├── Success
   │      ↓
   │   Synced
   │
   └── Failure
          ↓
       Failed
          ↓
       Retry / Rollback
```

UI では、§16.1 の5状態（Synced / Syncing / Pending / Failed / Conflict）を明示する。

- タスク行ごとの状態アイコン
- ヘッダに「未同期 n 件」のサマリ
- Failed / Conflict はクリックで詳細と対処（再試行・ロールバック・再読込）を提示

エラーメッセージは GitHub の生のレスポンスをそのまま出さず、
原因（権限不足・フィールド不在・レート制限・ネットワーク）ごとに対処を添えて表示する。

---

## 19. UX 方針

最も重要な操作は、

> **Issue を探す → Gantt で見る → ドラッグする → GitHub に反映される**

という一連の流れを極力短くすること。

理想的には、

```text
Issue #123
Implement authentication

      ┌──────────────────────────────┐
Sep 1 │████████████████              │ Sep 10
      └──────────────────────────────┘
                     ↑
                 Drag here
```

という直感的な操作だけでスケジュールを変更できるようにする。

同期はユーザーに意識させない。保存ボタンを設けず、ドラッグの確定をもって送信する。
ただし送信結果は必ず可視化し、「反映されたつもりで反映されていない」状態を作らない。

---

## 20. ディレクトリ構成案

```text
zukunft/
│
├── apps/
│   ├── desktop/
│   │   ├── next/              # output: 'export'
│   │   └── src-tauri/         # Rust: GitHub API / Token / Cache / Queue
│   │
│   └── web/
│       └── next/              # SSR 可、読み取り専用
│
├── packages/
│   ├── domain/                # 共有：型と純粋ロジック
│   │   ├── schedule.ts        # ScheduleTask, SyncState
│   │   ├── issue.ts
│   │   └── timescale.ts       # 日付 ↔ px（§6.3.1）
│   │
│   ├── gantt/                 # 共有：React 描画コンポーネント
│   │   ├── GanttChart.tsx
│   │   ├── TaskPane.tsx
│   │   ├── Timeline.tsx
│   │   └── theme.css          # デザイントークン（§6.4.1）
│   │
│   └── github/                # インタフェース共有・実装は分離
│       ├── repository.ts          # interface（共有）
│       ├── repository.tauri.ts    # Desktop 実装
│       ├── repository.server.ts   # Web 実装（読み取りのみ）
│       ├── queries/
│       └── mutations/
│
├── specifications/
├── package.json
└── README.md
```

Monorepo（Yarn workspaces）とすることで Desktop と Web で
Domain Model と Gantt コンポーネントを共有する。

共有してよいのは実行環境に依存しないコードのみである（§4.3.4）。
`packages/domain` と `packages/gantt` は Node の API も Tauri の API も参照しない。

---

## 21. 技術スタック案

| 領域 | 技術 |
|---|---|
| Language | TypeScript / Rust |
| UI | React |
| Framework | Next.js（Desktop は静的エクスポート、Web は SSR） |
| Desktop | Tauri |
| Gantt | **自前実装（React + SVG / CSS）** |
| API | GitHub GraphQL API（Projects v2）／ REST（補助） |
| Hosting | Vercel（読み取り専用 Web のみ） |
| Local Cache | SQLite（Tauri 側） |
| Secure Storage | OS Keychain / Tauri のセキュアストレージプラグイン |
| Package Management | Yarn（workspaces） |
| Repository | GitHub |
| CI/CD | GitHub Actions（Web のデプロイ、Desktop のビルド） |

---

## 22. 開発ロードマップ

### M1（編集可能なデスクトップアプリ）

| Step | 内容 |
|---|---|
| 1 | Monorepo の骨組みを作る（Yarn workspaces、`apps/desktop`、`packages/domain`） |
| 2 | `TimeScale` と `ScheduleTask` を定義し、ダミーデータで自前 Gantt を描画する |
| 3 | Gantt のドラッグ／リサイズをローカル状態に対して実装する（Undo / Redo 含む） |
| 4 | Tauri に組み込み、デスクトップアプリとして起動できる状態にする |
| 5 | Rust 側に GitHub GraphQL クライアントを実装し、Device Flow と Secure Storage を通す |
| 6 | Projects v2 の読み取りを実装し、ダミーデータを実データに差し替える |
| 7 | `updateProjectV2ItemFieldValue` による書き込みとミューテーションキューを実装する |
| 8 | 同期状態の可視化・競合検出・エラー処理を仕上げる |

Step 4 を早い段階に置くのは、静的エクスポートの制約（§4.3.2）を
実装が進んでから発見する事態を避けるため。

### M2（Vercel 読み取り専用 Web）

| Step | 内容 |
|---|---|
| 9 | `packages/gantt` を `apps/web` から利用し、読み取り専用 Gantt を SSR で表示する |
| 10 | 読み取り専用トークンの設定、公開 Project の許可リスト、レスポンシブ対応 |

### M3（拡張）

| Step | 内容 |
|---|---|
| 11 | 依存関係の保存方式を決定し、dependency line を描画する（済 / v0.1.9） |
| 12 | 自動スケジューリング（済 / v0.1.9） |
| 13 | AI Schedule Assistant |

---

## 23. 成功条件

### M1 の成功条件

ビルドしたデスクトップアプリ単体で、以下がすべて成立すること。

1. GitHub にサインインできる（OAuth Device Flow）
2. Repository / Project を選択できる
3. GitHub Issue を Gantt 上に表示できる
4. Projects v2 の日付情報が Gantt に正しく反映される
5. Gantt 上でタスクをドラッグ／リサイズできる
6. その結果が GitHub Projects v2 に反映される
7. アプリを再起動しても変更が保持されている
8. 競合・失敗が UI 上で識別でき、対処できる

### M2 の成功条件

9. 同じ Project を Vercel 上で読み取り専用表示できる
10. Web 側から GitHub への書き込みが発生しない

---

## 24. 最終的なプロダクト像

最終的には、

> **GitHub Issues をそのままプロジェクト管理のデータソースとして利用しながら、専用の Gantt UI でスケジュールを操作できる開発者向け Desktop App**

を目指す。

GitHub の Issue 管理能力と、専用プロジェクト管理ツールの Gantt 操作性を組み合わせる。

さらに、

```text
GitHub
   ↓
Issue / Project
   ↓
Zukunft Gantt Engine
   ↓
┌───────────────────────┐
│ Gantt                 │
│ Schedule              │
│ Dependency            │
│ Progress              │
│ AI Planning           │
└───────────────────────┘
   ↓
GitHub に反映
```

という循環を形成する。

Web は共有・可視化、Desktop App は操作・認証・GitHub への書き込みを担当することで、
Vercel の Serverless 環境に無理に Backend 機能を詰め込まず、シンプルかつ安全な構成を実現する。

このアーキテクチャは Erfolg の「Local Engine + Web Visualization」という設計思想とも整合し、
将来的には Gantt だけでなく、AI によるスケジュール生成・依存関係分析・進捗予測まで拡張できる。

---

## 25. 非機能要件

| 項目 | 目標 |
|---|---|
| 想定規模 | 1 Project あたり Issue 500 件、期間 12 か月 |
| 初回表示 | キャッシュ有りで 1 秒以内に Gantt が描画される |
| フル同期 | 500 Issue を 5 秒以内に取得する（GraphQL 5 リクエスト程度） |
| ドラッグ追従 | 60fps を維持する。行の仮想化により描画対象を可視範囲に限定する |
| 書き込み反映 | ドラッグ確定から GitHub 反映まで通常 2 秒以内 |
| レート制限 | 通常利用で GraphQL の時間あたりポイントの 20% 以内に収める |

### キャッシュ

- 保存先：Tauri のアプリデータディレクトリ配下の SQLite
- 保存内容：Project のフィールド定義、タスク一覧、未送信のミューテーション
- 無効化：Project 再選択時、手動更新時、フィールド不整合エラー受信時
- キャッシュを削除しても GitHub 側のデータは失われない（§3.1 の不変条件）

### オフライン

- M1：キャッシュからの**読み取り表示のみ**。編集操作は無効化し、その旨を表示する
- M3：ミューテーションキューを永続化し、復帰時に送信する（オフライン編集）

---

## 26. 未決事項・リスク

| # | 論点 | 内容 |
|---|---|---|
| Q-1 | Project のフィールド構成の強制 | `Start Date` / `Target Date` という名前を要求してよいか。名前をユーザーが設定でマッピングできるようにすべきか |
| Q-2 | フィールドの自動作成 | 不足フィールドを `createProjectV2Field` で自動作成するか。書き込み権限の範囲が広がる |
| Q-3 | 複数リポジトリ Project | 1つの Project が複数リポジトリの Issue を含む場合の表示・グルーピング方針 |
| Q-4 | 競合検出の限界 | Projects v2 にバージョン番号が無く、`updatedAt` 比較では検出漏れが起こり得る（§16.3） |
| Q-5 | Vercel の読み取りトークン | 誰のトークンを使うか。公開する Project の許可リストをどこに持つか |
| Q-6 | 署名・自動更新 | デスクトップアプリのコード署名・公証・自動更新をいつ導入するか。M1 は未署名配布 |
| Q-7 | WebView 差異 | OS ごとの WebView で SVG の描画・ドラッグ挙動に差が出ないかの検証が必要 |
| Q-8 | 依存関係の保存先 | **決定済み**: Issue の本文に `blocked-by: #101` の形で持つ。Projects v2 のフィールドは Project の設定に手を入れないと使えないため採らなかった（§15.1） |
| Q-9 | ディレクトリ名 | `specifications/apeearance/` は `appearance` の綴り誤りと思われる。リネームするか |

---

## 27. 用語集

| 用語 | 定義 |
|---|---|
| **Domain Model** | GitHub API の応答から変換された、UI が直接扱う型。`ScheduleTask` など（§7.1） |
| **ScheduleTask** | Gantt の1行に対応するタスク。Projects v2 の item と Issue を統合したもの |
| **Adapter / Repository** | GitHub との通信を隠蔽する層。`GitHubScheduleRepository`（§8） |
| **Mutation Queue** | ローカルの変更を GitHub へ送るための送信待ち行列。状態遷移は §16.1 |
| **TimeScale** | 日付と x 座標を相互変換するオブジェクト（§6.3.1） |
| **Device Flow** | ブラウザでコードを入力させる OAuth 方式。リダイレクト URI 不要（§11） |
| **M1 / M2 / M3** | マイルストーン。M1 = 編集可能なデスクトップアプリ、M2 = Vercel 読み取り専用 Web、M3 = 拡張（§14） |
| **Erfolg** | 「Local Engine + Web Visualization」という本プロジェクトの参照アーキテクチャ（§13） |
