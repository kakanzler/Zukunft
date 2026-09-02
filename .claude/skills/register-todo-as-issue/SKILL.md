---
name: register-todo-as-issue
description: >
  Register unstarted work as GitHub Issues on kakanzler/Zukunft — bugs found but
  not fixed, improvements deliberately left out of scope, deferred verification,
  and TODO/FIXME left in the code. Use at the end of a task whenever something
  was noticed but not done, or when the user asks to file a TODO as an Issue
  ("Issue にしておいて", "未着手を登録して", "register the leftovers").
---

# 未着手の TODO を Issue として登録する

作業で見つけたが直さなかったものを、`kakanzler/Zukunft` の Issue にする。
会話の中で述べただけの「スコープ外の気づき」は、セッションが閉じれば失われる。

## 前提

- `gh` CLI が `kakanzler` として認証済み（`gh auth status` で確認できる）。
- トークンのスコープは `repo` まで。**Projects v2 への追加はできない**
  （`read:project` が無い）。このスキルは Issue の作成までを担当し、
  ボードへの載せ替えは Zukunft アプリ側で行う。
- ラベルはリポジトリに既存のものだけを使う。**新しいラベルを作らない。**

## 手順

### 1. 候補を洗い出す

いま終えた作業から、次に当たるものを拾う。

- 直したバグの周辺で見つかった、別の未修正のバグ
- スコープ外として意図的に見送った改善・リファクタ
- サブエージェントの報告にある「スコープ外で気づいた点」
- 暫定対応で塞いだだけの箇所、残した TODO / FIXME
- 再現条件が作れず検証を見送った項目

その作業の中で**直したもの**は含めない。

### 2. 重複を確認する

登録前に必ず既存 Issue を検索する。同じものを二度立てない。

```bash
gh issue list --state all --search "<キーワード>" --limit 20
```

既にあれば、新規作成せずその Issue 番号を報告する。補足すべき新事実が
あるときだけ `gh issue comment <番号>` で追記する。

### 3. 本文を書く

1 件 1 関心。まとめて 1 つの Issue にしない。

- **タイトル** — 症状か、あるべき状態。`auth.rs:171` のような位置ではなく、
  何が困るのかを書く。日本語。
- **本文** — 次の 3 見出しで書く。

```markdown
## 現状

何がどうなっているか。該当箇所は `path/to/file.rs:123` の形で示す。

## なぜ直すべきか

放置すると何が起きるか。実測した事実があればそれを載せる（レスポンス本文、
エラーメッセージ、再現手順など）。推測は推測と明記する。

## 見送った理由

なぜその作業では直さなかったか。スコープ外だったのか、再現条件が作れな
かったのか、判断が要るのか。
```

コードの全文は貼らない。参照は `path:line` で足りる。

### 4. ラベルを選ぶ

既存ラベルから選ぶ。手元の一覧は `gh label list` で確認する。

| 内容 | ラベル |
|---|---|
| 壊れている・誤動作する | `bug` |
| 新機能・改善・リファクタ | `enhancement` |
| README / 企画書の不足 | `documentation` |
| 判断を仰ぎたい | `question` |

迷ったらラベルを付けない。誤ったラベルより無いほうがよい。

### 5. 下書きを見せて承認を得る

**起票はリポジトリの外に出る操作なので、勝手に実行しない。**
作成しようとしている全 Issue のタイトルとラベルを一覧で提示し、承認を得る。
本文は長いので、確認を求められたときだけ全文を出す。

### 6. 作成する

承認後、1 件ずつ作成する。本文はヒアドキュメントで渡す（改行が壊れるため
`-b` に長文を直接書かない）。

```bash
gh issue create --title "<タイトル>" --label "<ラベル>" --body-file -  <<'BODY'
## 現状
...
BODY
```

`--body-file -` で標準入力から読ませる。`gh` は作成した Issue の URL を返す。

### 7. 報告する

作成した Issue を、番号・タイトル・URL の一覧で返す。重複で見送ったものが
あれば、その既存 Issue 番号も併せて示す。

## やらないこと

- 新しいラベルやマイルストーンを作る
- Issue を閉じる・削除する（このスキルは起票のみ）
- 承認を得ずに `gh issue create` を実行する
- 1 つの Issue に複数の無関係な項目を詰め込む
