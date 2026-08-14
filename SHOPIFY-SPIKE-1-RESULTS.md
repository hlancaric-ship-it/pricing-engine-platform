# Shopify Spike 1 — Results

Store: `l-code-laborator.myshopify.com` (Admin GraphQL API `2026-07`, dev store on the `Basic App Development` plan).
Baseline sanity check before touching Shopify: `npm test` at repo root — **239/239 passed**; `cloudflare-worker && npm test` — **49/49 passed**, including the golden case `tests/integration.test.ts` ("Golden case: SKU 93682 (Should limit discount to 15%)"). Core untouched, unmodified.

All Shopify object IDs below are real, created on this dev store during the spike. Access token never appears in this document, any commit, or any log — it was read from a local `.local.md` scratchpad file outside the repo and passed only via `X-Shopify-Access-Token` header / `SHOPIFY_TOKEN` env var at call time.

---

## A. Shopify Basic capabilities

| Capability | Result | Evidence |
|---|---|---|
| `Company` create | **PASS** | `companyCreate` → `gid://shopify/Company/20424163671` (+2 more, `.../20424196439`, `.../20424229207`) |
| `CompanyLocation` create | **PASS** | `companyLocationCreate` → `gid://shopify/CompanyLocation/39577518423` (+2 more) |
| `Catalog` create, `status: ACTIVE`, `context.companyLocationIds` | **FAIL** | Exact error: `"Catalogs assigned to company locations can't be set to active with your plan."` (field: `input.context`) |
| `Catalog` create, `status: DRAFT`, same context | **FAIL, same error** | Identical message regardless of requested status — this is a hard plan-level block on company-location-scoped catalogs, not a status-transition rule. |
| `Catalog` create, market-scoped context (`marketId`) | **FAIL, different cause** | `"InputObject 'CatalogContextInput' doesn't accept argument 'marketId'"` — confirms `CatalogContextInput` on this API version accepts **only** `companyLocationIds`; there is no non-B2B catalog path to fall back to. |
| `PriceList` create (standalone, no `catalogId`) | **PASS** | `priceListCreate` (percentage-adjustment parent, 0%) → `gid://shopify/PriceList/31579537751` |
| `PriceList` fixed price write (`priceListFixedPricesAdd`) | **PASS (write succeeds), but INERT** | Wrote `800.00 EUR` for variant `gid://shopify/ProductVariant/54340572217687` — call returned success, but `priceList.catalog` is `null` and `ProductVariant.price` remained `1000.00` afterward (queried directly). The write has zero customer-facing effect because it isn't bound to any catalog. |
| 3-active-catalogs cap | **NOT TESTABLE** | Catalog creation fails at catalog #1 (see above) — there's no way to reach a 4th catalog to test the cap, because the underlying mechanism (company-location-scoped catalog) never activates on this store/plan at all. `SHOPIFY-DISCOVERY.md`'s claim of a "3-catalog cap on Basic" could not be confirmed *or* refuted from this store — what was found is a stricter, prior blocker: **zero** company-location catalogs can go active here, regardless of count. |

**Classification: SHOPIFY PLATFORM LIMITATION.** `SHOPIFY-DISCOVERY.md`'s "B2B for all" conclusion (Basic/Grow/Advanced support B2B `Company`/`CompanyLocation`/`Catalog`/`PriceList`, capped at 3 catalogs) does not hold empirically on this specific dev store: `Company` and `CompanyLocation` work exactly as documented, but the `Catalog` object — the only thing that turns a `PriceList` from an inert record into something a customer can actually be shown — refuses to activate for company-location context under this plan, unconditionally. This may be a dev-store-specific restriction (company-location catalog activation could require a real paid Basic subscription rather than a Partner dev store simulating one, or a manual B2B-enablement step in the Shopify admin UI not exposed via this API), but from the API's point of view it is indistinguishable from "not available." Recommendation: before Phase 2 relies on this path, confirm on a real paid Basic store or ask Shopify Partner support directly whether company-location catalog activation requires anything beyond API calls.

---

## B. Core compatibility

| Item | Result |
|---|---|
| `PricingInput` / `PricingResult` (`src/core/interfaces.ts`) | **PASS** — used unchanged by the adapter spike's `normalizeToInput()`. |
| `determineTier()` (`src/core/customer-tier.ts`) | **PASS** — exists, pure function `(totalOrderValue: number) => CustomerTier \| undefined`, spend thresholds unchanged, called unmodified from `normalizer.ts`'s `resolveCustomerTier()`. |
| Golden SKU 93682 | **PASS** — `cloudflare-worker/tests/integration.test.ts`, part of the 49/49 passing suite above, run for real via `npm test`, not eyeballed. |

---

## C. Price Truth

Engine computation (real `PricingEngine`, not manual math) for `SPIKE-A`, base 1000, tier 20% (`ZR20`, spike's `TIER_C`):

```
Engine result: SPIKE-A 800.00 [ 'BASE_PRICE', 'LOYALTY' ]
```

| Check | Value | Match? |
|---|---|---|
| (1) Engine computed | 800.00 | — |
| (2) Shopify Admin API stored (`PriceList` entry) | 800.00 EUR — write call succeeded (`written: true`) | Stored, yes — but see below |
| (2b) Shopify Admin API — `ProductVariant.price` (what the store actually exposes) | **1000.00**, unchanged | **Does not match (2)** |
| (3) Storefront-displayed price for the logged-in customer | **NOT REACHED** | blocked |
| (4) Checkout-charged price via test payment gateway | **NOT REACHED** | blocked |

**Classification: SHOPIFY PLATFORM LIMITATION, cascading into PRICE TRUTH LIMITATION.** The chain breaks at step (2)→(2b), before storefront or checkout is even reachable: a `PriceList` fixed-price entry only affects what a customer sees/pays when it's attached to a `Catalog` scoped to their `CompanyLocation`. Section A shows that binding is blocked on this store. The write "succeeds" in the sense that the API accepts and stores the mutation, but it is provably inert — `priceList.catalog` is `null`, and `ProductVariant.price` (the only price value actually exposed to any buyer) never moved off 1000.00. There is no legitimate B2B customer login path to test against (no company location has an active catalog to assign), so steps (3) and (4) were not attempted rather than faked — doing a storefront/checkout test against a price that structurally cannot be customer-visible would produce a meaningless "match" (the customer would simply see the untouched 1000.00 base price, which isn't informative). This is consistent with, and sharpens, `SHOPIFY-DISCOVERY.md`'s own prior finding that Price Truth for a specific customer could not be confirmed via API for plain B2C — this spike shows it also fails for the B2B/company-location path specifically because the *prerequisite* Catalog-activation step is blocked on this store, one layer earlier than the doc's original B2C-focused concern.

---

## D. Discount collision

**NOT REACHED.** Step 7 (layering an extra discount on top of the 800 fixed price) presupposes a working step 6 (the 800 actually being the customer-visible/charged price). Since step 6 could not be established — the fixed price never reaches any customer — there is no live 800 price to layer a second discount onto. Attempting this against the base 1000.00 price instead would test something different (ordinary discount-code stacking on the plain shop price) and would not answer the question the brief asks ("does combinability move the price away from the *fixed* price"). Not attempted, to avoid reporting a misleading result.

---

## E. `amountSpent`

Empirical test, one customer (`gid://shopify/Customer/11234946449751`), via `draftOrderCreate` → `draftOrderComplete` (marks order PAID, gateway `manual`) against variant `SPIKE-A` (1000.00 CZK — store base currency):

| Step | `amountSpent` | `numberOfOrders` | Notes |
|---|---|---|---|
| Before any order | `0.0 CZK` | 0 | — |
| After order #1001 (PAID, 1000.00) | `1000.0 CZK` | 1 | |
| After full refund of #1001 (`refundCreate`, 1000.00) | `0.0 CZK` | 1 | **`amountSpent` nets the refund out; `numberOfOrders` does not decrement.** |
| After order #1002 (PAID, 1000.00) | `1000.0 CZK` | 2 | |
| After cancel of #1002 (`orderCancel`, `refund: true`) | `0.0 CZK` | 2 | Cancel-with-refund also nets `amountSpent` back to 0; order count again unaffected. |
| Multi-currency | **Not attempted** | — | Store base currency is CZK; testing a second currency would require configuring an additional Market with its own checkout for this customer, which is a nontrivial setup step outside a "cheap, targeted" empirical test — reason recorded per brief's instruction to document rather than skip silently. |

**Conclusion: `amountSpent` IS safe to feed directly into `determineTier()`** for the refund/cancel semantics specifically — both a full refund and a cancel-with-refund correctly reduced `amountSpent` back to net-zero, meaning it will not silently over-count a customer's tier from orders that were later reversed. This resolves the open question `SHOPIFY-DISCOVERY.md` flagged as unverifiable from documentation alone. The one caveat carried forward, not resolved by this test: `numberOfOrders` is a raw count, not net of refunds/cancels — if any future logic (not `determineTier()`, which only uses spend) ever keys off order *count*, that would need its own explicit filtering. Multi-currency behavior remains unverified — flagged, not assumed safe.

---

## F. Architecture conclusion

**CONFIRMED WITH LIMITATIONS.**

- **Core survives untouched.** `PricingInput`/`PricingResult`/`determineTier()`/`PricingEngine` needed zero modification. All 10 test-product scenarios (`spikes/shopify-adapter-spike/test-products.ts`) ran correctly through the real, unmodified `PricingEngine` (`spikes/shopify-adapter-spike/run-pricing.ts` output verified by hand: e.g. product G — brand+category+product caps all present — correctly resolves to the tightest, product-level cap at every tier, per the engine's existing Product > Brand > Category hierarchy; product J's sale price survives exactly as `820.00` through `RoundingPolicy` at the tiers where sale beats tier-loyalty). Golden SKU 93682 regression untouched. This is the part of the hypothesis that held completely.
- **The adapter boundary itself is sound and small.** `normalizer.ts` (Shopify → `PricingInput`) and `writer.ts` (`PricingResult` → Shopify write) do no pricing/discount/tier math — every number that appears in a `PricingResult` came from the core engine, never from adapter code. No `if (platform === 'shopify')` in core; no duplicated logic; one `ADAPTER GAP` was surfaced honestly rather than worked around (missing-SKU fallback, `normalizer.ts`) instead of inventing a synthetic key silently.
- **What breaks the chain, and exactly where: the Shopify platform layer between "PriceList write succeeds" and "any customer can ever see that price."** On this dev store, `Catalog` objects scoped to a `CompanyLocation` cannot be activated under the current plan (Section A) — this is one specific, well-defined layer, not a vague "Shopify is complicated" hand-wave. Everything downstream of that layer (storefront display for a real tier'd customer, checkout charge, discount-collision behavior) was correctly *not* attempted once that prerequisite was shown to be broken, rather than faked against a price no customer could ever actually see.
- **This is not a core problem and not something the adapter can route around.** It is a `SHOPIFY PLATFORM LIMITATION` on this specific store/plan instance. Recommendation before Phase 2: verify on a real paid Basic subscription (not a Partner dev store) or get direct confirmation from Shopify support on whether company-location catalog activation needs a manual admin-UI step this API doesn't expose. If it turns out to be permanently blocked even on a paid plan, `SHOPIFY-DISCOVERY.md`'s own Plus-tier fallback path (unlimited catalogs, direct company/location catalog assignment) is the next thing to test — not a workaround invented at the adapter layer.

---

### Artifacts

- `spikes/shopify-adapter-spike/normalizer.ts` — Shopify → `PricingInput` normalizer (calls `determineTier()` unchanged).
- `spikes/shopify-adapter-spike/writer.ts` — `PricingResult` → Shopify `PriceList` fixed-price write.
- `spikes/shopify-adapter-spike/test-products.ts` — the 10 test products + 3 spike tiers (`ZR4`/`ZR10`/`ZR20` reinterpreted locally as 0%/10%/20%, not a change to the real policy file).
- `spikes/shopify-adapter-spike/run-pricing.ts` — runs all 10 × 3 through the real engine, prints results.
- `spikes/shopify-adapter-spike/write-800-demo.ts` — proves the write mechanism against the real engine's 800.00 output.
- Shopify objects created: 3 `Company`, 3 `CompanyLocation`, 1 standalone `PriceList` (`.../31579537751`), 2 test `Product`s (`SPIKE-A` etc.), 1 test `Customer`, 2 test `Order`s (#1001 refunded, #1002 cancelled).
