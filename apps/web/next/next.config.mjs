/** @type {import('next').NextConfig} */
const nextConfig = {
  // Web 版は SSR を使える（企画書 §4.3.2）。読み取り専用なので
  // Server Component から読み取り専用トークンで GitHub を叩き、HTML を返す。
  transpilePackages: ["@zukunft/domain", "@zukunft/gantt", "@zukunft/github"],
  reactStrictMode: true,
  webpack: (config) => {
    // GraphQL は Rust 側と共有する単一ソース。文字列として読み込む。
    config.module.rules.push({ test: /\.graphql$/, type: "asset/source" })
    return config
  },
}

export default nextConfig
