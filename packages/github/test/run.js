// テストの起動役。
//
// mapping.ts は @zukunft/domain を実行時にも使う。yarn workspaces の
// node_modules/@zukunft/domain は packages/domain を指し、その main は
// ソースの .ts なので node は直接読めない（ESM 解決で拡張子なしの相対 import に
// 失敗する）。
//
// そこで tsconfig.test.json で domain も一緒に JS へ落とし、出力ツリーの中だけで
// @zukunft/domain がそちらへ解決されるようにする。packages/domain 側に手を入れず、
// テストの都合をテストの中で閉じるため。
//
// 中身を再エクスポートするファイルを置くのは、main でパッケージの外を指すと
// 新しい node が解決を拒むため。
const fs = require("node:fs")
const path = require("node:path")

const out = path.join(__dirname, "..", ".test-out")
const shim = path.join(out, "node_modules", "@zukunft", "domain")
fs.mkdirSync(shim, { recursive: true })
fs.writeFileSync(
  path.join(shim, "package.json"),
  JSON.stringify({ name: "@zukunft/domain", main: "index.js" }),
)
fs.writeFileSync(
  path.join(shim, "index.js"),
  'module.exports = require("../../../packages/domain/src/index.js")\n',
)

require(path.join(out, "packages", "github", "test", "smoke.js"))
