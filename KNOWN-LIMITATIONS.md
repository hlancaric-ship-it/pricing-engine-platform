# Known Limitations

## 2026-08-14 — TIER_PRICELIST_MAP ve výstupní vrstvě coupon writes

`compute-coupon-writes.ts` stále importuje `TIER_PRICELIST_MAP` z
`cloudflare-worker/src/coupon/tier-pricelist-map.ts` pro doplnění Shoptet
`pricelistId` na výstupní položky (`CouponWriteItem`).

Samotná customer-tier a coupon computation logika už na Shoptet ID závislá
není — smyčka je řízena obecným seznamem `ALL_CUSTOMER_TIERS` z core
(`src/core/customer-tier.ts`). `TIER_PRICELIST_MAP` se používá jen jako
output/platform mapping v okamžiku sestavení výstupu, ne jako zdroj iterace
nebo vstup do výpočtu slevy.

Kompletní odstranění této vazby (přesun mappingu za hranici volajícího) by
zasáhlo cca 24 dalších call-sites v `cloudflare-worker/src/cli/`. To je mimo
scope aktuálního refaktoru (viz `pricing-engine-platform` repo, commity
`7daf722` a `5041724`) a je odloženo do fáze návrhu platform adapteru
(Shopify experiment).
