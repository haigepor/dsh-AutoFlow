# Saved plan fields

Call article_image_save_plan with the real id, current revision and a plan object. The plan contains sourceHash, brief and shots. The brief has theme (string) and facts, subjects, scenes (nonempty arrays of strings).

Each shot contains purpose (cover or inline), paragraphs (nonempty array of real positive paragraph ids), rationale, subject, action, environment, composition, lighting, colors, style, details, avoid, prompt (nonempty strings), and ratio (16:9, 4:3, 3:2, 1:1 or 9:16). Include exactly one cover and at most twelve shots. Do not add provider request fields or internal identifiers. The tool schema is authoritative for accepted fields and sizes.

The final prompt combines the subject, action, environment and visual treatment in natural English. Explain relevance in rationale, not in the scene as visible lettering. Use avoid for unsuitable or misleading elements; the provider adapter will translate supported controls after a real interface is connected.
