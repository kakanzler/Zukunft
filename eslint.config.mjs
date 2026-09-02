// React のフック規則だけを見る Lint。
//
// 全面的な推奨ルールは入れない。ここにある 2 つは「壊れ方が静かで、レビューでは
// まず気づけない」欠陥を捕まえるためのもので、体裁の統一とは目的が違う。
// 実際、依存配列に不安定なオブジェクトを入れていたせいで、操作していない間も
// GitHub を叩き続ける無限ループが起きていた。exhaustive-deps があれば書いた時点で
// 分かっていた。
import parser from "@typescript-eslint/parser"
import reactHooks from "eslint-plugin-react-hooks"

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/out/**",
      "**/target/**",
      "**/.test-out/**",
    ],
  },
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
    languageOptions: {
      // 型情報は使わない。TS / TSX を構文として読めれば足りる。
      parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
]
