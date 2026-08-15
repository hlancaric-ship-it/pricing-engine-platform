# Medusa Spike Results

## 1. Environment

**A live local Medusa instance was brought up and used for real** (update: the initial version of this document reported BLOCKED because this sandbox had no Postgres/Docker; Jan subsequently stood up PostgreSQL 16.15 on the host Mac at `localhost:5432` with a pre-created `medusa_spike` database, reachable from this sandbox — confirmed via `pg_isready` and a direct `psql` connection as user `lucky`, no password, trust auth).

- **Medusa version**: `create-medusa-app@2.19.0`, which scaffolded `@medusajs/medusa`/`@medusajs/framework`/`@medusajs/pricing`/`@medusajs/core-flows` etc. at `2.19.x` (workspace-pinned by the scaffolder) into `/Users/lucky/medusa-spike-app` (a turborepo-style monorepo with `apps/backend`).
- **How it was run**: `npx create-medusa-app@latest medusa-spike-app --db-url "postgresql://lucky@localhost:5432/medusa_spike" --no-browser --use-npm`, which created the project, ran `npm install`, ran DB migrations against `medusa_spike`, and seeded onboarding-default data (a "Europe" region, EUR/USD currencies, default sales channel/shipping profile/stock — no `--seed` demo catalog). Backend started with `npm run dev` (`medusa develop`, esbuild + turbo watcher), served on `http://localhost:9000`.
- **Two failed scaffold attempts preceded the working one**, both environment-quality issues, not Medusa/Postgres problems: (1) scaffolding directly under the session scratchpad (`/private/tmp/...`) hit an `npm ENOENT: Cannot cd into node_modules/@opentelemetry/sdk-metrics` mid-install — a filesystem race, most likely something else concurrently touching that volatile scratchpad path — resolved by scaffolding under `/Users/lucky/medusa-spike-app` instead; (2) a self-inflicted mistake where a stray pre-created empty directory of the same name made the CLI prompt for a different project name, and a blind piped `"n"` answer got consumed by the wrong prompt — resolved by removing the stray directory and rerunning cleanly.
- **Modules used**: Pricing Module (`PriceSet`/`Price`/`PriceRule`/`PriceList` type `override`), Customer Module (`Customer`/`CustomerGroup`), Product Module, Region/Currency, Cart Module, Order Module, Inventory Module (a stock location + inventory level had to be created — Medusa refuses to add a line item for a variant with `manage_inventory: true` and no stock location linked to the sales channel), Fulfillment Module (a fulfillment set/service zone/shipping option had to be created — no default shipping option exists out of the box), Payment Module using the built-in `pp_system_default` no-op provider (no real payment gateway configured or needed, per the brief).
- **Relevant config**: store currencies extended to include `czk` (scaffold default was `eur`/`usd` only); a `Czechia` region (`reg_01M01TZ77ATWQ22TYGY3Z59A6H`, currency `czk`) was created since the default seeded region was `Europe`/`eur`. `DATABASE_URL=postgresql://lucky@localhost:5432/medusa_spike` in `apps/backend/.env` (no password — local trust auth).

**What WAS also verified statically** (kept from the original blocked-environment pass, still true and used to build the adapter before the live run):
- `@medusajs/js-sdk@2.19.0` and `@medusajs/types@2.19.0` were pulled via `npm pack` and inspected directly to confirm the exact Admin client method signatures (`sdk.admin.priceList.create`/`.batchPrices`) and request/response types (`AdminCreatePriceList`, `AdminCreatePriceListPrice`) used in `spikes/medusa-adapter-spike/writer.ts` and `client-types.ts` — these turned out to be exactly right, no adjustment was needed once tested live.
- Medusa's `calculatePrices` ranking algorithm, read from `packages/modules/pricing/src/services/pricing-module.ts` on GitHub — see section 6, now cross-checked against actual runtime behavior.

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
- `run-live-write.ts` — the live-run variant: builds a minimal fetch-based client matching `client-types.ts`'s `MedusaAdminClient` shape (since `@medusajs/js-sdk` is not a dependency of this repo — see below), reuses the same unmodified core `PricingResult`, and calls `writeOverridePrice(..., { dryRun: false })` against the real running backend.

**Mechanism actually used**: `MEDUSA-DISCOVERY.md` section 9 path A, exactly as designed — `POST /admin/price-lists` with `{ type: "override", prices: [{ variant_id, currency_code, amount, rules: {"customer.groups.id": groupId} }] }`. Verified live: the created `PriceList` (`plist_01M01V1GQ9CMXFSTQ2Z6BW1NV5`) has `type: "override"`, and its `Price` carries exactly one `PriceRule` (`attribute: "customer.groups.id"`, `operator: "eq"`, `value: "cusgroup_01M01V05V6S8JCFY53M350CX5J"`) — queried back via `GET /admin/price-lists/:id/prices?fields=*price_rules`.

**One real adapter defect found and fixed during the live run**: `writer.ts`'s `sdk.admin.priceList.create()` call did not set `status`, and Medusa's Admin API defaults new price lists to `status: "draft"`. `calculatePrices`' SQL (`packages/pricing/dist/repositories/pricing.js`) filters price lists on `pl.status = 'active'` — a `draft` price list is invisible to pricing resolution entirely, silently falling back to the default price. This is a genuine gap in the adapter's write payload (missing an explicit `status: "active"`), not a platform limitation — Medusa behaves exactly as its own code says once the price list is activated (`POST /admin/price-lists/:id { "status": "active" }`). `writer.ts` has been corrected to always set `status: "active"` on create (a one-line payload completeness fix, not new business logic — it does not decide any price, cap, or discount, it only ensures the write is actually visible to Medusa's own pricing resolution). The live test itself used a follow-up `PATCH` call to activate the already-created price list before re-verifying, then the source fix was applied and is reflected in the committed `writer.ts`.

**No extra business logic confirmed**: `writer.ts` contains no discount math, no tier thresholds, no rounding, no brand/category/product priority logic — it only maps an already-computed `PricingResult.finalPrice` to the SDK's price-write payload shape (plus, per above, is missing one required field, not extra logic). `normalizer.ts` contains no pricing math either — `resolveCustomerTier` is a direct pass-through to `determineTier()`.

**A `setPricingContext` workflow hook was written and tested, then proven unnecessary**: `medusa-spike-app/apps/backend/src/workflows/hooks.ts` initially registered `addToCartWorkflow.hooks.setPricingContext(...)` to inject `customer.groups.id` into the cart pricing context, suspecting Medusa's default `addToCartWorkflow` doesn't propagate customer-group membership automatically. Source audit (`@medusajs/core-flows/dist/cart/workflows/get-variants-and-items-with-prices.js`) showed this suspicion was wrong: the default pricing context already spreads `cart.customer` (which includes `.groups`) and `cartFieldsForPricingContext` already requests `"customer.groups.id"` — group-scoped context is automatic. Swapping the hook to a no-op confirmed pricing still resolved correctly, proving the price-list `status` fix (above) was the actual and only fix needed. The no-op hook file remains in the live Medusa app for auditability but is not part of `spikes/medusa-adapter-spike/` and is not committed to this repo (it lives in the separate `medusa-spike-app` scaffold, outside this repo's tree).

## 4. Price chain

| Stage | Expected | Actual | Status |
|---|---:|---:|---|
| Pricing Core | 800.00 | 800.00 (`PricingResult.finalPrice`, reused unmodified from section 2, not recomputed) | CONFIRMED |
| Medusa price (stored, queried back) | 800.00 | 800.00 — `GET /admin/price-lists/plist_01M01V1GQ9CMXFSTQ2Z6BW1NV5/prices` → `amount: 800`, `currency_code: czk`, one `PriceRule` on `customer.groups.id = cusgroup_01M01V05V6S8JCFY53M350CX5J` | CONFIRMED |
| Customer resolution | ZR20 member sees 800.00 | Real customer `cus_01M01V3EVPNN670G45QAVZDNE5`, authenticated via `/auth/customer/emailpass`, confirmed member of `cusgroup_01M01V05V6S8JCFY53M350CX5J` (`GET /store/customers/me?fields=*groups`) | CONFIRMED |
| Cart line item | 800.00 | `POST /store/carts/:id/line-items` → `unit_price: 800`, `cart.total: 800` (cart `cart_01M01VMGP13Z2Z3YCC1W2X3B0M`) | CONFIRMED |
| Checkout/Order | 800.00 | Order `order_01M01VTPJN2ERGX50BF9NP6GAN`, `status: pending`, line item `unit_price: 800`, `order.total: 800`, payment collection `status: authorized` via `pp_system_default` (no-op provider, no real gateway) | CONFIRMED |

Full chain **1000 → 800.00 → 800.00 → 800.00 → 800.00 held end to end**, with one real bug found and fixed along the way (missing `status: "active"` on the price-list write — see section 3).

Medusa's own vocabulary for the stages, for the record: cart → `POST /store/carts/:id/complete` → `{"type": "order", "order": {...}}`. There is no separate "checkout" resource distinct from the cart-completion call; "checkout" in Medusa v2's Store API is the cart's address/shipping-method/payment-session setup followed by `complete`, not a named intermediate entity.

## 5. Discount collision

**Empirically tested, not just predicted.** A second cart was built the same way (override price resolves to `unit_price: 800`, `total: 800`), then a promotion was applied:

- Created `promo_01M01VV3F9M0YPKN51BGQ1NHX8`, code `SPIKE10`, `type: standard`, `application_method: { type: "percentage", target_type: "order", value: 10 }`, no restriction on customer group.
- `POST /store/carts/:id/promotions` with `{"promo_codes":["SPIKE10"]}` on the cart holding the 800.00 override item.
- Result: `unit_price` stayed `800` (the override price itself is untouched — it remains the resolved line-item price), but `discount_total: 80`, `item_total: 720`, `cart.total: 720`.

**It stacks.** The override price and the Promotion Module operate as two independent layers: Pricing Module resolves the *line-item unit price* (800.00, correctly, per the override rule), and Promotion Module then discounts the *cart/order total* on top of that (720.00), exactly as predicted architecturally in `MEDUSA-DISCOVERY.md` §7 — now confirmed at runtime, not just from reading module boundaries. **Where it happens**: promotion computation runs after cart pricing context resolution, as a separate adjustment layer on the cart total/item total fields (`discount_total`, `item_discount_total`), not by mutating `unit_price` itself.

**Can it be prevented?** Not tested live in this pass (time-boxed), but `MEDUSA-DISCOVERY.md` §7 documents the real mechanism: `Promotion` supports `rules`/`target_rules` with the same attribute-matching shape as `PriceRule` (including `customer.groups.id`), so a promotion could be scoped to exclude the ZR20 group, or conversely the store could simply not distribute/advertise generic promo codes to tier-locked customers. Constructing a cart where the override is provably the *only* active pricing layer is therefore a store/promotion-configuration discipline question, not a technical impossibility — but this specific configuration (a promotion explicitly rule-scoped away from ZR20) was not built and verified live here; only the "does it stack by default" half was empirically confirmed.

## 6. Price Truth

**Both code audit and live runtime observation were done, and they matched — with one real discrepancy caught in between that the code audit alone would have missed.**

Source (`packages/modules/pricing/src/services/pricing-module.ts` / compiled `@medusajs/pricing/dist/repositories/pricing.js`, read directly from the installed package in `medusa-spike-app/node_modules`):

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

This is real and correct: an `override`-type price wins outright when its rules match. **But the code audit alone did not surface the `status: 'active'` gate** — that only became visible by reading the SQL-building code in `pricing.js`, specifically:

```sql
SELECT pl.id, pl.type, pl.rules_count FROM price_list pl
WHERE pl.status = ?   -- bound to PriceListStatus.ACTIVE
  AND pl.deleted_at IS NULL
  AND (pl.starts_at IS NULL OR pl.starts_at <= now())
  AND (pl.ends_at IS NULL OR pl.ends_at >= now())
  AND (...)
```

A `draft`-status price list is filtered out of the query entirely — before rule-matching is even considered. The live run initially reproduced exactly this: `unit_price` stayed `1000` (not `800`) until the price list was explicitly activated via `PATCH /admin/price-lists/:id {"status":"active"}`, at which point the cart immediately (next line-item add) returned `800`. This is the single most important finding of this spike: **static code audit correctly predicted the ranking algorithm, but only live testing surfaced the operational precondition (`status: active`) that the write path silently failed to satisfy.** Confirms the brief's premise that "don't rely solely on API responses" cuts both ways — the reverse (don't rely solely on source reading either) was equally true here.

Also traced live (not just from source): `get-variants-and-items-with-prices.js` in `@medusajs/core-flows` builds cart pricing context as `{...cartFieldsForPricingContext-selected fields, customer: cart.customer, region: cart.region, ...hookResult, currency_code, region_id, customer_id}`, and `cartFieldsForPricingContext` already includes `"customer.groups.id"` — so customer-group-scoped pricing is automatic on `addToCartWorkflow` by default, no custom `setPricingContext` hook is required for this specific attribute (verified by testing with the hook as a no-op — see section 3).

## 7. Verdict

**CONFIRMED**

The full chain (1000 → core computes 800.00 → Medusa stores 800.00 → cart shows 800.00 → order records 800.00) held end to end, using the real unmodified `PricingEngine`/`determineTier()`, a thin adapter with no duplicated pricing logic, and a real local Medusa v2 instance backed by PostgreSQL. `git diff --quiet -- src/core` remained clean throughout (see section 2) — no core change was needed or made.

Two caveats, neither of which changes the verdict but both of which are load-bearing for anyone building the real adapter from this spike:
1. **Adapter completeness gap, found and fixed**: the write payload was missing `status: "active"`, defaulting to `draft` and silently making the override invisible to pricing resolution. This is a one-field fix to `writer.ts`, not a design flaw in the chosen mechanism (`PriceList` type `override`) — but it is exactly the kind of silent failure mode that justifies the brief's "query it back, don't assume" discipline for Test 1.
2. **Discount collision confirmed real, not hypothetical**: a generic promotion applied on top of the override price *does* stack (800.00 → 720.00 after a 10% promo), confirming `MEDUSA-DISCOVERY.md`'s architectural prediction empirically. Preventing this requires promotion-level `customer.groups.id` rule scoping or store-side promo-code distribution discipline — this is a genuine operational consideration for a production adapter, not a blocker for this spike's core question (can the thin-adapter pattern write and preserve a deterministic price through Medusa's own pricing/cart/order pipeline — yes, when the override is the only active layer).
