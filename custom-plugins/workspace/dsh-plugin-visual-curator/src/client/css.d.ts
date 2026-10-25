/** Bundled stylesheet text is mounted only by its owning Client lifecycle. */
declare module '*.css' { const text: string; export default text }
/** The welcome illustration is embedded by the Client bundler. */
declare module '*.webp' { const url: string; export default url }
/** The workspace logo is embedded by the Client bundler. */
declare module '*.png' { const url: string; export default url }
