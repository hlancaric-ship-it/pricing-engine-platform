# Discount-lock pattern

## Problém

Na každé platformě, kterou jsme živě testovali, platí totéž: zápis `PricingResult.finalPrice`
jako "fixed" nebo "override" cena **neznamená uzamčenou cenu**. Další slevový mechanismus
(coupon, automatic discount, promotion) může tuhle cenu přebít, pokud se to výslovně neošetří.

Živě potvrzeno:
- **Shopify** (`SHOPIFY-SPIKE-2-PLUS-RESULTS.md`, sekce D): 10% automatic discount s
  `combinesWith: {orderDiscounts: true, ...}` naskáče navrch fixed B2B ceny. `combinesWith`
  samo o sobě cenu nechrání.
- **Medusa** (`MEDUSA-SPIKE-RESULTS.md`, test 5): generický promo kód aplikovaný na cart
  s override cenou 800 skutečně stáhl `total` na 720. `unit_price` zůstal 800, ale total ne.

Dokumentačně přiznané / předpokládané na dalších platformách:
- **Magento** (`MAGENTO-DISCOVERY.md`): dokumentace sama přiznává, že Cart Price Rules
  se aplikují nad Catalog/Tier Price i se zapnutým "Stop Further Rules Processing".
- **commercetools** (`COMMERCETOOLS-DISCOVERY.md`): CartDiscount/ProductDiscount se dají
  stackovat, jediná pojistka je `DiscountCombinationMode: Best Deal` (bere nižší cenu,
  není to zámek).

## Princip řešení

Cena z core je **jediná autoritativní cenová vrstva**. Adapter musí buď:

1. **Zabránit tomu, aby na daný SKU/tier vůbec mohla existovat kombinovatelná sleva** —
   nejčistší řešení, platformně specifické:
   - Shopify: **Shopify Function** na `discount.function.run` targetu, která explicitně
     vyloučí lines s aktivní B2B catalog cenou z dalšího discountování. `combinesWith`
     flag na úrovni discount objektu nestačí — to je jen deklarace záměru, ne vynucení.
   - Medusa: promotion pravidla scoped na `customer.groups.id` tak, aby se nikdy nekryla
     s tiery, pro které existuje override PriceList — nebo custom `calculateLineItemPrice`
     validace v checkout flow, která odmítne promotion na SKU s aktivním override.
   - Magento: vypnout Catalog Price Rules pro produkty se Shared Catalog / Tier Price
     zápisem, cart-level coupony scopovat mimo tyto SKU.
   - commercetools: `DiscountCombinationMode: Best Deal` jako slabší pojistka, nebo
     custom checkout logika (headless — Jan by ji psal sám), která `scopedPrice`
     ověří před finalizací objednávky.

2. **Nebo, pokud (1) není prakticky proveditelné hned**: verifikovat před finalizací
   objednávky, že se cena neposunula (`verifyPrice()` v `EcommercePlatformAdapter`),
   a odmítnout/eskalovat objednávku, kde `verifiedPrice !== expectedPrice`. Tohle je
   záchranná síť, ne řešení — nemělo by být trvalý stav pro produkční nasazení.

## Co NENÍ řešení
- Spoléhat na to, že klient/obchodník "prostě nevytvoří" kolidující slevu. Potvrzeno
  živě dvakrát, že to jde omylem udělat i bez zlého úmyslu (běžný automatický discount).
- Řešit to v `src/core` — core o platformě neví a vědět nemá. Tohle je vždy adapter-side
  odpovědnost.

## Stav implementace
Zatím **neimplementováno** pro žádnou platformu jako vynucující mechanismus — obě
produkční implementace (`src/adapters/shopify`, `src/adapters/medusa`) mají
`writeLockedPrice()` pojmenovanou podle záměru, ale bez skutečného zámku (bod 1).
Tohle je jediná zbývající systémová mezera před tím, než lze tvrdit "produkčně hotovo"
pro Shopify nebo Medusa adapter.
