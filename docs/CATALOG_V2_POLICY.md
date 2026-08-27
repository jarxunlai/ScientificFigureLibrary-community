# Catalog v2 policy bootstrap

This policy bootstrap adds the v2 schemas and trusted validators without
changing the current zero-entry v1 Catalog bytes. A later manually reviewed PR
performs the one-time migration.

## Exact content PR modes

### Addition

Exactly three paths are added:

```text
catalog/entries/<id>/<version>.json
catalog/thumbs/<id>/<version>.png
reviews/<id>/<version>.md
```

Exactly four paths are modified:

```text
catalog/catalog.json
catalog/entries.jsonl
catalog/previews.jsonl
catalog/preview-manifest.json
```

The release must be new, active, absent from the retired ledger, pinned to one
merged Archive commit/path/bytes/SHA-256, and fully represented by the
standalone entry and both canonical JSONL collections.

### Withdrawal

Exactly one path is added:

```text
withdrawals/<id>/<version>/reason.txt
```

Exactly four paths are modified:

```text
catalog/catalog.json
catalog/entries.jsonl
catalog/entries/<id>/<version>.json
reviews/<id>/<version>.md
```

All immutable entry fields, preview JSONL/manifest, thumbnail and Archive are
unchanged. The reason is fully streamed, incrementally UTF-8 decoded and
scanned, and fixed by byte length/SHA-256. There is no product total-length cap.

### One-time migration

Migration is accepted only when the trusted base is the healthy zero-entry v1
snapshot and the candidate is a zero-entry v2 snapshot with exactly the fixed
three-identity retired trust floor. It adds only the three JSONL files and two
directory keepers, removes only obsolete root `thumbs/.gitkeep`, and modifies
only the two v1 aggregate control files. It restores no entry, thumbnail,
review, or template bytes.

## Retired trust floor

The migration ledger contains these identities in canonical order:

```text
ggsankeyfier-layout-color-combo@1.0.0
single-cell-enrichment-bar-pathway-genes@1.0.0
umap-unchull-main-type-circles@1.0.0
```

Every later v2 snapshot contains an unchanged superset. Addition cannot reuse a
retired identity. Withdrawal does not edit the ledger. The policy exposes no
physical deletion mode.

## Trust and workflow

The stable required check is `sfl-community-catalog-policy-v1`. The workflow
installs only the exact dependencies pinned by the trusted base lockfile, then
executes the trusted Draft 2020-12 schemas and cross-file semantic validators
against an untrusted candidate. Candidate code and dependencies are never
executed. For additions, the fixed Archives `main` observation must still
contain the exact Git blob pinned by the immutable Archive commit, so an
Archive path that was later deleted or replaced cannot enter the Catalog.
Policy changes are
separate maintainer PRs and are expected to be rejected by the pre-bootstrap
content tree policy until a human reviews and manually merges the bootstrap.

Repository-owner trust is explicit: administrators have `always` bypass,
signed commits are not required, merge/squash/rebase are allowed, and no tool
auto-merges or auto-bypasses.
