# Library Images

Optional library-image packs provide licensed offline reference images keyed
only by canonical Aussie Garden Care species IDs. They remain separate from
species data and are never used as a person's own plant photo.

## Files

- `catalog.json` is a deterministic snapshot of every non-seed canonical
  species record used for this research pass.
- `sources.json` preserves the five manually reviewed pilot sources, including
  their published source SHA-256 pins.
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

The research script first requires an exact `scientificName` match to Wikidata
taxon name property P225 and prefers a Commons P18 image. Its fallback uses a
direct file in a Wikimedia Commons category whose title exactly matches the
scientific name. An alias/category redirect is accepted automatically only
when the original name also has one unique exact Wikidata taxon entity; the
redirect target and rationale are retained in the record.

Common-name-only results, multiple exact Wikidata entities, and unconfirmed
category redirects are never released automatically. They remain
`review-needed` or `unresolved` with a Commons research URL. API responses and
downloaded source bytes are cached locally so reruns are rate-limit friendly.
Use `--refresh` only when deliberately re-researching upstream metadata.

Only Public Domain, CC0, CC BY, and CC BY-SA sources are accepted. Every
matched record captures creator, licence, licence URL, Commons source page,
source download URL, and a SHA-256 of the exact downloaded bytes.

## Build and validate

The build requires Node.js, `curl`, `ffmpeg`, `zip`, and `unzip`:

```sh
node scripts/build-library-images.mjs
node scripts/validate-library-images.mjs
node scripts/validate-with-app-manifest.mjs --app-root /path/to/garden-tracker
```

Use `--pack <pack-id>` to rebuild one already planned pack. The original
`library-images.zip` pilot remains unchanged in identity and membership.
Additional outputs use stable category/chunk IDs such as
`library-images-native-01`.

All output images are JPEG, have metadata removed, are at most 2,048 pixels on
either axis, and are at most 512 KiB. Pack chunks target 20 MiB of image data
so both the compressed archive and expanded payload remain safely below the
app's 24 MiB archive / 25 MiB expanded limits. The validator checks the same
manifest fields, paths, image byte lengths, dimensions, duplicate rules, and
pack budgets enforced by the app contract.

## Review boundary

`automated-exact` means that the botanical link is based on an exact structured
scientific-name/category relationship, not that a person has reviewed the
photo composition. `human-reviewed` is currently reserved for the published
five-image pilot and future explicit overrides. Never change a
`review-needed` or `unresolved` record to `matched` without documenting the
taxonomic rationale and confirming the redistribution licence.
