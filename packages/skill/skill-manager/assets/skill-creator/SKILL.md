---
name: skill-creator
disable-model-invocation: true
description: Create or revise reusable DSH skills, including SKILL.md instructions, supporting resources and practical validation. Use when a user asks to build a skill or turn a repeatable workflow into one; do not use merely to carry out an existing skill's task.
---

# Skill creator

Create the smallest reusable skill that reliably guides the intended task. Follow the current conversation language and the selected workspace's instructions.

## Understand the task

Read the user's requirements and relevant existing skills. Establish the intended result, when the skill should apply, and nearby tasks it should leave to another skill. Reuse information already supplied. Ask only for missing decisions that materially change the workflow or output.

For a new skill, use the selected workspace's `.agents/skills/<name>/SKILL.md` unless the user requests another native skill root. For revisions, preserve the existing skill name and location. Inspect existing files before writing; do not overwrite unrelated work.

## Write the skill

Use UTF-8 Markdown with YAML frontmatter. `name` is a lowercase kebab-case identifier matching the folder. `description` states concrete trigger situations and relevant exclusions. The instruction body explains the required inputs, ordered actions, expected output, verification and failure handling. Do not place essential execution guidance only in the description.

```markdown
---
name: project-review
description: Review this project's changes against its documented conventions and report actionable findings. Use for review requests, not for implementing an unrelated feature.
---

# Project review

Read the requested changes and the applicable project rules. Report specific, reproducible findings with affected paths and verification evidence.
```

Use `scripts/` for repeatable deterministic helpers, `references/` for detailed material loaded on demand, and `assets/` for output templates. Keep SKILL.md focused and link every supporting file that the workflow needs. Avoid unnecessary dependencies and framework-specific commands that are not available in the current session.

Optional invocation controls are `disable-model-invocation: true` for user-only skills and `user-invocable: false` for model-only skills. Preserve existing restrictions when revising a skill. Do not add tools or expand permissions merely by listing them in a skill.

## Validate and deliver

Check frontmatter, matching names, relative resource links, UTF-8 and final newline. Run a practical example when the available environment permits, and a nearby negative example when trigger overlap is a concern. Evaluate reusable behavior rather than one memorized prompt. Do not invent execution results or require a full benchmark for a small skill.

Summarize the created files, intended trigger, validation actually performed and remaining limitations. Refer to the resulting native skill directory so the user can inspect it in Skills settings. Ask before a separately requested publish, install into another user's directory, or replacement outside the agreed target.
