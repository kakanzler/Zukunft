---
name: release
description: >
  Cut a Zukunft release, push commits/tags, or rebuild+reinstall the current
  build — by running release.ps1 through the test-runner (Haiku) agent so the
  verbose yarn verify / cargo check / tauri build / installer output never
  loads into this session. Use when the user asks to release, ship, publish,
  tag a version, push commits, or reinstall the current build ("リリースして",
  "release して", "vX.Y.Z を出して", "push して", "いまのビルドを入れ直して").
---

# リリースを切る / push する / 入れ直す

`release.ps1` がバージョン更新・検証・commit・tag・build・install の全手順と
安全装置（ブランチ確認・作業ツリーの汚れ確認・stale binary ガード・インストール後の
byte-size / レジストリ照合）を既に持っている。このスキルの役目は、**その実行と
出力の要約**を Haiku（`test-runner` エージェント）に任せることだけ — 判断は
このセッション（メイン）側で決め切ってから渡す。

## やること / やらないこと（ここが要点）

- **判断はここでする。実行だけを渡す。** バージョン番号・`-Push` するか・
  `-Install` するかは、このスキルを呼んだメインセッションが決め、
  **省略の余地がないコマンド行**に組み立ててから `test-runner` へ渡す。
  Haiku に「どのバージョンにするか」「push していいか」を選ばせない。
- **日々の機能コミットはここでは扱わない。** `chore: vX.Y.Z` は release.ps1 が
  自動生成する。複数段落で「なぜ」を書く通常のコミット（作業のたびに
  作っているもの）は今まで通りメインセッションが直接行う — 文面を Haiku に
  一から書かせると質が落ちる。
- **失敗したら止める。直さない。** `test-runner` は `release.ps1` が `Fail` で
  止めた理由をそのまま持ち帰るだけ。検証の失敗を通すためにコードを直したり、
  再試行したりしない。

## 手順

### 1. 状態を確認する（メインセッションで、委譲の前に）

エージェントを 1 回無駄に呼ばないよう、明らかに失敗する状態を先に弾く。

```bash
git rev-parse --abbrev-ref HEAD    # main でなければ release.ps1 が拒否する
git status --porcelain             # 汚れていれば release.ps1 が拒否する（バージョン更新のとき）
git tag -l "v<予定バージョン>"      # 既にあれば release.ps1 が拒否する
```

### 2. コマンド行を決める

`release.ps1` 自身の使い方（ヘッダコメント）に従う。

| やりたいこと | コマンド |
|---|---|
| バージョンを切る（push しない） | `.\release.ps1 <version>` |
| 切って push まで | `.\release.ps1 <version> -Push` |
| 切って push・build・install まで | `.\release.ps1 <version> -Push -Install` |
| 今のバージョンのまま入れ直す | `.\release.ps1 -Install` |
| 再ビルドせず、あるバイナリだけ入れ直す | `.\release.ps1 -Install -SkipBuild` |
| 何が起こるか先に見る | `.\release.ps1 <version> -DryRun` |
| たまっているコミットと tag だけ push | `git push origin main; git push origin --tags` |

バージョン番号は `package.json` の現在値 + 1 を機械的に採用しない。直前の
コミット群が bug fix だけなら patch、機能追加を含むなら minor —
**このセッションが判断し、利用者に伝えてから進める。**

`-Install` は動いている `zukunft.exe` を強制終了して入れ替える。利用者が
明示的に求めたときだけ付ける。

### 3. `test-runner` へ委譲する

Agent ツールで `subagent_type: "test-runner"` を呼ぶ。プロンプトには
**手順 2 で決めた一言一句そのままのコマンド行**を渡す。判断の余地を残さない。

例:
```
D:\Workspace\003---Zukunft で次を実行し、結果を報告してください。

    .\release.ps1 0.1.11 -Push

- 成功したら: 作られた tag 名、push したかどうか、最後の 3 行の出力を報告
  してください。
- 失敗したら: Fail で止まった行と、その直前の Step 名をそのまま報告して
  ください。直そうとしないでください。
```

`test-runner` はテスト実行に限らず「オーケストレータが指定したコマンドを
実行し pass/fail を要約する」役目を持つので、この委譲に合う。新しい
エージェント種別は作らない。

### 4. 結果を利用者に伝える

- **成功** — 作られた tag、push / install の有無、`release.ps1` 自身が末尾に
  出す「まだ push していません: ...」のような案内が残っていればそれも伝える。
- **失敗** — `test-runner` が持ち帰った Fail の行をそのまま見せる。直すかどうかは
  利用者の判断を仰ぐか、通常の修正フロー（`heavy-implementer` など）に渡す —
  **このスキルの中では直さない。**

## やらないこと

- Haiku にバージョン番号や `-Push` / `-Install` の要否を決めさせる
- 日々の機能コミットの文面を Haiku に作らせる
- 検証や install の失敗を、再試行や自動修正で通そうとする
- 承認なく `-Push` や `-Install` を付ける（利用者が求めていないときは付けない）
