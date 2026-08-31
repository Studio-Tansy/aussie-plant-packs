# Aussie Plant Packs

Curated, offline plant-pack data for the Aussie Garden Care app (https://aussie-garden-care.vercel.app).

Each species `<category>.zip` in the [v1 release](../../releases/tag/v1) contains one
`docs/plant-schema.json`-conformant species JSON file per distinct plant, generated
from real nursery product listings and mapped onto the closest matching species
(cultivars/near-duplicates are lumped onto one file unless their care genuinely
differs). A `_meta/mapping.json` and `_meta/mapping.md` inside each zip record which
raw nursery names mapped to which species, and which were excluded as unidentifiable
or assorted multi-plant packs.

## Species packs

| Pack | Species count |
|---|---|
| `herb.zip` | 23 |
| `fruit.zip` | 43 |
| `vegetable.zip` | 51 |
| `indoor.zip` | 75 |
| `native.zip` | 121 |
| `succulent.zip` | 61 |
| `uncategorized-edible.zip` | 196 |
| `flower.zip` | 143 |
| `ornamental.zip` | 647 |

## Optional library image pack

`library-images.zip` provides five licensed, offline reference images for
canonical library species. It is deliberately a separate opt-in download:
species-pack "Download All" actions never include it, and the app never stores
these replaceable catalog assets as a person's garden photo or in a backup.

Its archive contract, sources, reproducible build, and attribution records are
in [`library-images/`](library-images/README.md).

## Consuming this data

The Aussie Garden Care app resolves configured pack downloads at the stable,
pinned `v1` release URL and makes at most one metadata check per app session
against `GET /repos/Studio-Tansy/aussie-plant-packs/releases/latest` for update
hints. This repo has no runtime code — it exists purely to host versioned
release assets.

`maxTemp_C` and `chillHours` are intentionally left unset across every species
file — see the main repo's `AGENTS.md` for the no-estimation policy this data
follows.
