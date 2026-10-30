/** Serialize the skill protocol without localizing frontmatter keys. */
/** Create a complete instruction document.
 *
 * @param name - validated kebab-case invocation name.
 *
 * @param description - user-authored routing description.
 *
 * @param body - user-authored Markdown instructions.
 *
 * @returns YAML frontmatter followed by the instruction body.

 */
export function createSkillDocument(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`
}
