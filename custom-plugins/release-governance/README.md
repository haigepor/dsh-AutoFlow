# Plugin and Desktop release governance

English | [中文](README.zh.md)

## Summary

Plugins and Desktop share a source repository but publish independently. A version tag identifies one product's frozen source; a public Release contains that product's verified installable assets. Development milestones belong in Git history, PRs or Actions artifacts. The [AFP release guide](../workspace/dsh-plugin-afp/release/README.md) owns plugin publication; the [Desktop guide](../../apps/desktop/README.md) owns packaging, signing and production uploads.

## Product families

| Product | Version authority | Tag | Assets and update selection |
|---|---|---|---|
| AFP | AFP `package.json` | `afp-v<semver>` | `.tgz`, `SHA256SUMS`, `afp-update.json`; plugin checks only its declared stable tag family |
| Another custom plugin | Its package manifest | `<plugin>-v<semver>` | Its own tarball, checksum and metadata asset |
| Desktop | Desktop build version | `desktop-v<version>` | Signed installer, update manifest and matching update artifacts; current production delivery uses Tencent COS |
| DSH npm packages | Existing upstream workflow | `dsh-v<version>` | npm package publication; this workflow does not publish Desktop installers |

AFP and Desktop may use different version numbers and release dates. Publishing only AFP does not require rebuilding or publishing Windows; publishing Windows can retain the previously bundled AFP version. A carrier must first ship the runtime updater before its users can update AFP independently. AFP Releases use `latest=false`: GitHub's repository-wide latest Release cannot represent every product family. A Desktop GitHub Release is a distribution record, not a replacement for the current signed COS update feed.

## Release procedure

1. Select one product, new version and reviewed source commit. Check its existing tags and Releases; never reuse a public version or move its tag.
2. Update that product's changelog, paired guides and version declaration. Run its focused tests and package checks; build the exact clean source to be released.
3. Prepare a draft with explicit product name, version, source tag, changes, configuration/data migration, restart requirements, assets, supported platforms and known limitations. Verify hashes and byte counts before publication.
4. Publish through that product's workflow. AFP tags trigger the AFP workflow. Desktop follows signing, package validation and production upload; its existing uploader records the Desktop tag after production upload succeeds. A GitHub Desktop Release is published only after installer assets are available and verified.
5. Plugin delivery finishes by default after the publication workflow succeeds and the public Release has the correct source tag and uploaded assets; download verification, isolated profiles and update rehearsals run only when requested or diagnosing failures. Desktop still follows its release guide for installer, signature and update-asset verification. Preserve frozen assets and correct defects with a new version.

Release titles use `AFP <version>` or `Desktop <version>`. Notes describe only the selected product; shared-source changes belong only when they affect its artifact. Do not publish an assetless Release for a code milestone, and do not treat GitHub's automatic source archives as plugin packages or installers. Preview builds use Actions artifacts; an explicitly distributed preview may use a clearly marked prerelease with real assets and a separate update channel.

## Milestones and tag names

Formal distributions use product tags `afp-v<semver>`, `<plugin>-v<semver>` or `desktop-v<version>`. Source milestones use `milestone/<subject>-<version-or-yyyymmdd>` and have no Release. Record only long-lived references such as upstream integrations and visual baselines; ordinary feature changes remain Git commits.

Use annotated tags for milestones. Notes identify the purpose, upstream commit and actual package version, local source commit, implemented features and fixes, retained customizations, checks actually run and their failures or unverified areas, and future integration or recovery use. Base historical descriptions on the original commit and check records; do not add capabilities or verification completed later. Before editing notes, save the original tag object, update with a lease against its exact remote object, and keep the peeled commit unchanged. Formal product tags and assets remain frozen.

| Retained tag | Milestone |
|---|---|
| `afp-v0.1.0` | First formal AFP bundle, with frozen assets and source |
| `milestone/upstream-v0.1.7-rc.2` | Earlier upstream integration and old upstream comparison point |
| `milestone/settings-ui-20260928` | Settings page and AutoFlow visual baseline |
| `milestone/upstream-v0.2.0-rc.1` | Upstream rc.1 integration |
| `milestone/pre-upstream-v0.2.0-rc.2` | Custom rollback point before rc.2 integration |

The remote Release inventory contains only the formal AFP distribution; source drafts have been deleted. The old `autoflow-*` tags have been reorganized within the authorized scope. Removed milestones' commits remain in `main` history, and exact original tag objects remain in the local backup. Historical comparison and rollback commands use the tags above; frozen Agent Notes retain their original records.

<a id="update-acceptance"></a>

## Update acceptance

Real remote installation tests use an independent `afp-test-v<semver>` family, clean isolated source and isolated `DSH_HOME`. Only the test checkout changes its release configuration and installation-owned update declaration to that family; the production `afp-v` source remains unchanged. Publish a temporary Release with all three real assets and `latest=false`. Testing stable selection in that family requires a stable tag; simply marking the test Release as a prerelease prevents selection. Manual installation and explicitly enabled automatic installation both verify restart application, consistent Host/Client/patch selection, retained configuration and failure restoration.

After testing, delete the temporary Release, Tag, profile, cache, downloaded packages and worktree. Recheck formal asset digests and remote references. Retain a concise acceptance record and historical tag backups. Published test packages also require committed, clean source matching their metadata.

## Recovery

Before reorganization, back up full Release JSON, exact tag objects, peeled commits, the name mapping and a verifiable Git bundle. Read the remote again before changing it; stop on concurrent movement rather than overwriting it. Delete old references, recreate important same-commit tags from the mapping, update current documentation references and verify the final inventory. A recreated formal product tag must restore the same object without moving its version or replacing assets; release fixes still require a new version.

Restore original tags from saved objects or the bundle. Check for new same-named remote references first and never overwrite them. Remote deletion is an explicitly authorized governance or temporary-acceptance operation; routine updates do not delete existing tags. Package downgrades require an explicitly supported migration; configuration or data changes may prevent downgrade.

## Dev Note

None.
