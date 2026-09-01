# Zukunft

GitHub Issue を正本としたスケジュール管理アプリ。
GitHub Projects v2 の日付フィールドを Gantt 上でドラッグして編集し、
その場で GitHub に反映する。

ドキュメント:

- [企画書](specifications/github_issue_gantt_desktop_app_proposal.md) — 設計の意図と構想
- [v0.1.0 仕様書](specifications/zukunft_v0.1.0_specification.md) — 実装済みの状態、企画書からの変更点、検証状況

## 構成

```text
apps/
  desktop/next/       編集用デスクトップアプリの UI（Next.js 静的エクスポート）
                      サイドバー / Gantt / タスク詳細モーダル / 新規 Issue / ログペイン
  desktop/src-tauri/  Rust。GitHub API・トークン保管・競合検出
  web/next/           Vercel 向け読み取り専用ビュー（SSR）
packages/
  domain/             型・日付・TimeScale・ミューテーションキュー（純粋関数）
  gantt/              自前実装の Gantt 描画（React + SVG）
  github/             Repository インタフェースと 3 実装（tauri / server / mock）
```

編集はデスクトップアプリ、Web は読み取り専用という役割分担のため、
デスクトップ側の Next.js は静的エクスポートで、サーバ的処理はすべて Rust が担う。
詳細は企画書 §4.3。

## 表示の切り替え

左のサイドバーで Gantt のまとめ方を選ぶ。

| ビュー | まとまり |
|---|---|
| Progress | Projects v2 の `Status` ごと（既定） |
| Category | Issue の Label ごと |

タスクの行またはバーをクリックすると詳細モーダルが開く。Status・Assignee・Label・
Milestone・Progress・本文を確認でき、日程の設定と、「編集」からタイトル・本文・
ラベルの変更ができる。ラベルは既存から選ぶほか、その場で新規作成して付けられる。
`close` / `reopen` で Issue の開閉を切り替えられ、`delete` は確認を挟んでから
Issue ごと削除する（GitHub 側にも復元手段が無いため取り消せない）。

「＋ 新規 Issue」でも詳細モーダルと同じ項目 — Status・ラベル（新規作成を含む）・
Milestone・日程 — を指定できる。作ってから詳細を開いて付け直す往復を残さないため。
ラベルと Milestone は作成先リポジトリごとに別物なので、作成先を切り替えると選択は消える。

ラベルは「ラベルを削除…」から定義ごと消すこともできる。チップの ✕ が
「この Issue から外す」なのに対しこちらはリポジトリ全体から消す操作なので、
専用モードに入らないと候補が出ず、さらに 1 件ごとに確認を挟む。

ラベルの新規作成・削除は GitHub GraphQL の `createLabel` / `deleteLabel` を使う。
どちらも preview 扱いのミューテーションで
`Accept: application/vnd.github.bane-preview+json` が必須のため、
Rust 側のクライアントはこの 2 つだけ Accept を差し替えている。

### 親カテゴリ

ツールバーの「カテゴリ設定」で、いくつかのラベルを**親カテゴリ**として選べる。
選んだラベルは GitHub 上では今までどおりのただのラベルで、このアプリの中でだけ
上位の括りとして扱われる。`Certification` を親にすると、Category 表示は

```text
▾ CERTIFICATION            8
  ▾ CCAR-F + CLAUDE        6
     #7 CCAR-F : Kindle
  ▾ MATH                   2
▾ その他                    1
```

のように「親カテゴリ → 残りのラベルの組み合わせ → タスク」の 2 階層になる。
親ラベルを 1 つも持たない Issue は末尾の「その他」に入り、親を 2 つ持つ Issue は
`CERTIFICATION + CLAUDE` という 1 つの親グループになる（どちらか一方に寄せる順位付けを
設定に持ち込まないため）。親を 1 つも選んでいなければ、下に書いたフラットな表示のまま。

設定は GitHub には送らず、Project ごとにアプリの設定ディレクトリの `settings.json`
に保存する。ラベル名で覚えているので、GitHub 側でラベル名を変えたら選び直す。

### まとめ方

Category は**ラベルの組み合わせ**でまとめる。`CCAR-F` と `Claude` の 2 つが付いた
Issue は「CCAR-F + CLAUDE」という 1 つのグループに入り、どの Issue も 1 行にしか
現れない。ラベルごとにグループを作ると、複数のラベルを持つ Issue が持っている数だけ
行に現れて一覧として読めなくなるため。ラベルの無い Issue は末尾の NO LABEL に
まとまる。バーの色はどちらのビューでも `Status` を表すので、Category 表示でも
進行段階が読める。

## 必要なもの

- Node.js 20 以上 / Yarn 1
- Rust 1.77 以上（デスクトップアプリのビルド時のみ）
- GitHub Projects v2 に `Status` / `Start Date` / `Target Date` フィールドがあること（企画書 §5.2）

## セットアップ

```bash
yarn install
```

## 開発

Windows では `dev.ps1` が入口。

```powershell
.\dev.ps1          # デスクトップアプリ（実際の GitHub に接続）
.\dev.ps1 -Mock    # ブラウザのみ・モックデータ
.\dev.ps1 -Web     # 読み取り専用 Web
```

初回は依存関係を自動で入れる。以下は個別に動かす場合の手順。

### ブラウザで UI だけ確認する（GitHub に接続しない）

```bash
yarn dev:desktop     # http://localhost:3000
```

Tauri の外で開くとモックデータで動く。同期まわりの表示は次で確認できる。

- `http://localhost:3000/?failure=1` — 送信失敗 → リトライ → 再試行 / 取り消し
- `http://localhost:3000/?conflict=1` — 競合 → GitHub 側を採用 / ローカルで上書き
- `http://localhost:3000/?nodates=1` — Start Date / Target Date が無い Project
- `http://localhost:3000/?nodates=once` — 途中でフィールドが追加された Project
  （再読み込みがスキーマを取り直すかの確認）
- `http://localhost:3000/?empty=1` — Issue が 0 件の Project
- `http://localhost:3000/?undated=1` — フィールドはあるが日付が未設定の Issue
  （詳細モーダルから初期日程を入れる流れの確認）

エラーと警告は画面下部のログペインに時系列で流れる。対処が必要なもの
（同期の失敗、競合）はログのエントリに操作ボタンが付く。

ログペインの高さは上端の境界をドラッグして決める（つまみに Tab で入れば ↑↓ でも動く）。
件数で勝手に伸び縮みはしない。読んでいる途中に Gantt の行位置が動かないようにするためで、
入りきらない分は固定の高さの中でスクロールする。

## ショートカット

| キー | 動作 |
|---|---|
| Ctrl+Z / Ctrl+Shift+Z・Ctrl+Y | Undo / Redo（企画書 §6.3.4） |
| Alt+L | ログだけを表示 / Gantt に戻す |
| Alt+A | 新規 Issue を起票する |

### デスクトップアプリとして動かす

```bash
yarn tauri:dev
```

初回起動時にサインインを求められる。Device Flow を使う場合は
`ZUKUNFT_GITHUB_CLIENT_ID` を設定してビルドする。設定しない場合は
Personal Access Token（Issues: Read / Projects: Read & Write）で入る。

開発中に毎回サインインしたくない場合は `ZUKUNFT_GITHUB_TOKEN` を設定しておくと、
そちらが優先される。

### 読み取り専用 Web

```bash
yarn dev:web         # http://localhost:3001
```

必要な環境変数（いずれもサーバ側のみ。ブラウザには渡らない）：

| 変数 | 用途 |
|---|---|
| `ZUKUNFT_GITHUB_READ_TOKEN` | Read 権限のみの fine-grained PAT |
| `ZUKUNFT_PUBLIC_PROJECT_IDS` | 公開する Project ID のカンマ区切り許可リスト |

許可リストに無い Project は 404 を返す（企画書 §17）。

## ビルド

```bash
yarn build           # 両方の Next.js アプリ
yarn tauri:build     # デスクトップのインストーラ
```

## 検証

```bash
yarn verify          # 全パッケージの型チェック + ドメインのテスト
cd apps/desktop/src-tauri && cargo check
```
