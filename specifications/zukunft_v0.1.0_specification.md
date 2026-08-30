# Zukunft v0.1.0 仕様書（実装済みの状態）

## 0. 本書の位置づけ

本書は **実際に実装された内容** を記述する。設計の意図と構想は
[`github_issue_gantt_desktop_app_proposal.md`](github_issue_gantt_desktop_app_proposal.md)（企画書）にあり、
本書はその企画書に対して「何が入り、何が入らなかったか」「実装中に何を決め直したか」を確定させたもの。

食い違いがある場合は本書が正しい。

| | |
|---|---|
| 対象バージョン | v0.1.0 |
| リリース | https://github.com/kakanzler/Zukunft/releases/tag/v0.1.0 |
| 到達マイルストーン | 企画書 §14 の M1（編集可能なデスクトップアプリ）／M2 は Web の骨組みまで |
| 実装規模 | TypeScript + Rust 約 6,400 行（テスト含む、生成物を除く） |
| 自動テスト | ドメインロジック 79 件 |

---

## 1. 全体構成

```text
zukunft/
├── apps/
│   ├── desktop/
│   │   ├── package.json      Tauri CLI のスクリプト（cwd の都合でこの階層）
│   │   ├── next/             編集用 UI（Next.js 静的エクスポート）
│   │   └── src-tauri/        Rust: GitHub API・認証・トークン保管
│   └── web/next/             読み取り専用ビュー（SSR）
├── packages/
│   ├── domain/               型・日付・TimeScale・ミューテーションキュー（純粋関数）
│   ├── gantt/                自前実装の Gantt 描画とサイドバー（React + SVG）
│   └── github/               Repository インタフェースと 3 実装
├── specifications/
├── dev.ps1                   Windows の開発用ランチャ
└── package.json              Yarn workspaces
```

行数の内訳：`domain` 1,271 / `gantt` 717 / `github` 957 /
`desktop/next` 1,747 / `desktop/src-tauri` 1,462 / `web/next` 205。

### 1.1 コード共有の境界

企画書 §4.3.4 のとおり実装した。

| パッケージ | 共有 | 備考 |
|---|---|---|
| `packages/domain` | する | 型と純粋関数のみ。Node にも Tauri にも依存しない |
| `packages/gantt` | する | React 描画。データは props で受ける |
| `packages/github` | インタフェースのみ | 実装は `tauri` / `server` / `mock` の 3 つ |

`packages/github` のサブパス export：

- `@zukunft/github` — インタフェース・エラー分類・マッピング
- `@zukunft/github/tauri` — デスクトップ実装（`invoke()` 経由）
- `@zukunft/github/server` — Web 実装（サーバ側 fetch、読み取り専用）
- `@zukunft/github/mock` — GitHub に接続しない開発用実装

### 1.2 ビルドの前提

デスクトップ側の Next.js は `output: "export"`。企画書 §4.3.2 のとおり、
SSR・Server Actions・Route Handlers・ISR・画像最適化は使えない。
サーバ的処理はすべて Rust（Tauri command）が担う。

Web 側は SSR を使う。`/project/[projectId]` は on-demand レンダリング。

---

## 2. GraphQL の単一ソース化

GraphQL は `packages/github/src/queries/*.graphql` が正本。
TypeScript は webpack の `asset/source` で、Rust は `include_str!` で
**同じファイル** を読む。2 言語に別々の文字列を持たせないための構成。

| ファイル | 用途 |
|---|---|
| `listProjects.graphql` | 所有者の Project 一覧 |
| `projectSchema.graphql` | Project のフィールド定義 |
| `projectItems.graphql` | items のページング取得 |
| `itemUpdatedAt.graphql` | 書き込み前後の単体再取得 |
| `fragments.graphql` | フィールド値の共通フラグメント |
| `updateDateField.graphql` | 日付フィールドの更新 |
| `clearDateField.graphql` | 日付フィールドの削除（巻き戻し用） |
| `projectRepositories.graphql` | Project にリンクされたリポジトリ |
| `createIssue.graphql` | Issue の起票 |
| `addProjectItem.graphql` | Issue を Project へ追加 |
| `updateIssue.graphql` | タイトル・本文・ラベルの更新 |
| `repositoryLabels.graphql` | リポジトリのラベル一覧 |
| `createLabel.graphql` | ラベルの新規作成 |

TypeScript 側で `.graphql` を読むには両アプリの `next.config.mjs` に
webpack ルールが要る。型は `packages/github/src/graphql.d.ts` が与える。

---

## 3. GitHub とのデータ契約

### 3.1 必須フィールド

Projects v2 に以下が必要。無い場合は Gantt を表示したまま編集だけを閉じる。

| 役割 | 型 | 必須 |
|---|---|---|
| Status | Single select | 必須 |
| 開始日 | Date | 必須 |
| 終了日 | Date | 必須 |
| Priority | Single select | 任意 |
| Progress | Number | 任意 |

### 3.2 フィールド名の照合（企画書からの変更点）

企画書は `Start Date` / `Target Date` という**完全一致**を前提にしていたが、
GitHub 上では `Start date` のように書かれることが多く、
「作ったのに認識されない」が実際に起きた。

**大文字小文字・空白・記号を無視して照合する**よう変更した。
正規化は「英数字以外を落として小文字化」。TypeScript
（`packages/domain/src/schedule.ts`）と Rust（`src/model.rs`）に同じ規則がある。

| 役割 | 受け付ける名前 |
|---|---|
| 開始日 | Start Date / Start date / start_date / Start / Begin |
| 終了日 | Target Date / End Date / Due Date / Target / End / Due |
| Status | Status / State |
| Priority | Priority |
| Progress | Progress / Percent complete |

型は厳密のまま。名前が合っていても型が違えば「不足」として扱い、
間違った型への書き込みを防ぐ。

### 3.3 Issue の扱い

- Project の item のうち、内容が **Issue のものだけ**を対象とする。
  Draft issue と Pull Request は表示しない。
- 日付が未設定の Issue は左ペインにイタリック体で並び、バーは描かれない。
  詳細モーダルから初期日程を入れられる。
- Issue が自動で Project に入るわけではないため、Project の Workflows で
  「Auto-add to project」を有効にする必要がある。

---

## 4. 認証

企画書 §11 は「正式版では GitHub App / OAuth を優先」としていたが、
実装時に **user 所有の Projects v2 は fine-grained PAT で扱えない**ことが判明した
（GitHub のドキュメント上、classic PAT か GitHub App のインストールトークンのみ）。

| | デスクトップ | Web |
|---|---|---|
| 方式 | classic PAT、または OAuth Device Flow | fine-grained PAT（Read のみ） |
| 必要スコープ | `repo` と `project` | Projects: Read |
| 保管先 | OS の資格情報ストア（keyring） | サーバ側の環境変数 |

### 4.1 トークンの解決順序

環境変数 `ZUKUNFT_GITHUB_TOKEN` → OS の資格情報ストア、の順で解決する。
サインイン判定とデータ取得は**同じ経路**（`auth::resolve_token`）を通す。
ここを分けていたために「環境変数を設定してもサインイン画面から進めない」不具合が出た。

環境変数が設定されている間はサインアウトできない（消しても環境変数が残るため、
成功したことにせずエラーを返す）。UI のヘッダに「環境変数のトークン」と表示する。

### 4.2 Device Flow

実装済みだが、Client ID をビルド時に `ZUKUNFT_GITHUB_CLIENT_ID` として
埋め込む必要があり、**v0.1.0 の配布物では未設定**。実質 PAT 認証のみ。

### 4.3 権限に関する注意

classic PAT の `repo` スコープは**利用者の全リポジトリ**に及ぶ。
企画書 §17 の「必要最小限の権限のみ要求する」からは外れる。
絞るには GitHub App 化するか、Project を Organization 所有にする必要がある。

---

## 5. Tauri command 一覧

UI は GitHub API を直接叩かず、すべて Rust に委譲する。

| command | 用途 |
|---|---|
| `auth_status` | サインイン状態とトークンの入手元 |
| `auth_start_device_flow` / `auth_poll_device_flow` | Device Flow |
| `auth_sign_in_with_token` | PAT でのサインイン（検証してから保管） |
| `auth_sign_out` | 資格情報ストアの消去 |
| `open_external` | 承認 URL を既定ブラウザで開く（github.com に限定） |
| `list_projects` | 所有者の Project 一覧 |
| `get_project_schema` | フィールド定義の取得とキャッシュ |
| `get_tasks` | items のページング取得 |
| `list_repositories` | Issue の作成先候補 |
| `create_task` | Issue 起票 → Project 追加 → 日付設定 |
| `update_task_dates` | 日付の更新（競合検出・補償つき） |
| `update_task_content` | タイトル・本文・ラベルの更新 |
| `list_labels` / `create_label` | ラベルの一覧と新規作成 |

`create_label` は preview 扱いのミューテーションで、
`Accept: application/vnd.github.bane-preview+json` が必須。
この呼び出しだけ Accept を差し替えている。

---

## 6. 同期の設計

### 6.1 状態

`synced` / `pending` / `syncing` / `failed` / `conflict` の 5 状態
（企画書 §16.1 のとおり）。

### 6.2 実装で追加した規則

**未送信の変更は畳み込む。** 同じタスクに `pending` の変更が残っている状態で
次の変更が来たら、古い方を置き換える。ロールバック先と競合判定の基準は
最初の変更前のものを引き継ぐ。別々に送ると往復が無駄になるうえ、
後発の `expectedUpdatedAt` が古く偽の競合を招くため。送信中（`syncing`）の分は畳まない。

**日付が未設定のタスクも編集できる。** 当初はロールバック用の値を非 null 前提で
組み立てており、日付の無い Issue への変更が黙って捨てられていた。
`Dates` を null 許容に変更した。

**未設定へ戻す操作は Undo に積まない。** 日付を消すミューテーションを
UI からは発行しないため、「未設定 → 設定」は元に戻せない。

**部分適用の取り消しでは値を消す。** バーの移動は 2 フィールドの更新になり、
1 つ目が成功して 2 つ目が失敗し得る。元々値が無かったフィールドは
上書きでは戻せないため `clearProjectV2ItemFieldValue` を使う。

### 6.3 競合検出

読み取り時の `updatedAt` を保持し、書き込み直前に対象 item を取り直して比較する。
Projects v2 にバージョン番号が無いため、検出漏れは起こり得る前提。

### 6.4 リトライ

ネットワークエラーと二次レート制限のみ、最大 3 回・1s / 4s / 16s のバックオフ。
4xx は即 `failed`。

### 6.5 送信ループ

キューの処理は ref に置いた関数で駆動する。エフェクトの依存に state を置くと、
`markSyncing` による state 更新で自分自身の cleanup が走り、
送信中のリクエストを取り消してしまうため。

---

## 7. UI

### 7.1 画面構成

```text
┌────────┬──────────────────────────────────────────────┐
│        │ ツールバー（Project 選択・ズーム・Undo/Redo・  │
│ サイド │ 再読み込み・新規 Issue・同期状態）・凡例       │
│ バー   ├──────────────┬───────────────────────────────┤
│        │ タスクペイン  │ タイムライン（SVG）            │
│Progress│ （DOM）      │ 月/週ヘッダ・バー・            │
│Category│              │ マイルストーン・今日線          │
│        ├──────────────┴───────────────────────────────┤
│        │ KPI タイル（Tasks / Weeks / Milestones / %）   │
│        ├──────────────────────────────────────────────┤
│        │ ログペイン                                    │
└────────┴──────────────────────────────────────────────┘
```

### 7.2 サイドバー（表示の切り替え）

| ビュー | まとまり |
|---|---|
| Progress | Projects v2 の `Status` ごと（既定） |
| Category | Issue の Label ごと |

Category では 1 つの Issue が複数ラベルを持つ場合、**各グループに現れる**。
ラベルの無い Issue は末尾の `NO LABEL`。並びはアルファベット順で、
グループ見出しには GitHub 上のラベル色を出す。

バーの色はどちらのビューでも `Status` を表す。Category でラベル色にすると
グループ内が同色になり進行段階が読めなくなるため。

### 7.3 Gantt（自前実装）

- 座標は「日付 ↔ px」の単一スケール関数。ズームは day 32px / week 12px / month 4px
- 左ペインは DOM、タイムラインは単一の SVG。縦スクロールは連動、横はタイムラインのみ
- 縦方向は可視行 ± バッファのみ描画（仮想化）
- ドラッグ：バー中央で移動、両端 8px でリサイズ。日単位スナップ、最小 1 日
- ドラッグ中はゴースト表示と日付ツールチップ。Esc で破棄
- 動かさずに離した場合はクリックとして扱い、詳細モーダルを開く（しきい値 3px）
- 読み取り専用時はドラッグのハンドラごと外し、クリックのみ受ける

### 7.4 タスク詳細モーダル

行またはバーのクリックで開く。

表示：Issue 番号・同期状態・タイトル・Status・Priority・Assignees・**Labels**・
Milestone・Progress・**本文**・開始日・終了日。

操作：

- 日程の設定（未設定のタスクにも入れられる）
- 「編集」でタイトル・本文・ラベルの変更
- ラベルは既存から選ぶほか、**その場で新規作成して付けられる**
- 「GitHub で開く」（Rust 経由で既定ブラウザ）

変更できないもの：Status・Assignee・Milestone。

ラベルの付け替えは `updateIssue` の `labelIds` に**置き換え後の集合**を渡す。
付けと外しを 1 回のミューテーションで済ませられるため。

### 7.5 新規 Issue

ツールバーの「＋ 新規 Issue」から、作成先リポジトリ・タイトル・本文・日程（任意）を
1 画面で入力する。Issue 起票 → Project 追加 → 日付設定をまとめて実行する。

Project への追加に失敗した場合、**Issue は自動削除しない**（破壊的なため）。
その状況を明記したエラーをログに出し、GitHub 上での対応を促す。

### 7.6 ログペイン

画面下部。エラー・警告・主要な操作結果を時系列で流す。
折りたたみ可能で、ヘッダに error / warn の件数を出す。

対処が必要なエントリには操作ボタンが付く。失敗なら「再試行」「取り消す」、
競合なら「GitHub 側を採用」「ローカルで上書き」。解決するとエントリは取り下げられる。

同じ事象は重複キーで差し替え、保持は 200 件まで。

企画書 §18 はカード表示を想定していたが、解決するまで画面を占有し続けるため
時系列ログに変更した。画面上部の帯（バナー）は使わない。

### 7.7 意匠

`specifications/apeearance/` の参考画像に準拠。ダークテーマ固定。

- 背景 `#060b1a` / 面 `#0d1630` / ヘッダ `#121d3d` / 罫線 `#1e2a4d`
- ステータス 4 色（Planning 青 / In Progress シアン / Review 紫 / Complete 緑）
- Status の選択肢が 4 種を超える場合は定義順に巡回して割り当てる

---

## 8. Web 版（読み取り専用）

`packages/gantt` を共有し、`readOnly` を立ててドラッグ経路を持たない。
`updateTaskDates` / `updateTaskContent` / `createTask` / `createLabel` は
呼ばれた時点で `unsupported` を投げる。

必要な環境変数（いずれもサーバ側のみ）：

| 変数 | 用途 |
|---|---|
| `ZUKUNFT_GITHUB_READ_TOKEN` | Read 権限のみのトークン |
| `ZUKUNFT_PUBLIC_PROJECT_IDS` | 公開する Project ID の許可リスト |

許可リストに無い Project は 404。Private リポジトリの内容を公開 URL で
配信することになるため、明示的な指定を必須にしている。

**v0.1.0 ではデプロイしていない。**

---

## 9. 開発と検証

### 9.1 入口

```powershell
.\dev.ps1          # デスクトップアプリ（実 GitHub に接続）
.\dev.ps1 -Mock    # ブラウザのみ・モックデータ
.\dev.ps1 -Web     # 読み取り専用 Web
```

`setx` で設定した環境変数は**新しく開いたターミナルにしか反映されない**ため、
`dev.ps1` は起動前にトークンの可視性を確認して警告する。

### 9.2 モックのシナリオ

GitHub に接続せず、状態を再現して確認できる。

| URL | 再現する状態 |
|---|---|
| `?failure=1` | 送信失敗 → リトライ → 再試行 / 取り消し |
| `?conflict=1` | 競合 → GitHub 側を採用 / ローカルで上書き |
| `?nodates=1` | 日付フィールドが無い Project |
| `?nodates=once` | 途中でフィールドが追加された Project |
| `?undated=1` | フィールドはあるが日付が未設定の Issue |
| `?empty=1` | Issue が 0 件の Project |

### 9.3 検証コマンド

```bash
yarn verify   # 型チェック 5 パッケージ + ドメインテスト 79 件
yarn build    # 両アプリの Next.js ビルド
cd apps/desktop/src-tauri && cargo check
```

### 9.4 リリース

```powershell
yarn tauri:build
```

`apps/desktop/src-tauri/target/release/bundle/` に MSI と NSIS が出る。
`tauri.conf.json` の `icon` に `.ico` を含めないとバンドルが失敗する。

---

## 10. 企画書からの変更点

| # | 企画書 | 実装 | 理由 |
|---|---|---|---|
| C-1 | フィールド名は完全一致 | 表記ゆれを吸収 | GitHub 上では `Start date` 等が一般的で、認識されない事故が起きた |
| C-2 | 正式版は GitHub App / OAuth 優先 | classic PAT が必須 | user 所有の Projects v2 は fine-grained PAT で扱えない |
| C-3 | エラーはカード表示（§18） | 下部のログペイン | 解決するまで画面を占有し続けるため |
| C-4 | 必須フィールドが無ければセットアップ画面で停止（§7.3.4） | 表示は続け、編集のみ閉じる | フィールドが無くても Issue 一覧としては読めるため |
| C-5 | Gantt のグループは Status のみ | Progress / Category の切り替え | ラベルでの俯瞰の要望 |
| C-6 | Tauri 化は Phase 4 | M1 に前倒し | 静的エクスポートの制約を後から発見する事態を避けるため |

---

## 11. 実装していないもの

企画書に記載があるが v0.1.0 に含まれないもの。

- 依存関係（Dependency）の表示と自動スケジューリング（§15.1 / §15.2）
- AI Schedule Assistant（§15.3）
- オフライン編集キューの永続化（§25）
- ローカルキャッシュ（SQLite）— 現状はメモリ上のみ
- Vercel へのデプロイ
- コード署名・公証・自動更新
- アプリからの Projects v2 フィールド自動作成
- Status / Assignee / Milestone の変更
- ラベルの削除・色変更
- 行のドラッグによる並べ替え

---

## 12. 検証状況

### 12.1 検証済み（モックデータ）

ブラウザ操作で確認した経路：

- Gantt 描画、ズーム切替、グループ折りたたみ
- バーのドラッグ／リサイズ → 楽観的更新 → 同期完了
- 失敗 → リトライ 3 回 → ロールバック
- 競合 → GitHub 側を採用で GitHub 値に戻る
- 詳細モーダルからの日程設定（未設定タスクを含む）
- タイトル・本文の編集と保存
- ラベルの付け外し、新規作成 → 付与 → 保存 → Category ビューへの反映
- Issue 起票 → 一覧・KPI・ログへの反映
- Progress / Category の切り替え
- フィールド不足時の警告と、再読み込みによる復帰

### 12.2 実 GitHub API で確認済み

- PAT でのサインイン
- Project 一覧の取得
- Project スキーマの取得とフィールド不足の検出

### 12.3 未検証

**以下は実装済みだが実 API での往復を確認していない。**

- 日付フィールドの書き込み（`updateProjectV2ItemFieldValue`）
- Issue の起票と Project への追加
- タイトル・本文・ラベルの更新
- ラベルの新規作成（preview ヘッダを含む）
- Device Flow

---

## 13. 既知のリスク

| # | 内容 |
|---|---|
| R-1 | classic PAT の `repo` スコープが全リポジトリに及ぶ |
| R-2 | 競合検出は `updatedAt` 比較のため検出漏れがあり得る |
| R-3 | 部分適用の補償自体が失敗すると GitHub 側が中間状態で残る |
| R-4 | 配布物が未署名で、SmartScreen の警告が出る |
| R-5 | 環境変数のトークンはレジストリに平文で入る（企画書 §17 から外れる） |
| R-6 | ローカルキャッシュが無く、起動のたびに全件取得する |
| R-7 | ページ読み込み直後の短時間はハイドレーション前でドラッグが効かない |
| R-8 | `createLabel` は preview 扱いで、GitHub 側の仕様変更に晒される |

---

## 14. 次に取り組むべきこと

優先度順。

1. **実 GitHub API での書き込み検証**（§12.3）— ここが通らないと M1 は完了しない
2. ローカルキャッシュ（SQLite）— 起動のたびの全件取得を避ける
3. Status の変更 — Gantt から進捗を動かせるようにする
4. GitHub App 化 — `repo` スコープを外し、権限を絞る
5. Vercel へのデプロイと公開範囲の決定
6. コード署名 — 配布時の摩擦を消す
7. 依存関係と自動スケジューリング（企画書 M3）
