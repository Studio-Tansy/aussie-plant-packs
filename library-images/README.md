# Library Images

Optional library-image packs provide licensed offline reference images keyed
only by canonical Aussie Garden Care species IDs. They remain separate from
species data and are never used as a person's own plant photo.

## Files

- `catalog.json` is a deterministic snapshot of every non-seed canonical
  species record used for this research pass.
- `sources.json` preserves the five manually reviewed pilot sources, including
  their published source SHA-256 pins.
- `taxon-name-overrides.json` records the small, human-reviewed set of catalog
  spelling or nomenclatural corrections, with GBIF evidence and rationale.
- `research-manifest.json` contains one record for every catalog species.
  `matched` records are eligible for release; `review-needed` and `unresolved`
  records are explicitly excluded from builds.
- `packs/index.json` records the generated pack IDs, image counts, byte sizes,
  and archive SHA-256 values. ZIP files beside it are release artifacts and are
  intentionally ignored by git.
- `source/`, `cache/`, and `build/` are ignored working directories.

## Reproduce the research

Export the canonical catalog directly from the app repository:

```sh
node scripts/export-library-image-catalog.mjs \
  --catalog-root /path/to/garden-tracker/src/assets/library
```

Research exact botanical matches and pin the selected source bytes:

```sh
node scripts/research-library-images.mjs --research-date YYYY-MM-DD
```

The research script starts with an exact `scientificName` match to Wikidata
taxon name property P225 and prefers a Commons P18 image. It then checks direct
and recursive Commons taxon categories, exact metadata, and strict tokenized
filenames. GBIF Backbone exact-name resolution can connect catalog synonyms to
accepted names and can supply additional scientific synonyms for the same
accepted usage. Every accepted-name or synonym relationship is retained in the
record.

Remaining exact taxa are researched against active iNaturalist taxa and
research-grade observations whose individual photos have compatible licences.
As a final exact-taxon fallback, the script can use compatible-licence GBIF
occurrence media, preferring human observations over living or preserved
specimens and retaining the occurrence, dataset, taxon, and original licence
evidence. No runtime hotlinks are produced: selected bytes are downloaded,
SHA-256 pinned, normalized, and packaged locally.

Cultivars are accepted automatically only when the Commons filename contains
every substantive botanical-name and cultivar-name token. Punctuation and rank
markers may be normalized, but botanical or cultivar words may not be
substituted. Broader hybrid groups and generic names remain unresolved.

Common-name-only results, fuzzy taxon matches without a committed reviewed
override, multiple exact Wikidata entities, and unconfirmed category redirects
are never released automatically. They remain `review-needed` or `unresolved`
with an explicit reason. API responses and downloaded source bytes are cached
locally so reruns are rate-limit friendly. Use `--refresh` only when
deliberately re-researching upstream metadata.

The 2026-09-08 catalog pass contains 2,341 explicit outcomes: 2,153 matched,
zero review-needed, and 188 unresolved. Of the matched records, 2,143 are
automated exact structured matches and ten are human reviewed: the five
published pilot records plus five documented taxon-name corrections. These
counts are not a claim of full image coverage; only `matched` records appear in
generated packs.

Only Public Domain, CC0, CC BY, and CC BY-SA sources are accepted. Every
matched record captures creator, licence, licence URL, source page, source
download URL, and a SHA-256 of the exact downloaded bytes.

## Build and validate

The build requires Node.js, `curl`, `ffmpeg`, `zip`, and `unzip`:

```sh
node scripts/build-library-images.mjs
node scripts/validate-library-images.mjs
node scripts/validate-with-app-manifest.mjs --app-root /path/to/garden-tracker
```

Use `--pack <pack-id>` to rebuild one already planned pack only after a
successful full build against the same catalog and research manifest. Before
retaining any other archive, the builder verifies its archive hash, indexed
catalog/research identity, exact manifest species membership, and aggregate
source-pin digest; if anything is stale or missing, the selective build stops
and requires a full build. The original `library-images.zip` pilot remains
unchanged in identity and membership.
Additional outputs use stable category/chunk IDs such as
`library-images-native-01`. The current matched set produces 35 packs
(including the pilot), covering 2,153 species. `packs/index.json` is the
authoritative pack ID, count, size, and SHA-256 inventory.

All output images are JPEG, have metadata removed, are at most 2,048 pixels on
either axis, and are at most 512 KiB. Pack chunks target 20 MiB of image data
so both the compressed archive and expanded payload remain safely below the
app's 24 MiB archive / 25 MiB expanded limits. The validator checks the same
manifest fields, paths, image byte lengths, dimensions, duplicate rules, and
pack budgets enforced by the app contract. The release index pins the catalog
SHA-256 and complete research-manifest SHA-256; each pack entry also pins a
deterministic digest of its ordered species IDs and researched source
SHA-256 values. This keeps the strict app manifest-v1 shape unchanged while
making retained archives provably tied to current research.

## Review boundary

`automated-exact` means that the botanical link is based on an exact structured
scientific-name/category relationship, not that a person has reviewed the
photo composition. `human-reviewed` is reserved for the published five-image pilot and committed
taxon-name overrides whose rationale and authority URLs have been checked.
Never change a
`review-needed` or `unresolved` record to `matched` without documenting the
taxonomic rationale and confirming the redistribution licence.
