# AntBubbles Regression Guards

These are product invariants, not optional implementation details.

## Token Identity

- A WAX token is identified by normalized `contract + symbol`.
- Alcor, Taco, and Nefty must share the same logo asset for that identity.
- Exchange-specific IDs and URLs must not create duplicate logo identities.

## Image Pipeline

- Bubble logos should normally render from one canonical WAX atlas.
- The atlas must contain every token in the current Alcor, Taco, and Nefty
  snapshots. Missing upstream artwork uses a deterministic generated badge.
- The atlas is content-hashed and immutable; its manifest may update independently.
- The atlas image may be cached for a year, but its small manifest must switch
  promptly. Version client manifest requests when changing atlas behavior and
  keep the edge freshness short.
- Individual token URLs are fallback-only.
- Canvas rendering must never depend on a live per-token request completing.
- When an async atlas image finishes decoding, invalidate the affected
  offscreen bubble render. Never leave the initial logo-less frame cached.
- Worker startup must hydrate the last Redis token snapshots before the first
  atlas build. An Alcor timeout during deployment must not create a partial atlas.
- If the short-lived WAX Redis snapshot has expired during deployment, the logo
  job may hydrate identities from the app's existing `/api/tokens?chain=wax`
  endpoint. This is for atlas membership only and must not replace Alcor market
  data publication or calculations.
- When sources overlap, the reliable Taco/Nefty asset source must be considered
  before the Alcor proxy. A later exchange must not replace an existing canonical
  identity with a less reliable source.
- An image or atlas change must never modify price, volume, TVL, market cap, or
  percentage-change fields.
- Alcor's existing `/api/logo` proxy is best-effort ingestion only. It is not a
  runtime availability dependency. Do not replace Alcor market-data behavior
  while optimizing images.

## Nefty Percentage Changes

- `change24` is market data and must survive worker restarts and deployments.
- Railway's local SQLite database is not the durable source of truth.
- Persistent Redis price history is the cross-deployment baseline.
- A missing or incomplete candle window must never replace a last-known-good
  non-zero change with zero.
- The bundled SQLite seed exists for immediate startup recovery, not durability.

## Required Verification

- Run `npm test --prefix worker`.
- Verify `/api/logo-atlas` has entries and an immutable Blob URL.
- Verify atlas entry count covers the union of current canonical token identities.
- Verify `/api/nefty-tokens` contains both positive and negative non-zero `change24`
  values when sufficient history exists.
- Verify Alcor, Taco, and Nefty visually after a hard reload and after tab switching.
