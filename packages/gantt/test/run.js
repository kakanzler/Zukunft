// テストの起動役。packages/github/test/run.js と同じ仕組みを踏襲する。
//
// gantt も @zukunft/domain を実行時に使う。yarn workspaces の
// node_modules/@zukunft/domain は packages/domain を指し、その main はソースの
// .ts なので node は直接読めない。そこで tsconfig.test.json で domain も一緒に
// JS へ落とし、出力ツリーの中だけで @zukunft/domain がそちらへ解決されるように
// する。packages/domain 側に手を入れず、テストの都合をテストの中で閉じるため。
//
// 中身を再エクスポートするファイルを置くのは、main でパッケージの外を指すと
// 新しい node が解決を拒むため。
//
// react / react-dom は shim を要らない。出力ツリーから上へ辿ればワークスペースの
// node_modules に届き、そこにあるのは素の JS だから。
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

require(path.join(out, "packages", "gantt", "test", "smoke.js"))
