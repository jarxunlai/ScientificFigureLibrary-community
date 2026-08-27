# Scientific Figure Library Community

Curated, source-controlled catalog metadata for public Scientific Figure Library templates.

This repository stores catalog entries, thumbnails, review records, schemas, and publisher guidance. Immutable template ZIP files live in [`jarxunlai/ScientificFigureLibrary-community-archives`](https://github.com/jarxunlai/ScientificFigureLibrary-community-archives).

## Two-stage publication gate

1. Submit one immutable archive to the Archives repository.
2. Wait for human review and manual merge.
3. Submit the catalog entry pinned to the Archives merge commit, path, byte length, and SHA-256.
4. Wait for a second human review and manual merge.

No tool, workflow, or MCP server in this project automatically merges either pull request.

## Catalog v2 lifecycle

The policy supports three mutually exclusive content PR shapes after the
separate policy bootstrap is merged:

- one v2 release addition: exactly 3 additions and 4 aggregate modifications;
- one metadata-only `active -> withdrawn` transition: exactly one immutable
  reason addition and 4 metadata/review modifications;
- one exact migration of the current healthy zero-entry v1 snapshot to v2.

Content PRs may not delete a file. Withdrawn releases keep their immutable
archive and thumbnail. The three pre-v2 physically redacted identities are
recorded only in the v2 append-only retired ledger and can never be reused.
The validator no longer contains any physical release-deletion capability.

This policy bootstrap does not itself migrate `catalog/catalog.json`; the
repository remains a healthy zero-entry v1 snapshot until a separately
reviewed exact migration PR is manually merged.

## Trust boundary

SFL 0.7 may activate a verified cached Community snapshot after startup while
retaining a bundled offline fallback. The selected trust model is GitHub
repository owner trust. Normal-flow rulesets and the stable
`sfl-community-catalog-policy-v1` check are defense in depth; administrators
may always bypass. This repository does not claim an independent central
signature or an unbypassable PR/check chain. Tools never merge automatically.

## Licenses

- Repository tooling and schemas: [MIT](LICENSE)
- Public-template code: [MIT](LICENSES/MIT.txt),
  [Apache-2.0](LICENSES/Apache-2.0.txt),
  [BSD-3-Clause](LICENSES/BSD-3-Clause.txt), or
  [GPL-3.0](LICENSES/GPL-3.0.txt)
- Synthetic data, generated previews/thumbnails, and documentation:
  [CC-BY-4.0](LICENSES/CC-BY-4.0.txt),
  [CC0-1.0](LICENSES/CC0-1.0.txt), or
  [CC-BY-SA-4.0](LICENSES/CC-BY-SA-4.0.txt)
- Each submitted template declares its own code and content licenses; a catalog entry never overrides an archive's declarations.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
