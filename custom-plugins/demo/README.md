---
description: "Install a copyable DSH bundle with independent instructions, Skill, executable action, Agent tool, and UI switches."
kind: "package-bundle"
---

# dsh-custom-plugin-demo

English | [中文](README.zh.md)

## Summary

Install this npm bundle into one DSH profile, then enable only the features you need in **Plugins**. The demo offers categorized global instructions, a Skill, and scripts/tools shared by an Agent tool and a Settings page button. Every feature starts off. Instructions and Skills use the shared DSH Home, so another profile can see them while any profile has them enabled.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

From the repository root, test the package and install it into an isolated Home:

```powershell
cd D:\project\deepseek-harness\custom-plugins\demo
npm test
npm pack --dry-run
$env:DSH_HOME = Join-Path $env:TEMP 'dsh-demo-check'
cd D:\project\deepseek-harness
pnpm dsh plugin --profile web add 'file:D:/project/deepseek-harness/custom-plugins/demo'
```

The CLI installs with all three optional rows disabled. In the Web **Plugins** page, **Add plugin** accepts the same local path or an npm package spec. Its completed installation screen offers the three features before bundle activation. The detail page groups them as Instructions, Skills, and Scripts and tools, using a matching icon for each type. Later, open the installed card to adjust the choices, including while the bundle is off. The detail page also shows three example prompts on generated artwork; clicking one opens a new Session with an unsent draft. The Settings sidebar item appears only while the bundle is enabled. A profile without live reload may need a restart.

To publish your own copy, change the npm name and all matching identities listed in [architecture](../architecture.md), replace sample content, check the `@deepseek-ai/dsh` peer version, and run `npm test` and `npm pack --dry-run`. Publish the resulting package with `npm publish` only under an npm name you control. Consumers install the published `your-name@version` in **Plugins → Add plugin** or with `dsh plugin --profile web add your-name@version`. This package declares no application `bin`.

### Enable, stop, and remove content

The **Global instructions** and **Example Skill** choices are independent. A selected prompt row adds only the marked block to `$DSH_HOME/AGENTS.md`; a selected Skill row exposes only its owned directory under `$DSH_HOME/skills`. The last active profile to release a feature moves its content into `$DSH_HOME/.managed-plugins/dsh-custom-plugin-demo/inactive/`, outside the scan paths. Re-enable restores that copy, including edits made inside owned content. The Settings page can permanently remove an inactive copy after all profiles have released it. It never deletes unrelated AGENTS text or another Skill directory.

The **Demo operation** choice registers `custom_plugin_demo` and enables the same script from the Settings button. Disable the bundle to unload its Client UI, Host action, and Agent tool while keeping feature selections. Start a new conversation to check that stopped instructions and tools are absent from model input; previous conversation history remains.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the root Client/management row plus independent prompt, Skill, and execution rows. [`package.json`](package.json) declares those rows as selectable features, the Client entry, localized metadata, example prompts, and packed assets. [`managed-content.js`](managed-content.js) stores per-process profile leases and inactive copies; [`execute.js`](execute.js) owns the operation shared through the plugin manager Remote. [`client.js`](client.js) contributes the Settings view; the manager renders bundle details without a duplicate status panel. The cross-bundle rules are in [architecture](../architecture.md).

</details>

-----

<a id="model-experience"></a>
## Model Experience

With the execution row enabled, an Agent can call `custom_plugin_demo` and receive the bundled script's text output. With the prompt or Skill row enabled, a new request can load their content through the normal DSH global-memory and Skill providers. Existing session history is not rewritten on disable.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

The shared `$DSH_HOME` has no profile isolation for prompt and Skill scanning. The manager refuses marker damage, a same-name Skill collision, and deletion while another process owns a feature. Resolve a conflict in the reported path, then retry. Replacing installed JavaScript may require restarting the profile. The demo operation is intentionally harmless sample output; replace its script and tool description before distribution.

<a id="dev-note"></a>
## Dev Note

None.
