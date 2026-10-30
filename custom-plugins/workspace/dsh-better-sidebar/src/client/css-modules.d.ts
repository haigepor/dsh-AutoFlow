/** CSS Modules class-map declaration (tsdown compiles .module.css at build). */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
/** Plain stylesheets are installed by the client bundle. */
declare module '*.css'
