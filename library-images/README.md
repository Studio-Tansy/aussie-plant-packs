# Library Images

`library-images.zip` is an optional companion pack for five Aussie Garden Care
library plants. It is intentionally separate from species data, is not part of
the app binary, and maps images only to the canonical species IDs below.

Run this from the repository root to regenerate the release asset:

```sh
node scripts/build-library-images.mjs
```

The build requires `curl`, `ffmpeg`, `zip`, and Node.js. It downloads the
originals into the ignored `library-images/source/` directory, creates
metadata-free JPEG derivatives in the ignored `library-images/build/`
directory, verifies the size/dimension limits, and writes
`library-images/library-images.zip`.

The generated archive contains `_meta/library-image-manifest.json` and an
`images/` directory. The manifest is the attribution record consumed by the
app; do not publish an image unless its source and redistribution licence are
complete in `sources.json`.

| Species ID | Creator | Licence | Source |
|---|---|---|---|
| `peace-lily` | Usha J (UshaJ) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Peace_Lily.JPG) |
| `basil` | Sebastian Stabinger | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Ocimum_basilicum1.jpg) |
| `tomato` | Fyrra | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Tomato_plant.jpg) |
| `kangaroo-paw` | Cygnis insignis | [Public domain](https://creativecommons.org/publicdomain/mark/1.0/) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Anigozanthos_flavidus_Albany_2.jpg) |
| `aloe` | Forest & Kim Starr | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Starr_011104-0040_Aloe_vera.jpg) |

All images are resized and JPEG re-encoded for this offline pack. The basil
and tomato derivatives remain available under CC BY-SA 3.0.
