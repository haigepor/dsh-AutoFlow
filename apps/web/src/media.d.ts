/** Vite resolves the packaged startup video into an asset URL. */
declare module '*.mp4?url' {
  const url: string
  export default url
}
