/** @type {import('next').NextConfig} */
const nextConfig = {
  // Tauri はローカルの静的アセットを WebView で読むため、静的エクスポートにする。
  // SSR / Server Actions / Route Handlers / ISR / 画像最適化 API は使えない（企画書 §4.3.2）。
  output: "export",
  images: { unoptimized: true },
  transpilePackages: ["@zukunft/domain", "@zukunft/gantt", "@zukunft/github"],
  reactStrictMode: true,
  webpack: (config) => {
    // GraphQL は Rust 側と共有する単一ソース。文字列として読み込む。
    config.module.rules.push({ test: /\.graphql$/, type: "asset/source" })
    return config
  },
}

export default nextConfig
