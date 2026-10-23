/** Bundled stylesheet text is mounted only by its owning Client lifecycle. */
declare module '*.css' { const text: string; export default text }
