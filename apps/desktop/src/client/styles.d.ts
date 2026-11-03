/** Stylesheets bundled by the standalone welcome and update renderers. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css'
