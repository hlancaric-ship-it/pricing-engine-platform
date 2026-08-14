# Medusa Spike Results

## 1. Environment

**Could not bring up a live local Medusa instance in this sandbox.** Medusa v2 requires PostgreSQL — it dropped SQLite dev-mode support that existed in Medusa v1 (confirmed via `create-medusa-app` / Medusa v2 docs ecosystem knowledge and by there being no SQLite adapter package published under `@medusajs/*` for v2). This sandbox has:
- No Docker (`docker` not found).
- No Postgres client/server (`psql`, `initdb`, `pg_ctl` all not found).
- `brew install postgresql@16` was attempted as a fallback (per the brief's instruction to try reasonable fallbacks before concluding blocked). It was left running ~25+ minutes with zero CPU-time growth (0:06.60 static) before being killed — it stalled, consistent with the old Mac Mini 2014 hardware referenced in this environment's own operating rules, and/or a stalled bottle download. It did not produce a usable `postgresql@16` keg (`brew list postgresql@16` → "No such keg").
- `npx create-medusa-app` was not attempted to completion because it requires a running Postgres instance as a hard precondition (interactive DB-URL prompt in non-interactive mode would fail regardless).

**What WAS verified for real**, without a running backend:
- `@medusajs/js-sdk@2.19.0` and `@medusajs/types@2.19.0` (current npm versions as of this spike) were pulled via `npm pack` and inspected directly (not scraped from docs, not guessed) to confirm the exact Admin client method signatures and request/response types used in the adapter code (`spikes/medusa-adapter-spike/writer.ts`, `client-types.ts`).
- Medusa's actual `calculatePrices` ranking algorithm was read from source on GitHub (`medusajs/medusa`, `packages/modules/pricing/src/services/pricing-module.ts`, develop branch) — see section 6.

No modules were "used" in the sense of a running instance; the adapter code targets the Pricing Module (`PriceList` type `override`) and Customer Module (`CustomerGroup`) exclusively, per `MEDUSA-DISCOVERY.md` section 9 path A.

## 2. Core

Exact `PricingInput` used (via `spikes/medusa-adapter-spike/run-pricing.ts`, real unmodified `PricingEngine`/`determineTier()`):

```json
{
  "sku": "MEDUSA-SPIKE-1",
  "basePrice": "1000",
  "customerTier": "ZR20",
  "currency": "czk",
  "allowLoyaltyDiscount": true
}
```

Exact `PricingResult` produced:

```json
{
  "sku": "MEDUSA-SPIKE-1",
  "originalPrice": "1000",
  "finalPrice": "800",
  "appliedRules": [
    { "rule": "BASE_PRICE" },
    { "rule": "LOYALTY" }
  ],
  "warnings": [],
  "rejected": false
}
```

`resolveCustomerTier({ totalOrderValue: 7500 })` → `"ZR20"` → `determineTier()` unchanged (>=7000 → ZR20), consistent with `src/core/customer-tier.ts`. The 20% test-tier discount is supplied as a local `loyaltyTiers: { ZR20: 0.2 }` override fed into `HighestDiscountPolicy`, mirroring exactly how `spikes/shopify-adapter-spike/test-products.ts` re-expressed its "TIER_C 20%" scenario on the existing `ZR20` identifier — no change to `src/config/policies/policy-v1.json`.

Root test suite: **239/239 tests passed** (17 files), including the golden case `SKU 93682` (`tests/integration.test.ts`) — `14.94 * (1-0.15) capped` → `12.70`, `PRODUCT_LIMIT` rule applied, unchanged.

`git diff --quiet -- src/core` → **clean**, confirmed before and after this spike. No file under `src/core/` was touched.

## 3. Adapter

`spikes/medusa-adapter-spike/` (mirrors `spikes/shopify-adapter-spike/` structure):
- `normalizer.ts` — `MedusaProduct`/`MedusaCustomer` → `PricingInput`, `resolveCustomerTier()`. No pricing math.
- `client-types.ts` — structural types copied verbatim from the real installed `@medusajs/js-sdk`/`@medusajs/types` packages (not invented).
- `writer.ts` — `writeOverridePrice()`: calls `sdk.admin.priceList.create()` (or `.batchPrices()` if a price list already exists) to write `PricingResult.finalPrice` as a `Price` inside a `type: "override"` `PriceList`, with `rules: { "customer.groups.id": customerGroupId }` scoping it to the tier's `CustomerGroup`. Supports `dryRun`.
- `test-fixture.ts`, `run-pricing.ts` — fixture (base 1000.00, ZR20/20% tier) and the runnable demo producing the Core section 2 output above plus a dry-run write outcome.

**Mechanism actually used**: `MEDUSA-DISCOVERY.md` section 9 path A, confirmed against the real SDK contract — `AdminCreatePriceList { type: "override", prices: [{ variant_id, currency_code, amount, rules }] }` via `sdk.admin.priceList.create`/`.batchPrices`. This matches the discovery doc's assumption exactly; no divergent real mechanism was found (though it also could not be executed against a live backend — see section 1).

**No extra business logic confirmed**: `writer.ts` contains no discount math, no tier thresholds, no rounding, no brand/category/product priority logic — it only maps an already-computed `PricingResult.finalPrice` to the SDK's price-write payload shape. `normalizer.ts` contains no pricing math either — `resolveCustomerTier` is a direct pass-through to `determineTier()`.

## 4. Price chain

| Stage | Expected | Actual | Status |
|---|---:|---:|---|
| Pricing Core | 800.00 | 800.00 (`PricingResult.finalPrice`, see section 2) | CONFIRMED |
| Medusa price | 800.00 | Not observed — no live backend available (section 1) | BLOCKED |
| Cart | 800.00 | Not observed — no live backend available | BLOCKED |
| Checkout/Order | 800.00 | Not observed — no live backend available | BLOCKED |

## 5. Discount collision

Not empirically testable without a live cart/checkout pipeline (Test 5 blocked along with Tests 3/4/6). Based on the code-level read in section 6: Promotion Module is architecturally separate from the Pricing Module — promotions apply during cart/order total computation, after `calculatePrices` has already resolved the line-item unit price. This means a Promotion (percentage/fixed discount, coupon code) can in principle stack on top of an `override` price unless explicitly scoped away from the tier's `CustomerGroup` (Promotion rules support the same `customer.groups.id` attribute matching as `PriceRule`, per `MEDUSA-DISCOVERY.md` section 7). Whether it *actually* stacks, and whether it can be constructed so the override price is the sole active layer, was not observed — this requires the same live-cart test that Tests 3–6 needed and could not run.

## 6. Price Truth

**Code-level audit was possible** (self-hosted, MIT-licensed source, per `MEDUSA-DISCOVERY.md` section 10) even without running the instance locally — fetched directly from `github.com/medusajs/medusa`, `packages/modules/pricing/src/services/pricing-module.ts` (develop branch), the real `calculatePrices` selection algorithm:

```typescript
if (priceListPrice) {
  switch (priceListPrice.price_list_type) {
    case PriceListType.OVERRIDE:
      calculatedPrice = priceListPrice
      break
    case PriceListType.SALE:
      lowestPrice = MathBN.lte(priceListPrice.amount, defaultPrice.amount)
        ? priceListPrice : defaultPrice
      calculatedPrice = lowestPrice
  }
}
```

Confirms, directly from source (not inferred from docs): an `override`-type price **always wins** outright over the default price when its rules match context (no comparison against default needed, unlike `sale` type which takes the lower of the two). If multiple `override` prices match, the lowest amount is selected. This validates `MEDUSA-DISCOVERY.md` section 5's "deterministic, documented algorithm" claim at the source-code level, and confirms the adapter's chosen mechanism (section 3) writes into the highest-priority price tier Medusa's own engine recognizes.

What was **not** confirmed at the code level (out of scope of this spike, needs the live-cart test that was blocked): the exact point in the cart/checkout pipeline where `calculatePrices` output is read into a cart line item, and the precise ordering against Promotion Module application (section 5). The source location is known (Pricing Module service) but tracing the full cart-line-item call path was not done — this spike's code audit was targeted at the specific ranking algorithm needed to validate the adapter's chosen write mechanism, not an exhaustive pipeline trace.

## 7. Verdict

**BLOCKED**

Reasoning: The core computation (1000 → 800.00, via the real unmodified `PricingEngine`/`determineTier()`) is fully CONFIRMED, and the adapter mechanism is CONFIRMED correct against the real, installed Medusa SDK types and against Medusa's actual source-code price-ranking algorithm (not the docs' description of it, the code itself). This is not a `CORE GAP` — nothing in `src/core` needed to change, and nothing about the adapter's mechanism was found to differ from `MEDUSA-DISCOVERY.md`'s assumption. It is not a `PLATFORM GAP` either — Medusa's mechanism works exactly as designed and expected; there is no missing platform capability.

It is `BLOCKED` specifically because Medusa v2 has a hard PostgreSQL dependency with no SQLite/lightweight fallback, and this sandbox has neither Docker nor a working Postgres install path — `brew install postgresql@16` was attempted (per instructions to try reasonable fallbacks) and stalled without completing after ~25 minutes. Tests 1 (price write query-back), 2 (customer-group resolution), 3 (cart), 4 (checkout/order), and 5 (discount collision) all require a running Medusa backend and could not be executed. Checkout/order completion specifically was environment-blocked before it could even be attempted — the blocker is earlier in the chain (no backend at all) than Shopify's Playwright/Chromium blocker was (backend existed, browser automation didn't).
