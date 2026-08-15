# commercetools Discovery — Phase 1 (rešeršní dokument)

Rozsah: pochopit datový model a API možnosti commercetools natolik hluboko, aby šel navrhnout normalizer commercetools → `PricingInput` (Fáze 2) a zápisová/verifikační cesta `PricingResult` → commercetools (Fáze 3), beze změny existující pricing core logiky. Pouze rešerše — žádný kód, žádný store, žádný adapter, žádné zápisy.

Referenční soubory z repa: `src/core/interfaces.ts` (`PricingInput`, `PricingResult`, `CustomerTier`), `src/core/customer-tier.ts` (`determineTier()`). commercetools je API-first/headless MACH platforma (managed SaaS, ne self-hosted) — architektonicky nejblíž tomu, co chceme, protože **price-per-customer-group je u ní first-class koncept přímo v datovém modelu**, ne bolt-on přes discount engine jako u Shopify/BigCommerce.

---

## 1. commercetools data model relevantní pro pricing

- `Product` → 1..N `ProductVariant`. Variant nese `sku`, `id` (číselné, per-projekt), `prices` (pole `Price` objektů — **klíčový rozdíl proti Shopify/BigCommerce**: ne jedna cena, ale pole cen s různým scope).
- `ProductType` — definuje atributy produktu (analog `manufacturer`/`category` by šly jako custom atributy na `ProductType`, ne nativní pole).
- `Category` — striktní strom kategorií (N:M přes `categories` pole na produktu) — bližší normálnímu e-shop modelu než Shopify Collections.
- `Channel` — distribuční/prodejní kanál, další scope dimenze pro `Price`.
- `CustomerGroup` — samostatný resource, first-class scope pro `Price`.
- `Customer` — B2C i B2B (přes `BusinessUnit`/`Associate` model jako add-on, viz bod 6).
- Vstupní body: HTTP API (REST-like), GraphQL API (jeden endpoint), Import API (bulk).

## 2. Product mapping (tabulka)

| Náš `PricingInput` field | commercetools objekt.pole | Typ | Vždy dostupné? | Poznámka |
|---|---|---|---|---|
| `sku` | `ProductVariant.sku` | `String`, nullable | Ne — SKU je volitelné, ale typicky vyžadované konvencí projektu | Fallback na `ProductVariant.id` (číselné, per-projekt) jako interní klíč |
| `basePrice` | `Price.value` (na variantě bez `customerGroup`/`country`/`channel` scope — "výchozí" cena) | `Money`/`CentPrecisionMoney` | Ano, pokud existuje aspoň jedna neomezená cena | Cena je v **centech** (`centAmount`), ne v decimálním stringu jako Shopify — konverze na `Decimal` musí dělit `fractionDigits` |
| `salePrice` | `Price.discounted` (výsledek aplikace `ProductDiscount`) nebo `Price.tiers` (množstevní slevy) | `DiscountedPrice`/`PriceTier[]` | Ne vždy | `discounted` je odvozené pole (výsledek ProductDiscount enginu), ne nezávisle zapisovatelná hodnota — sémanticky nejde 1:1 namapovat na náš `salePrice` (aktivní zlevněná cena k zápisu) |
| `customerTier`-scoped cena | `Price.customerGroup` (Reference na `CustomerGroup`) | `Reference` | Ano jako mechanismus | Toto je přesně to, co chceme: samostatná `Price` entry s `customerGroup` referencí na "ZR20" atd. — viz bod 5 |
| `manufacturer` | Custom atribut na `ProductType` (typicky `brand` nebo `manufacturer` attribute, volitelně `LabelType` s referencí na samostatný `Category`/`ProductSelection`) | `AttributeDefinition` | Ne nativně — musí existovat v `ProductType` schématu projektu | Musí se ověřit proti konkrétnímu `ProductType` (žádné univerzální pole) |
| `category` | `Product.categories` (N:M reference na `Category`) | `Reference[]` | Ano, ale N:M | Stejný problém jako u Shopify Collections — potřeba rozhodnout primární kategorii nebo custom atribut |
| `productMaxDiscount` | Žádné nativní pole — Custom Field na `Product`/`ProductVariant` (via Types API) nebo `ProductType` atribut | — | Ne, muselo by se vytvořit | Viz bod 8 — commercetools Custom Fields jsou k tomu explicitně navržené |
| `purchasePrice` | Žádné nativní pole (cost cena) | — | Ne | Musí zůstat mimo commercetools, nebo Custom Field |
| `currency` | `Price.value.currencyCode` (`Money.currencyCode`, ISO 4217) | `String` | Ano, per-Price | Jedna `Price` = jedna měna; multi-currency = více `Price` entries |
| `vatRate` | `TaxCategory`/`TaxRate` (samostatný resource, přiřazený k produktu přes `taxCategory`) | — | Ne přímo na `PricingInput` úrovni | commercetools má explicitní `TaxCategory`/`TaxRate` model (na rozdíl od Shopify) — bližší k tomu, co core potřebuje, ale je to jiný resource, ne pole na `Price` |

## 3. Customer mapping (tabulka)

| Náš potřebný vstup | commercetools objekt.pole | Typ | Vždy dostupné? | Poznámka |
|---|---|---|---|---|
| identita zákazníka | `Customer.id` | `String` (UUID) | Ano | Primární klíč |
| e-mail | `Customer.email` | `String` | Ano | — |
| tier/skupina | `Customer.customerGroupAssignments` (od verze podporující multi-group; starší `Customer.customerGroup` singulární) | `CustomerGroupAssignment[]`/`Reference` | Ano jako mechanismus | Zákazník může být přiřazen až k **500 CustomerGroups** současně (nutné rozhodnout primární skupinu pro naše účely) |
| objednávky | `Order` (samostatný resource, `customerId` reference) | query přes Orders API | Ano | Standardní Order API, celý lifecycle (`OrderState`, `PaymentState`, line items) |
| celkový obrat | **Žádné vestavěné agregované pole** (na rozdíl od Shopify `Customer.amountSpent`) | — | Ne — nenalezeno v dokumentaci | **Neověřeno/chybí**: commercetools nemá nativní "lifetime spend" pole na `Customer`. Musela by se stavět vlastní agregace přes Orders API (paginace + filtr na `orderState`/`paymentState`), analogicky k tomu, co by Shopify vyžadoval, kdyby `amountSpent` neexistoval |
| tier (ZR4…ZR25) | Žádné nativní pole — musí se odvodit nebo uložit | — | Ne | Cesta: (a) odvodit `determineTier()` z vlastní Order-agregace, (b) zapsat výsledný tier jako `CustomerGroup` assignment (přímo použitelné pro `Price` scoping!) a/nebo Custom Field pro audit |

## 4. Customer tier mapping — datová cesta do existujícího `determineTier()`

`determineTier()` zůstává beze změny — čistá funkce `(totalOrderValue) => CustomerTier | undefined`.

1. Na rozdíl od Shopify (`Customer.amountSpent`) commercetools nemá agregované "total spend" pole — adapter by musel iterovat `Order` resource (Orders API, filtrováno `customerId`, případně `orderState`/`paymentState`) a sčítat přes stránkování.
2. Součet se předá do `determineTier(totalOrderValue)` beze změny logiky.
3. Výsledný `CustomerTier` se promítne jako `CustomerGroup` assignment na zákazníka (viz bod 3) — tohle je zásadní rozdíl proti Shopify: tady tier-přiřazení **přímo řídí** which `Price` entry se vybere (bod 5), není to jen tag pro segment-query.
4. Otevřená otázka: jaká přesná definice "obratu" (hrubý/čistý, zahrnuje refundy?) se má z Orders agregovat — nutno ověřit až ve Fázi 2, analogicky k otevřené otázce u Shopify.

## 5. Customer-specific pricing možnosti — Price object deep dive

Toto je architektonicky nejsilnější bod commercetools oproti všem předchozím platformám:

- `ProductVariant.prices` je **pole** `Price` objektů (až 100 na variantu), každý se scope kombinací: `currency` (povinné), `country`, `customerGroup` (Reference na `CustomerGroup`), `channel` (Reference), `validFrom`/`validUntil`.
- commercetools odmítne přidat `Price`, pokud už existuje se stejnou kombinací scope, nebo pokud se překrývají validity okna se stejným scope — vestavěná ochrana proti konfliktním cenám na úrovni API (analog naší `assertNoCrossFileConflicts`, ale řešený platformou samotnou).
- **Price selection** (viz bod 12 dole) je deterministický sekvenční fallback: nejdřív hledá přesnou shodu `customerGroup` + `channel` + `country` (+ aktuálně platný time-bound), pak postupně méně specifické kombinace, až po base cenu bez omezení.
- Prakticky: pro `PricingResult.finalPrice` bychom zapsali samostatnou `Price` entry se `customerGroup` = referencí na "ZR20" `CustomerGroup` a nechali platformu, ať ji vybere nativně při dotazu s `priceCurrency`+`priceCustomerGroup` parametry (Product Projection Search / Price Selection).
- `Price.tiers` — množstevní ceny (quantity breaks) v rámci jedné `Price` — bonus koncept, který core momentálně nepoužívá, nutno explicitně ignorovat/nezapisovat, aby nekolidoval.

## 6. Plan/tier gating — kritické srovnání se Shopify Plus a BigCommerce Enterprise

**Neověřeno s vysokou jistotou.** commercetools v roce 2026 přešel z čistě usage-based (API calls/objednávky) modelu na explicitní plánovou strukturu — veřejná pricing stránka (`commercetools.com/pricing`) zmiňuje plány (Core Commerce, Foundry, Premium, Enterprise Custom podle sekundárních zdrojů: Core Commerce ~$3333/rok, Foundry ~$8333/rok, Premium ~$12500/rok, Enterprise Custom ~$25000/rok — tato čísla pocházejí ze sekundárních SaaS-pricing agregátorů, ne přímo z commercetools stránky, **nutno ověřit přímo se sales**). Oficiální stránka výslovně necharakterizovala `CustomerGroup`/`Price` scoping jako gated feature — jmenované add-ony jsou B2B (Business Units, role-based permissions, quote management), Premium Support, Audit Log Premium, další regiony/konektory, Checkout, performance testing, HIPAA.

**Důležitý závěr, i s výhradou neověřenosti**: `Price`, `CustomerGroup` a jejich scope-kombinace jsou součástí **core Composable Commerce API** (Product/Pricing modul), ne add-onu. To je zásadně jiná situace než Shopify Plus (B2B/company pricing striktně gated) nebo BigCommerce (Price Lists striktně Enterprise-only bez workaroundu). Pokud se toto potvrdí, commercetools by byla **první platforma bez plán-gatingu na základní price-per-customer-group mechanismus** — ale confirmace vyžaduje buď sales rozhovor, nebo trial-účet test (mimo rozsah této rešerše).

## 7. Discounts — CartDiscounts a ProductDiscounts vs. customer-group-scoped Price

- **ProductDiscount** aplikuje se na `Price` a mění `Price.discounted` — je to slevový mechanismus na úrovni produktu/varianty, nezávislý na `customerGroup` scope Price (může se aplikovat i na už customer-group-scoped cenu).
- **CartDiscount** aplikuje se na `LineItem` v košíku, řízeno predikátem (`isMatching`), `DiscountCombinationMode` v projektu (**Stacking** vs. **Best Deal**):
  - Stacking: Product Discount se aplikuje první, Cart Discount navrch — stejné riziko kumulace jako u Shopify/Medusa.
  - Best Deal: platforma spočítá výsledek oběma cestami a použije tu s nižší cenou — nezabraňuje kombinaci, jen volí lepší výsledek pro zákazníka.
- **Nenalezen žádný mechanismus, který by `Price` úplně vyjmul z dalšího discountování.** Jediná nalezená ochrana: `Price.tiers` (množstevní ceny) se ignorují, pokud je cena už zlevněná Product Discountem — ale to je jiný mechanismus (tiers), ne obecná "exempt from discount" vlastnost pro naši `customerGroup`-scoped cenu.
- Prakticky: pokud commercetools projekt má nakonfigurované aktivní `CartDiscount`s s predikátem, který matchuje i naše ZR-tier zákazníky, sleva se přičte navrch stejně jako u Shopify (`DraftOrder`) a Medusa (discount codes). **Řešení stejné jako u ostatních platforem**: adapter/projekt musí zajistit, že žádný aktivní `CartDiscount` predikát nematchuje zákazníky s přiřazenou ZR `CustomerGroup`, nebo použít `DiscountCombinationMode: Best Deal` jako částečnou pojistku (ne garanci).

## 8. Custom Fields / Custom Types pro tier/audit metadata

- Custom Fields se definují přes samostatnou **Types API** (`FieldDefinition` + `FieldType`), a přiřazují k libovolnému "customizable" resource (dokumentace explicitně zmiňuje Products a Customers jako příklady; obecně platí pro většinu core resources projektu).
- Podporované typy: `Boolean`, `Number`, `String`, `LocalizedString`, `LocalizedEnum`, `Money` (`CentPrecisionMoney`), `Date`/`Time`/`DateTime`, `Reference`, `Set`.
- Prakticky: `productMaxDiscount`, audit stopa (`appliedRules`, timestamp posledního engine-writu, `rejected`/`warnings` z `PricingResult`) by šly jako Custom Fields na `Product`/`ProductVariant` — čistě aditivní, bez zásahu do core schema. Toto je stejný vzor jako Shopify metafieldy nebo Medusa metadata, jen s formálnějším typovým systémem (validace typu na úrovni platformy, ne volný JSON blob).

## 9. `PricingResult` → commercetools write možnosti

- Zápis `finalPrice` = `Add Price` nebo `Change Price` update action na `ProductVariant`, s `customerGroup` referencí na příslušnou ZR `CustomerGroup` a `country`/`channel` ponechané prázdné (pokud nemáme důvod je scopovat).
- commercetools API je striktně **optimistic-concurrency-controlled** (každý resource má `version` pole, update vyžaduje aktuální verzi) — vestavěná ochrana proti race-condition zápisům, silnější než co Shoptet/Shopify nabízí nativně.
- Update actions jsou atomické v rámci jednoho requestu (více akcí lze poslat v jednom POST na produkt, aplikují se sekvenčně a buď projdou všechny, nebo žádná) — dobrý základ pro "dry-run diff" pattern z `CORE_LOGIC_AND_VALIDATION.md`: lze simulovat sadu update actions, sestavit diff, a až pak odeslat.
- Neexistuje nativní "bulk price update" endpoint mimo Import API (pro velké objemy je doporučený `Import API`, ne opakované jednotlivé `POST /products/{id}` volání).

## 10. Price Truth — eliminuje headless SaaS Price Truth gap?

commercetools je explicitně headless: Jan by stavěl/kontroloval storefront a checkout logiku sám (žádný vestavěný "Online Store" jako Shopify, žádný hostovaný checkout jako defaultní cesta — ačkoliv commercetools nabízí volitelný `Checkout` produkt jako add-on). To je architektonicky blíž Medusa (self-hosted) než Shopify/BigCommerce (SaaS storefront s vlastní check-out logikou mimo naši kontrolu):

- **Cena, kterou API vrátí přes Price Selection, je deterministická** (viz bod 5/12) — pokud checkout logiku píše Jan, může garantovat, že se použije přesně vybraná `Price.value`, bez skryté platformové transformace.
- **Ale**: pokud v projektu běží aktivní `CartDiscount`/`ProductDiscount` (bod 7), Price Truth gap se neeliminuje úplně — je to riziko na úrovni discount-konfigurace projektu, ne na úrovni frontendu/checkoutu jako u Shopify.
- Rozdíl proti Medusa: commercetools je managed SaaS (Jan negarantuje běh infrastruktury, ale získává SLA/škálování), Medusa je self-hosted (Jan garantuje běh, ale má plnou kontrolu nad kódem včetně možnosti patchnout discount-stacking logiku přímo). commercetools takovou možnost nemá — discount enginu se nedá zabránit patchem, jen konfigurací (`DiscountCombinationMode`, predikáty).

## 11. Verification/reconciliation možnosti

- Product Projection Search / `productProjections/search` s parametry `priceCurrency`, `priceCountry`, `priceCustomerGroup`, `priceChannel` vrací **vybranou** cenu podle Price Selection logiky přímo v odpovědi (`scopedPrice`/`scopedPriceDiscounted` pole) — to je přímý verifikační nástroj: dotázat se "jakou cenu by viděl zákazník v ZR20" a porovnat s `PricingResult.finalPrice` bez nutnosti simulovat celý checkout.
- `Price.value` + `Price.discounted` lze číst přímo přes standardní `GET /products/{id}` bez nutnosti vytvářet testovací objednávku — silnější verifikační pozice než Shopify (kde bylo nutné ověřovat přes `Customer.amountSpent`/`DraftOrder` simulaci).

## 12. API surface & omezení

- **HTTP API** (REST-like, JSON) — primární rozhraní, `version`-based optimistic concurrency na všech resources.
- **GraphQL API** — jeden endpoint, stejné API Clients/auth jako HTTP API, umožňuje přesně specifikovat vracená pole (omezuje over-fetching).
- **Import API** — bulk ingest (produkty, ceny, zákazníci) — vhodné pro hromadnou počáteční synchronizaci tier-pricingu, ne pro průběžné jednotlivé zápisy.
- Oficiální SDK: `@commercetools/platform-sdk` + `@commercetools/ts-client` (TypeScript/Node.js), historicky i `commercetools-sdk-typescript` monorepo — přímo použitelné z existujícího TS stacku repa.
- Auth: OAuth2 client-credentials flow (API Client scoped per projekt) — standardní, žádné Shoptet-style rate-limit hádanky zmíněné v dokumentaci (rate limity existují, ale jsou dokumentované per-projekt/scale-tier, ne skrytě objevené).

## 13. Doporučený adapter design (návrhový nákres, neimplementováno)

```
commercetools adapter (mimo core)
├── normalizer: ProductVariant + Price[] + Customer → PricingInput
│     - basePrice = Price bez customerGroup/country/channel scope, centAmount / 10^fractionDigits
│     - customerTier = odvozeno z Customer.customerGroupAssignments (mapováno na CustomerTier enum)
│     - category = primární Category z Product.categories (rozhodnutí ve Fázi 2)
│     - manufacturer = ProductType custom atribut (per-projekt schema)
├── tier-customerGroup-map (analog TIER_PRICELIST_MAP)
│     - ZR4..ZR25 → CustomerGroup ID/key
├── writer: PricingResult → Add/Change Price update action
│     - scope: { currencyCode, customerGroup: Reference }
│     - dry-run: sestavit update actions, nechat je projít lokální diff-fuse před POST
├── verifier: productProjections/search?priceCustomerGroup=... → porovnat scopedPrice s PricingResult.finalPrice
└── audit: Custom Field na ProductVariant/Product (appliedRules, timestamp, warnings)
```

## 14. Co zůstává v core

- `determineTier()`, `PricingEngine`, všechny `PricingPolicy` implementace — beze změny.
- `PricingInput`/`PricingResult` typy — beze změny (`Decimal`-based, platform-agnostic).

## 15. Co patří do commercetools adapteru

- Price Selection query parametrizace, `CustomerGroup` mapping, Custom Field schema (Types API definice), Import API vs. jednotlivé update actions rozhodnutí podle objemu, verifikační dotazy přes `productProjections/search`.

## 16. Otevřené otázky / rizika

1. **Plán-gating na `CustomerGroup`/`Price` scoping — neověřeno s jistotou.** Veřejná dokumentace ani pricing stránka nezmiňují gating explicitně, ale komerční struktura (Core Commerce/Foundry/Premium/Enterprise) nebyla feature-by-feature ověřena proti tomuto konkrétnímu mechanismu. Nutno ověřit se sales nebo trial účtem před závazným rozhodnutím.
2. Chybí nativní "lifetime spend" pole na `Customer` (na rozdíl od Shopify `amountSpent`) — vyžaduje vlastní Orders-API agregaci, což je dodatečná implementační zátěž oproti Shopify cestě.
3. Přesná definice "obratu" pro Orders-agregaci (hrubý/čistý, zahrnuje refundy/zrušené objednávky?) — stejná otevřená otázka jako u Shopify, musí se řešit ve Fázi 2.
4. `DiscountCombinationMode` a aktivní `CartDiscount`/`ProductDiscount` predikáty v konkrétním projektu nebyly zkoumány (žádný live trial účet v rámci této rešerše) — riziko kolize se zjišťuje až na konkrétním projektu.
5. Cenová struktura commercetools (řádově $40k–$300k+/rok podle sekundárních zdrojů, medián $151k/rok) je o řád vyšší než Shopify Plus nebo BigCommerce Enterprise — ekonomická proveditelnost pro okfish.sk je samostatná otázka mimo scope technické rešerše.
6. `ProductType` atributové schéma (kde by žily `manufacturer`/`category`) nebylo ověřeno na konkrétním demo-projektu — commercetools nemá univerzální pole, každý projekt si schema definuje sám, což znamená normalizer musí být per-projekt konfigurovatelný.

## Architecture conclusion

commercetools je jediná ze zkoumaných platforem, kde je **price-per-customer-group nativní, first-class datový koncept přímo v Product/Pricing modelu** (`Price.customerGroup`), ne odvozený mechanismus postavený nad discount enginem (Shopify Markets/B2B catalogy), ani gated add-on (BigCommerce Price Lists Enterprise-only). Zápis `PricingResult.finalPrice` jako samostatné `Price` entry scoped na `CustomerGroup` je architektonicky nejčistší fit ze všech čtyř zkoumaných platforem — commercetools byla doslova navržená pro tenhle use-case (headless B2B/multi-tier komerce).

Zbývají ale dvě reálné rezervy oproti "vyřešeno": (1) plán-gating na tento mechanismus není s jistotou vyvrácen — veřejná dokumentace o něm mlčí, ale mlčení není potvrzení; (2) discount-collision riziko (CartDiscount/ProductDiscount stacking nad customer-group cenou) je strukturálně **stejné jako u Shopify a Medusa** — commercetools nemá žádný nalezený mechanismus, který by `Price` učinil imunní vůči dalšímu discountování, jen `DiscountCombinationMode: Best Deal` jako částečnou zmírňující pojistku. Price Truth gap je nicméně nejmenší ze zkoumaných SaaS platforem (spolu s Medusa), protože Jan by stavěl checkout logiku sám a mohl by dotazem na `scopedPrice` přímo verifikovat, co zákazník skutečně uvidí — bez závislosti na cizí storefront implementaci.

Cenová dostupnost (řádově desítky až stovky tisíc dolarů ročně, sales-led kontrakty) je zásadní praktická bariéra nezávislá na technické analýze.
