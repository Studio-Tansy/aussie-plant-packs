# Reviewing Library Image Matches

Use this checklist before promoting any `review-needed` record:

1. Confirm the catalog `scientificName` and the accepted taxon name using a
   botanical authority. Do not rely on visual similarity or a shared common
   name.
2. If the source uses a synonym, record both names and explain the accepted
   synonym/alias relationship in `matchRationale`.
3. Confirm that the source page identifies the same taxon and that the image is
   useful as a plant reference rather than a range map, logo, or unrelated
   object.
4. Accept only Public Domain, CC0, CC BY, or CC BY-SA terms that permit
   redistribution and adaptation. Record the creator, exact licence label,
   licence URL, source page URL, and source download URL.
5. Download the selected source, calculate its SHA-256, and keep the source
   bytes only in the ignored `library-images/source/` directory.
6. Set `reviewLevel` to `human-reviewed`, use a specific `matchMethod`, and
   explain the evidence in `matchRationale`.
7. Run the full builder and validator. A source SHA mismatch requires a new
   rights and identity review; never update the hash blindly.

Records left unresolved are valid research outcomes. They must remain explicit
and must not be replaced with another species, genus-only image, or
common-name guess.
