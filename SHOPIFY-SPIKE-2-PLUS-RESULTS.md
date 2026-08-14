# Shopify Spike 2 — Results (Plus)

Store: `l-code-laboratory-tarif-plus.myshopify.com` (Admin GraphQL API `2026-07`, dev store on the `Shopify Plus App Development` plan — `shop.plan.shopifyPlus: true`, confirmed via API before any other call).
Baseline sanity check: `npm test` at repo root — **239/239 passed**; `cloudflare-worker && npm test` — **49/49 passed**, including the golden case `tests/integration.test.ts` ("Golden case: SKU 93682 (Should limit discount to 15%)"). Core untouched, unmodified — identical to Spike 1's baseline.

All Shopify object IDs below are real, created on this dev store during the spike. Access token never appears in this document, any commit, or any log — it was read from a local `.local.md` scratchpad file outside the repo and passed only via `X-Shopify-Access-Token` / `X-Shopify-Storefront-Access-Token` headers at call time.

---

## A. Shopify Plus capabilities (vs Basic from Spike 1)

| Capability | Spike 1 (Basic) | Spike 2 (Plus) | Evidence |
|---|---|---|---|
| `Company` create | PASS | **PASS** | `companyCreate` → `gid://shopify/Company/10775331141` |
| `CompanyLocation` create | PASS | **PASS** | `gid://shopify/CompanyLocation/22265299269` |
| `Catalog` create, `status: ACTIVE`, `context.companyLocationIds` | **FAIL** — `"Catalogs assigned to company locations can't be set to active with your plan."` | **PASS** | `catalogCreate` with identical `context.companyLocationIds` input returned `{"status":"ACTIVE"}`, zero `userErrors` → `gid://shopify/CompanyLocationCatalog/192460489029` |
| 3-active-catalog cap | NOT TESTABLE (blocked before reaching #1) | **PASS — no cap observed** | Created 4 active company-location catalogs in sequence (`.../192460489029`, `.../192460521797`, `.../192460554565`, `.../192460587333`), all `status: ACTIVE`, zero `userErrors` on any of them. |
| `PriceList` bound to an active `Catalog` | PASS (write succeeds, but catalog is `null`) | **PASS, and bound** | `priceListCreate` with `catalogId` → `gid://shopify/PriceList/32140263749`; re-querying the catalog immediately shows `priceList.id` populated (bidirectional link established, unlike Spike 1's standalone/catalog-less `PriceList`). |
| `Catalog` → storefront visibility (`Publication`) | NOT REACHED | **PASS** | `Catalog.publication` was `null` right after creation (needs an explicit `publicationCreate(catalogId, autoPublish:true, defaultState:ALL_PRODUCTS)` call — this is a Plus-specific extra step not covered by Spike 1's discovery doc); product then explicitly published via `publishablePublish`. |

**Classification: original Plus-gate hypothesis in `SHOPIFY-DISCOVERY.md` CONFIRMED.** The exact mutation, with the exact same input shape, that Shopify rejected on Basic with a plan-level error succeeded outright on Plus with zero code changes. The blocker was genuinely plan-gated, not a dev-store artifact or an API-version quirk — same API version (`2026-07`) used in both spikes. One correction to Spike 1's assumption: even on Plus, a freshly created company-location `Catalog` does **not** auto-create a `Publication` — that's one additional required step (`publicationCreate`), not previously documented; noted here as an addendum, not a blocker.

---

## B. Core compatibility

| Item | Result |
|---|---|
| `PricingInput` / `PricingResult` (`src/core/interfaces.ts`) | **PASS** — used unchanged. |
| `determineTier()` (`src/core/customer-tier.ts`) | **PASS** — same pure function, unchanged, called unmodified from `normalizer.ts`. |
| `PricingEngine` output for the 10 test products × 3 tiers | **PASS — byte-for-byte identical to Spike 1.** Re-ran `spikes/shopify-adapter-spike/run-pricing.ts` unmodified: e.g. `SPIKE-A/ZR20 → 800.00`, `SPIKE-G` (brand+category+product caps) still resolves to the tightest product-level cap at every tier, `SPIKE-J` sale price still survives exactly as `820.00`. The core is 100% unaffected by which store it targets, as expected — nothing in `src/core` references Shopify, Basic, or Plus. |
| Golden SKU 93682 | **PASS** — part of the 49/49 `cloudflare-worker` suite, run for real via `npm test` before any Shopify API call, per the brief's gating requirement. |

---

## C. Price Truth

Engine computation (real `PricingEngine`) for `SPIKE-A-PLUS`, base 1000, tier 20% (`ZR20`):

```
Engine result: SPIKE-A 800.00 [ 'BASE_PRICE', 'LOYALTY' ]
```

Chain built on the Plus store: `Company` → `CompanyLocation` → active `CompanyLocationCatalog` → `Publication` (`autoPublish`, `defaultState: ALL_PRODUCTS`) → `PriceList` (bound to that catalog) → `priceListFixedPricesAdd(800.00 CZK)` → product explicitly published to both the B2B catalog's publication and the "Online Store" publication → real customer created (`spike2-buyer@example.com`), assigned as `CompanyContact` with the "Location admin" role at the `CompanyLocation` → Storefront API `customerAccessTokenCreate` (real password login, not simulated) → `cartCreate` with `buyerIdentity.companyLocationId` set.

| Check | Value | Match to Engine (800.00)? |
|---|---|---|
| (1) Engine computed | 800.00 CZK | — |
| (2) Shopify Admin API stored — `ProductVariant.price` (base, no context) | 1000.00 CZK (unchanged — this is expected: base price is store-wide, B2B pricing is contextual, not a base-price overwrite) | N/A — by design |
| (2b) Shopify Admin API — `ProductVariant.contextualPricing(companyLocationId)` | **800.0 CZK** | **YES** |
| (3) Storefront/cart displayed — real logged-in customer, real Storefront API cart, `cart.lines[0].cost.totalAmount` | **800.0 CZK** | **YES** |
| (4) Checkout charged (actual completed order via test/Bogus gateway) | **NOT COMPLETED** — see note below | Not directly observed, but cart cost (3) uses the same commerce/pricing computation Shopify's checkout uses for the same cart object, and (3) matched. |

**Note on (4):** this sandboxed execution environment cannot run a Chromium browser (`playwright install chromium` fails with `"Playwright does not support chromium on mac12"` — the sandbox's macOS/Darwin version is unsupported by the bundled Playwright build), so a real browser-driven checkout completion via the Bogus test gateway could not be executed here. This is an **environment limitation, not a Shopify platform limitation** — nothing observed suggests checkout itself would diverge from the cart cost, since Shopify's cart and checkout share the same buyer-identity-aware pricing computation (contextual pricing + `PriceList`), and (2b)/(3) both independently confirmed 800.0 CZK. Recommendation: re-run step (4) specifically in an environment with a working Chromium install (or via Shopify's Checkout Sheet Kit / `cartSubmitForCompletion` GraphQL flow with a real card-vault token) before treating Price Truth as fully closed end-to-end.

**Classification: PRICE TRUTH — chain PROVEN through cart/storefront, checkout-completion step blocked by CI/sandbox tooling (not Shopify).** This is the section Spike 1 could not complete at all (it broke at step 2→2b). Spike 2 gets three of four numbers to match exactly, with the fourth blocked by a local tooling gap rather than any platform or pricing-logic issue.

---

## D. Discount collision

Created an automatic order-level discount (`discountAutomaticBasicCreate`, 10% off all items, `combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true }`) and re-created the cart:

| State | Line cost (fixed B2B price) | Cart total |
|---|---|---|
| No extra discount | 800.0 CZK | 800.0 CZK |
| Automatic 10% discount, `combinesWith` all `true` | 800.0 CZK (unchanged — the fixed price is the *line* price) | **720.0 CZK** (800 × 0.9 — discount stacked on top) |
| Same discount, `combinesWith` all set `false` | 800.0 CZK | **720.0 CZK — still stacked, unchanged** |

**Finding:** the `combinesWith` flags govern combinability *between discounts of different classes*, not whether an automatic discount applies on top of a B2B fixed price — a fixed `PriceList` price is a price override, not itself a member of the discount-combination system, so there is nothing for a lone automatic discount to "combine with" or be blocked by via `combinesWith` alone. Deleting the discount (`discountAutomaticDelete`) was the only way that reliably removed the stacking in this test; state was restored to plain 800.0 CZK afterward and confirmed via a fresh cart.

**Plus-specific note:** `SHOPIFY-DISCOVERY.md` flags Shopify Functions as available on Plus. A `cart.lines.discounts.generate.run` (or `orderDiscounts`) Function evaluated on the merchant's own account could inspect `cart.lines[].cost.amountPerQuantity` / whether a line is already B2B-priced (via `sellingPlanAllocation`/`buyerIdentity.purchasingCompany` context) and explicitly veto any further discount on catalog-priced lines — this is the actual lever for "can combinability be disabled," not `combinesWith` on the competing discount. Not built here (out of scope per the brief — this is a capability note, not an implementation).

**Classification: SHOPIFY PLATFORM LIMITATION (in the sense that `combinesWith` alone doesn't cover this case) — but with a documented, Plus-only workaround (Shopify Functions) not available on Basic.**

---

## E. Comparison to Spike 1 (Basic)

| Dimension | Spike 1 (Basic) | Spike 2 (Plus) |
|---|---|---|
| Company / CompanyLocation | Works | Works (identical) |
| Catalog activation on company location | **Blocked, hard plan error** | **Works** |
| 3-catalog cap | Untestable (blocked earlier) | **No cap observed up to 4** |
| PriceList → Catalog binding | Write succeeds but inert (`catalog: null`) | **Bound correctly, `priceList.id` visible on `catalog.priceList`** |
| `ProductVariant.price` reflects tier price | Never — stayed 1000.00 | **Base price stays 1000.00 by design; `contextualPricing` correctly resolves to 800.00 for the assigned company location** |
| Storefront/cart price for the real logged-in B2B customer | Not reached | **Reached — 800.0 CZK, matches engine** |
| Checkout charged amount | Not reached | **Not completed — blocked by sandbox's missing Chromium, not by Shopify** |
| Discount collision test | Not reached | **Reached — stacks by default; `combinesWith` alone insufficient to block it; Shopify Functions is the real lever, Plus-only** |
| Core (`PricingEngine`, `determineTier()`, 10 test products) | Untouched, 100% pass | **Untouched, 100% pass, byte-identical output** |

The original `SHOPIFY-DISCOVERY.md` hypothesis — that company-location catalog activation is Plus-gated — is **confirmed empirically**, not just by documentation reading. Everything that was blocked in Spike 1 specifically *because* of that one activation error is now reachable in Spike 2, in the same order the brief specifies.

---

## F. Architecture conclusion

**CORE + ADAPTER HYPOTHESIS CONFIRMED — WITH ONE ENVIRONMENT-LEVEL GAP (not architectural).**

- **Core survives untouched, again.** Same `PricingEngine`, `determineTier()`, `PricingInput`/`PricingResult`, same 10 test products, same 3 spike tiers — zero modification, byte-identical output to Spike 1. This is now confirmed across two different Shopify plans, which is stronger evidence than Spike 1 alone could provide: the core genuinely does not know or care what platform or plan it's writing to.
- **The adapter boundary held and needed only additive extension, not rewriting.** `spikes/shopify-adapter-spike/writer.ts`'s `writeFixedPrice()` was reused as-is (same `priceListFixedPricesAdd` mutation, just pointed at a new store/token/catalog-bound `PriceList`). The only new adapter-level work for Plus was the extra `publicationCreate` step (Section A) and the B2B customer/company-contact/role setup for the storefront leg — both are Shopify-platform bookkeeping, not pricing logic, and none of it lives in `src/core`.
- **The blocker from Spike 1 is fully lifted on Plus, and the chain now completes three of four legs for real:** Engine (800.00) → Shopify stored/contextual (800.0) → Storefront cart for a real authenticated B2B customer (800.0). All three match exactly.
- **What's still open, and why it's not a platform or architecture problem:** actual checkout-completion (leg 4) could not be run because this sandboxed execution environment cannot install a working Chromium build for Playwright (`mac12` unsupported by the current Playwright browser bundle). Classified as `ADAPTER GAP`-adjacent tooling limitation, not `SHOPIFY PLATFORM LIMITATION` and not `PRICE TRUTH LIMITATION` in the Spike-1 sense — Spike 1's block was Shopify refusing the underlying object; here every underlying object and price resolved correctly, it's the local test-runner that's short a browser binary. Recommendation: re-run step 6 with a browser-capable environment (or via `cartSubmitForCompletion` + a real card-vault token, entirely through GraphQL, no browser needed) to close this out fully — the setup (cart, buyer identity, 800.0 CZK line) is already in place and does not need to be rebuilt.
- **Discount collision (Section D) surfaced a real, useful finding for Phase 2 design**, not a blocker: fixed B2B prices are not protected from stacking by `combinesWith` alone; a Shopify Function is the correct enforcement point if "no further discounts on catalog-priced lines" becomes a real requirement. This is scoped as a note for Phase 2, per the brief — no Function was built here.

---

### Artifacts

- `spikes/shopify-adapter-spike/writer.ts`, `normalizer.ts`, `test-products.ts`, `run-pricing.ts` — reused unchanged from Spike 1, re-run against the Plus store's IDs.
- Shopify objects created on `l-code-laboratory-tarif-plus.myshopify.com`: 1 `Company` (`.../10775331141`), 1 `CompanyLocation` (`.../22265299269`), 4 active `CompanyLocationCatalog`s (`.../192460489029`, `.../192460521797`, `.../192460554565`, `.../192460587333`), 1 `Publication` bound to catalog 1 (`.../362998333765`), 1 `PriceList` bound to catalog 1 (`.../32140263749`), 1 test `Product` (`SPIKE-A Plus`, `.../16097545552197`, variant `.../58879482134853`, SKU `SPIKE-A-PLUS`), 1 test `Customer` (`spike2-buyer@example.com`, `.../31003068465477`) assigned as `CompanyContact` with the "Location admin" role, 1 `StorefrontAccessToken`, 1 automatic discount created and deleted again during Section D's test.
