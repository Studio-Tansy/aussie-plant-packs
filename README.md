# Aussie Plant Packs

Curated, offline plant-pack data for [Garden Tracker](https://github.com/akeelrehman/garden-tracker).

Each `<category>.zip` in the [latest release](../../releases/latest) contains one
`docs/plant-schema.json`-conformant species JSON file per distinct plant, generated
from real nursery product listings and mapped onto the closest matching species
(cultivars/near-duplicates are lumped onto one file unless their care genuinely
differs). A `_meta/mapping.json` and `_meta/mapping.md` inside each zip record which
raw nursery names mapped to which species, and which were excluded as unidentifiable
or assorted multi-plant packs.

## Packs

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

## Consuming this data

The Garden Tracker app fetches the **latest release** at runtime
(`GET /repos/akeelrehman/aussie-plant-packs/releases/latest`) to list available
packs and download the ones the user selects. This repo has no runtime code —
it exists purely to host versioned release assets.

`maxTemp_C` and `chillHours` are intentionally left unset across every species
file — see the main repo's `AGENTS.md` for the no-estimation policy this data
follows.
