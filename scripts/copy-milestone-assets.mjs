// マイルストーンのアイコンを、正本から各 Next アプリの public/ へ配る。
//
// 絵の正本はリポジトリ直下の asset/milestone/（外側 1 枚 + 内側 10 色）。
// Next は public/ の下にあるものしか URL で配れないのに、両アプリが同じ絵を
// 使う。手でコピーして二重管理すると、片方だけ古い絵が残っても気づけない
// （SVG の中身を目で比べることになる）ので、dev / build の前に毎回ここから配る。
//
// aseprite（作図の元データ）は配らない。ブラウザが読めるものではなく、
// 配っても成果物が太るだけ。
//
// 新しい依存は入れない。node 標準の fs だけで足りる分量なので、
// このスクリプトのためにパッケージを 1 つ増やす理由が無い。
import { cpSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, "asset", "milestone")
const targets = [
  join(root, "apps", "desktop", "next", "public", "milestone"),
  join(root, "apps", "web", "next", "public", "milestone"),
]

const files = readdirSync(source).filter((name) => name.endsWith(".svg"))
if (files.length === 0) {
  // 1 枚も無いのに黙って成功すると、盤面の菱形が丸ごと消えた理由を
  // 画面の側から探すことになる。
  console.error(`copy-milestone-assets: ${source} に .svg がありません`)
  process.exit(1)
}

for (const target of targets) {
  mkdirSync(target, { recursive: true })
  for (const name of files) {
    cpSync(join(source, name), join(target, name))
  }
}

console.log(`copy-milestone-assets: ${files.length} 件を ${targets.length} か所へ配りました`)
