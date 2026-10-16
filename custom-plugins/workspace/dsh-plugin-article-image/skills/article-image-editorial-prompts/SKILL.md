---
name: article-image-editorial-prompts
description: Understand article facts and write realistic editorial cover and inline image prompts grounded in saved numbered paragraphs. Use after reading article text, not for title-only guessing or executing image generation.
---

# Editorial image prompts

Read the complete saved article first. Preserve its language and distinguish stated facts from interpretation. Write a brief containing theme, facts, subjects and scenes. Use the user's language for the explanation; default to Chinese explanations and English final image prompts when the request provides no other preference.

Default to one cover and two inline images at 16:9, adapting the requested count and ratio when specified. Keep exactly one cover. The cover expresses the article's overall theme; inline images each illustrate a different important paragraph. Use paragraph ids returned by article_image_article. Read [the plan fields](references/plan-fields.md) before saving the first plan.

Favor realistic stock photography and useful editorial illustration: a clear subject, plausible action, specific environment, deliberate composition, natural light and coherent color. Include relevant physical details and avoid crowding several unrelated scenes into one image. Describe how each image relates to the article. Final prompts should contain enough scene detail to generate the intended picture without passing the whole article to a provider.

Do not invent named places, architectural details, product designs, numerical results or witnessed events. For an article about a specific location, distinguish details supported by its paragraphs from generic conceptual scenery. For news, medicine and finance, keep conceptual illustration separate from documentary evidence; do not describe a generated image as an actual event photograph. Avoid unnecessary logos, misleading charts, decorative text and watermarks. Write avoidance constraints as editorial instructions; do not assume a provider supports a negative_prompt field.

Review all prompts against the source and each other, then save the brief and shots together. Do not fill a requested count with near-duplicate images or unsupported facts. Saving requires a real article hash and current revision. Approval and image generation are separate workbench operations.
