---
name: article-image-editorial-prompts
description: Understand complete saved article blocks and original images, then write evidence-grounded editorial cover and inline prompts. Use for article image planning and review; not for title-only guessing, arbitrary web research, approval, or image generation.
---

# Editorial image prompts

Read [the understanding rules](references/understanding.md) and [the visual planning rules](references/visual-planning.md). The dedicated analysis runner reads these same files and freezes their contents with its runtime templates. Profile policy is an explicitly configured JSON file; a file edit affects new tasks, while an existing task keeps its frozen rules until explicitly reanalyzed.

Read all assigned saved blocks and actual original-image attachments before submitting. Preserve language, distinguish source claims from observed image facts and editorial interpretation, and attach block/asset evidence. Follow every page and chunk; long articles require full synthesis. Metadata or captions alone do not establish visual understanding. Never report complete understanding after a budget truncation or missing original image.

Use the task's frozen policy for count, ratio, language and style; defaults are one cover and two inline images at 16:9, Chinese explanations and English final prompts. Keep exactly one cover. Replan by content rather than replacing each original. Each inline image needs a different information goal, insertion block and evidence. Read [the plan fields](references/plan-fields.md) before saving the first plan.

Favor realistic stock photography and useful editorial illustration: a clear subject, plausible action, specific environment, deliberate composition, natural light and coherent color. Include relevant physical details and avoid crowding several unrelated scenes into one image. Describe how each image relates to the article. Final prompts should contain enough scene detail to generate the intended picture without passing the whole article to a provider.

Do not invent named places, architectural details, product designs, numerical results or witnessed events. For an article about a specific location, distinguish details supported by its paragraphs from generic conceptual scenery. For news, medicine and finance, keep conceptual illustration separate from documentary evidence; do not describe a generated image as an actual event photograph. Avoid unnecessary logos, misleading charts, decorative text and watermarks. Write avoidance constraints as editorial instructions; do not assume a provider supports a negative_prompt field.

Automatic analysis already saves the understanding, brief and shots for human review. When the user requests edits, read the complete current plan through article_image_plan_page as described in the plan fields; preserve frozen input fields and save only the requested changes. Review all prompts against source evidence and each other. Report a precise shortfall instead of filling counts with duplicates or unsupported facts. A code coverage/reference check is structural validation, not a semantic guarantee. Editing scene fields makes the final prompt pending synchronization. The workbench performs human review; this phase has no image generation, upload, publication or spreadsheet writeback.
