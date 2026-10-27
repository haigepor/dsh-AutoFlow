/** Model catalog artwork is embedded by the shared client bundle image loader. */
declare module '*.webp' {
  const url: string
  export default url
}

declare module '*.png' {
  const url: string
  export default url
}

declare module '*.svg' {
  const url: string
  export default url
}
