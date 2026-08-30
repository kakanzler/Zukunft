/** `.graphql` は webpack の asset/source として文字列で読み込む。 */
declare module "*.graphql" {
  const source: string
  export default source
}
