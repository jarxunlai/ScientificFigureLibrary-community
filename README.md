# Scientific Figure Library Community

Curated, source-controlled catalog metadata for public Scientific Figure Library templates.

This repository stores catalog entries, thumbnails, review records, schemas, and publisher guidance. Immutable template ZIP files live in [`jarxunlai/ScientificFigureLibrary-community-archives`](https://github.com/jarxunlai/ScientificFigureLibrary-community-archives).

## Two-stage publication gate

1. Submit one immutable archive to the Archives repository.
2. Wait for human review and manual merge.
3. Submit the catalog entry pinned to the Archives merge commit, path, byte length, and SHA-256.
4. Wait for a second human review and manual merge.

No tool, workflow, or MCP server in this project automatically merges either pull request.

## Restricted emergency withdrawal

The normal publication contract remains append-only: one immutable release is added per Catalog PR and an existing public identity is never edited in place. A separately reviewed, maintainer-authored policy permits one exceptional, atomic withdrawal of exactly these three seed releases:

```text
ggsankeyfier-layout-color-combo@1.0.0
single-cell-enrichment-bar-pathway-genes@1.0.0
umap-unchull-main-type-circles@1.0.0
```

The exception is bound to the pre-reviewed Git blob identities. It succeeds only when all three standalone entries, reviews, and thumbnails disappear together and both aggregate files become the matching empty snapshot. It rejects partial withdrawal, additions, and workflow, schema, policy, or unrelated byte drift. Removing the releases from the current Catalog does not rewrite Git history or claim that previously installed snapshots cease to exist.

## Trust boundary

The central catalog is not fetched at SFL startup. A reviewed catalog snapshot, preview manifest, thumbnails, licenses, and `source.lock.json` are vendored into a specific SFL plugin release. Installing that plugin release is the trust and update boundary.

## Licenses

- Repository tooling and schemas: [MIT](LICENSE)
- Vendored public-template code license: [MIT](LICENSES/MIT.txt)
- Synthetic data, generated previews/thumbnails, and documentation unless
  stated otherwise: [CC BY 4.0](LICENSES/CC-BY-4.0.txt)
- Each submitted template declares its own code and content licenses; a catalog entry never overrides an archive's declarations.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
