/** Strict model JSON decoding with an optional, complete Markdown code enclosure. */

/** @param text Exact provider text. @returns Parsed JSON; surrounding prose, incomplete fences and damaged JSON remain errors. */
export function parseModelJson(text: string): unknown {
  const value = text.trim()
  const fenced = /^(`{3,})(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n\1$/iu.exec(value)
  // 只去掉完整外层围栏；不补括号、不截取正文片段，也不修改模型字段。
  return JSON.parse(fenced ? fenced[2]! : value)
}
