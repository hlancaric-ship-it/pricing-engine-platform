# Shopify Discovery — Phase 1 (rozšířená verze)

Rozsah: pochopit datový model a API možnosti Shopify natolik hluboko, aby šel navrhnout normalizer Shopify → `PricingInput` (Fáze 2) a zápisová/verifikační cesta `PricingResult` → Shopify (Fáze 3), beze změny existující pricing core logiky. Pouze GraphQL Admin API (REST je legacy). Stále čistě rešeršní dokument — žádný kód, žádný store, žádný adapter, žádné zápisy.

Referenční soubory z repa: `src/core/interfaces.ts` (`PricingInput`, `PricingResult`, `CustomerTier`), `src/core/customer-tier.ts` (`determineTier()`, platform-independent od kódu-přesunu ze Shoptet adapteru), `cloudflare-worker/src/coupon/tier-pricelist-map.ts` (existující Shoptet-adapter vzor: `TIER_PRICELIST_MAP` — mapování ZR tier → konkrétní Shoptet pricelist ID, žijící na hranici adapteru, ne v core). Tenhle poslední soubor je důležitý precedent: Shopify má koncept `PriceList`, který je se Shoptet "pricelistem" pojmově téměř identický — stejný vzor (`TIER_PRICELIST_MAP`-like mapování) lze na Shopify replikovat 1:1 na úrovni adapteru.

---

## 1. Shopify data model relevantní pro pricing

- `Product` → 1..N `ProductVariant`. Variant nese `sku`, `id` (`gid://shopify/ProductVariant/...`), `price`, `compareAtPrice`, `inventoryItem`. Base cena žije na variantě, ne na produktu.
- `Product.vendor` — nejbližší analog našeho `manufacturer`/brand.
- Kategorie: Shopify nemá striktní jednu-kategorii-na-produkt strom. Nejblíž je `Collection` (manuální nebo smart/rule-based), plus `ProductType` (volný text na produktu). Produkt může být v N kolekcích současně — to je zásadní strukturální rozdíl proti našemu `category: string` (singulární) v `PricingInput`.
- `Currency` — obchod má základní měnu, Markets pak přepočítávají zobrazenou cenu podle regionu/měny kupujícího (viz bod 5) — to je další vrstva mezi "uloženou" cenou a cenou, kterou zákazník skutečně vidí.
- `Customer`/`Company`/`CompanyLocation` — B2B objekty (Shopify Plus), viz bod 4 a 5.
- Query vstupní body: `product`, `products`, `productVariant`, `productVariants`, `customer`, `customers`, `company`, `companyLocation`.

## 2. Product mapping (tabulka)

| Náš `PricingInput` field | Shopify GraphQL objekt.pole | Typ | Vždy dostupné? | Omezení / poznámka |
|---|---|---|---|---|
| `sku` | `ProductVariant.sku` | `String` (nullable) | Ne — SKU je volitelné pole, obchodník ho nemusí vyplnit | Pokud SKU chybí, nutný fallback na `ProductVariant.id` jako klíč; naše core očekává `sku: string` jako povinný identifikátor — normalizer musí řešit prázdné SKU explicitně (chyba/skip/generovaný klíč) |
| — (variant identita) | `ProductVariant.id` (`gid://shopify/ProductVariant/{id}`) | `ID` | Ano, vždy | Skutečný stabilní primární klíč na Shopify straně; doporučeno nést vedle SKU jako interní referenci pro zápis (PriceList entries se váží na `variantId`, ne na SKU) |
| — (produkt identita) | `Product.id` (`gid://shopify/Product/{id}`) | `ID` | Ano | Potřebné pro některé mutace na úrovni produktu (metafieldy na produktu, ne variantě) |
| `basePrice` | `ProductVariant.price` | `Money`/`String` (decimálně formátovaný string) | Ano | Toto je Shopiho "výchozí" cena — jedna globální hodnota pro celý shop, ne per-tier. Musí se parsovat na `Decimal` (repo používá `decimal.js`) — string→Decimal konverze je bezpečná, string→float by nebyla |
| `salePrice` | `ProductVariant.compareAtPrice` | `Money`/`String`, nullable | Ne, často null | Sémanticky je to spíš "původní/přeškrtnutá cena" (Shopify UI zobrazuje slevu jako `compareAtPrice` > `price`), ne totéž co náš `salePrice` koncept (aktivní zlevněná cena k prodeji) — sémantika se neshoduje 1:1, nutná explicitní rozhodovací tabulka v Fázi 2, ne automatické mapování |
| `manufacturer` | `Product.vendor` | `String` | Ano, ale volný text bez validace | Obchodník může psát nekonzistentně ("Bosch" vs "BOSCH" vs "Bosch s.r.o.") — normalizer bude pravděpodobně potřebovat normalizační/mapovací tabulku, ne přímé mapování |
| `category` | Žádné přímé pole — `Collection` (N:M) nebo `Product.productType` (volný text, 1:1) | `String`/`Connection` | `productType` ano vždy (může být prázdný string), `Collection` členství proměnlivé | Toto je nejslabší bod mapování — viz bod 14/16, potřebuje explicitní rozhodnutí (primární kolekce? `productType`? metafield?) |
| `productMaxDiscount` | Žádné nativní pole — jedině metafield | — | Ne, muselo by se vytvořit | Viz bod 9 |
| `purchasePrice` | Žádné nativní pole (nákupní/cost cena) — `InventoryItem.unitCost` existuje jako blízký koncept | `MoneyV2`, nullable | Ne vždy vyplněno | `InventoryItem.unitCost` je nejbližší Shopify ekvivalent nákupní ceny, ale je to jiný objekt (přes `ProductVariant.inventoryItem`), ne totéž pole — ověřit, zda ho core potřebuje z Shopify, nebo zda `purchasePrice` zůstává čistě interní/PIM data mimo Shopify |
| `currency` | `Shop.currencyCode` (shop-level) nebo `ProductVariant.price` jako `MoneyV2 { amount, currencyCode }` v novějších API verzích | `CurrencyCode` enum | Ano | Pozor na Markets kontext — zobrazená měna zákazníkovi se může lišit od shop base currency (bod 5, 11) |
| `vatRate` | Žádné přímé pole na variantě — `Product.taxable` (bool) + shop/region tax settings, případně `TaxonomyCategory`-vázaná pravidla | — | Ne přímo | DPH sazba u Shopify je odvozená z tax nastavení shopu/regionu, ne uložená per-produkt jako sazba — pokud core potřebuje explicitní `vatRate`, musí přijít z jiného zdroje než Admin API (naše vlastní konfigurace) |

## 3. Customer mapping (tabulka)

| Náš potřebný vstup | Shopify GraphQL objekt.pole | Typ | Vždy dostupné? | Omezení / poznámka |
|---|---|---|---|---|
| identita zákazníka | `Customer.id` (`gid://shopify/Customer/{id}`) | `ID` | Ano | Primární klíč |
| e-mail | `Customer.email` | `String`, nullable | Ne vždy (guest/B2B kontakty mohou mít jiné vzory) | — |
| tagy | `Customer.tags` | `[String]` | Ano (může být prázdné pole) | Doporučený nosič tier-signálu (viz bod 4) — jednoduše čitelné, přímo použitelné v ShopifyQL segment query (`customer_tags CONTAINS 'ZR20'`) |
| segment | `Segment` (samostatný objekt, ne pole na Customer) — `segments` query, `customerSegmentMembers` | `SegmentConnection` | Ano jako mechanismus, ale segment je odvozený/dotazovaný, ne uložený atribut zákazníka | Segment je definován ShopifyQL WHERE-only query nad zákaznickými atributy (tagy, metafieldy, objednávkovými metrikami) — nejde o pole, které bychom "četli", je to dotaz, který se vyhodnocuje |
| objednávky | `Customer.orders` (Connection) | `OrderConnection` | Ano | Pro odvození celkového obratu je nutné iterovat/agregovat — Shopify nenabízí přímo "lifetime spend" jako jedno pole v Admin API bez B2B kontextu (viz další řádek) |
| celkový obrat | `Customer.amountSpent` (`MoneyV2`) | `MoneyV2` | Ano — existuje jako přímo dostupné agregované pole | **Ověřeno**: `Customer.amountSpent` je oficiální pole vracející celkovou útratu zákazníka v shop currency — toto je přímý zdroj pro `determineTier()` vstup, není nutné ručně sčítat `orders` connection |
| tier (ZR4…ZR25) | Žádné nativní Shopify pole — musí se odvodit nebo uložit | — | Ne | Dvě cesty: (a) odvodit za běhu z `amountSpent` přes `determineTier()` a nikam neukládat na Shopify stranu, (b) uložit odvozený tier jako `Customer.tags` (pro použití v segment-query) a/nebo metafield (pro audit). Doporučeno (a) jako zdroj pravdy + (b) jako promítnutý cache/signál pro Shopify-native mechanismy (segmenty, discount eligibility) — ne obráceně |
| B2B kontext | `Company`, `CompanyLocation` | objekty | Ne — jen Shopify Plus, jen pokud je zákazník založen jako B2B company/location, ne běžný B2C `Customer` | Klíčové omezení — viz bod 16 |

## 4. Customer tier mapping — datová cesta do existujícího `determineTier()`

`determineTier()` (v `src/core/customer-tier.ts`) je čistá funkce `(totalOrderValue: number) => CustomerTier | undefined` s pevnými prahy (0/100/300/500/700/1000/2000/5000/7000/10000). Tahle rešerše **nenavrhuje měnit tuto logiku** — jen popisuje, odkud přitéká `totalOrderValue`.

Navrhovaná datová cesta (bez implementace):

1. Adapter přečte `Customer.amountSpent.amount` (viz bod 3) — to je přímo Shopify-natívní "total spend" pole, měnové (`MoneyV2`), v shop base currency.
2. Hodnota se zparsuje na `number` (nebo přímo na `Decimal`, pokud `determineTier()` v budoucí revizi core přijme `Decimal` — mimo scope této rešerše) a předá do `determineTier(totalOrderValue)` beze změny.
3. Otevřená otázka k rozhodnutí v Fázi 2, ne teď: zahrnuje `Customer.amountSpent` všechny objednávky, nebo jen "zaplacené"/"fulfilled"? Shopify dokumentace k přesné definici agregace (hrubé tržby vs. čisté po vrácení) nebyla v této rešerši ověřena s vysokou jistotou — **nutno ověřit přesnou definici pole (zahrnuje refundy? zrušené objednávky? draft objednávky?) před tím, než se do něj core-vstup naváže naostro**, protože Shoptet `determineTier()` byl zjevně navázán na jinou (Shoptet-specific) definici obratu a rozdíl v definici by tiše posunul zákazníky mezi tiery.
4. Pokud by se ukázalo, že `amountSpent` nesedí definičně, alternativa je vlastní agregace přes `Customer.orders` connection s explicitním filtrem (např. jen `financialStatus: PAID`), ale to je nákladnější (paginace přes všechny objednávky každého zákazníka) a mělo by se řešit až po ověření, že `amountSpent` nestačí.
5. Výstup `determineTier()` (`CustomerTier | undefined`) se dál použije stejně jako dnes u Shoptet adapteru — `undefined` znamená žádný tier (ekvivalent Shoptet "guest"/`GUEST_PRICELIST_ID` patternu v `tier-pricelist-map.ts`) a Shopify analog by byl "žádný speciální PriceList/Catalog, zákazník vidí výchozí `ProductVariant.price`".

## 5. Customer-specific pricing možnosti

Tři nezávislé mechanismy, seřazené od nejsilnějšího/nejčistšího fitu po nejslabší:

**A. `PriceList` + `Catalog` scoped na `CompanyLocation` (B2B, Shopify Plus)** — viz bod 6. Ukládá skutečnou finální cenu per tier, dostupnou přes API i dřív, než zákazník cokoliv udělá.

**B. `Segment` (ShopifyQL) + automatický/kódový discount** — viz bod 7/8. Nefunguje jako uložená cena, ale jako sleva vyhodnocená při checkoutu. Dostupné na jakémkoli plánu (ne jen Plus).

**C. Shopify Functions (`discount.function.run`, `cart.function.run`)** — vlastní Wasm logika, může kombinovat libovolná pravidla (tier, brand cap, category cap) v jednom kroku při checkoutu, ale výsledná cena existuje jen efemérně v košíku/checkoutu — nejde ji dopředu vyčíst jako uloženou hodnotu bez simulace.

**Nepoužitelné:** přímá úprava `ProductVariant.price` — je to globální hodnota pro celý shop, ne per-zákazník. Potvrzeno, vyřazeno.

Storefront API navíc nabízí `@inContext` direktivu, která umí vrátit cenu kontextualizovanou pro konkrétního B2B kupujícího (customer access token + company location ID) — to je důležité pro bod 11 (verifikace), ne pro zápis.

## 6. Price lists / catalogy

- `PriceList` (mutace `priceListCreate`, `priceListFixedPricesAdd`/`Update`) — definuje ceny variant, buď jako pevné částky per variant, nebo jako procentuální úpravu vůči base ceně. **Procentuální mód nelze použít** pro naše účely — náš core produkuje finální absolutní cenu po aplikaci víc pravidel najednou (tier sleva, product/brand/category cap, coupon úprava), ne jedno čisté procento; potřebujeme fixed-price mód.
- `Catalog` (mutace `catalogCreate`/`catalogUpdate`) — určuje, kdo danou cenovou hladinu vidí. Kontext může být market, app, nebo (B2B) `CompanyLocation`. Max 250 location ID na jedno mutation volání, žádná hromadná operace nad víc lokacemi najednou — pro víc zákazníků na jednom tieru je nutné dávkování.
- Doporučený vzor 1:1 s existujícím `TIER_PRICELIST_MAP` (Shoptet adapter): jeden `PriceList`/`Catalog` pár na tier (ZR4…ZR25), analogicky k `TIER_PRICELIST_MAP: Record<string, number>` — jen místo Shoptet pricelist ID by šlo o Shopify `PriceList.id` (`gid://shopify/PriceList/...`). Tenhle vzor už v repu existuje a osvědčil se pro Shoptet — přenositelnost na Shopify je strukturálně čistá.
- **Blokující předpoklad: B2B (Company/CompanyLocation/Catalog-per-location) je Shopify Plus-only funkce.** Bez Plus tahle cesta není dostupná vůbec.

## 7. Discounts

- Automatic discounts a discount codes (`discountAutomaticBasicCreate`, `discountCodeBasicCreate`, atd.) — od API verze 2025-10 podporují `context` pole určující eligibilitu: všichni zákazníci, konkrétní zákazníci, nebo customer segmenty (max 100 segmentů na jeden discount).
- Kombinovatelnost slev řídí `DiscountCombinesWith` — hrubozrnné (product/order/shipping discount třídy), ne "je tato konkrétní položka už na svém stropu slevy".
- Shopify Functions (`discount.function.run`, Discount Function API) umí implementovat libovolně vlastní tiered/capped logiku ve Wasm, vykonávanou při checkoutu (pod 5ms) — jediná cesta, jak nativně vynutit "necouponovat položku už na max slevě", pokud to má hlídat samotný Shopify (viz bod 8, bod 16).

## 8. Coupons / discount codes

- Shopify ekvivalent našich kupónů = discount codes (`DiscountCodeNode`) s `context`-based eligibilitou na segmenty (viz bod 7) — tier-gating kupónů (jen ZR20/ZR25 = `LOCKED_COUPON_TIERS` v existujícím Shoptet kódu) mapuje čistě: segment "je v ZR20 nebo ZR25" (odvozený z tagů, viz bod 4) → gate na discount code.
- **Potvrzená mezera**: "kupón se nesčítá, pokud je produkt/brand/kategorie už na max slevě" nemá nativní Shopify ekvivalent v konfiguraci discount pravidel — vyžaduje buď (a) vlastní Shopify Function, která by v okamžiku checkoutu znala aktuální aplikovanou slevu a stropy (metafieldy), nebo (b) architektonické obejití: pokud PriceList cena už je finální vypočtená core hodnota (tier + capy), kupón na ni jednoduše nesmí sahat vůbec (mutually exclusive po SKU) — to je jednodušší, ale je to designové rozhodnutí, ne technický fakt, musí ho schválit Jan v Fázi 2.

## 9. Metafieldy

Účel: nesou libovolná vlastní data na Shopify objektech. Čtení/zápis přes GraphQL Admin API (`metafieldsSet` mutace pro zápis; `metafield(namespace:, key:)` singulární accessor nebo `metafields(first:)` connection pro čtení).

- **Namespace/typ constraints**: metafield definice (`MetafieldDefinition`, mutace `metafieldDefinitionCreate`) určuje datový typ, validační pravidla a přístupová oprávnění pro danou dvojici namespace+key. Bez definice lze metafieldy i tak zapisovat ad-hoc, ale bez validace/typové bezpečnosti a bez UI viditelnosti v adminu — pro produkční použití se doporučuje definice vytvořit explicitně.
- **Query cost**: GraphQL dotazy podléhají cost-based throttlingu (každé pole má bodovou cenu, součet nesmí přesáhnout limit bucketu) — čtení metafieldů zvyšuje cenu dotazu, ale žádné tvrdé číslo specificky pro metafieldy nebylo v této rešerši ověřeno s vysokou jistotou; nutno změřit v Fázi 2 spike.
- **Potvrzené omezení**: filtrování/vyhledávání variant *podle* hodnoty metafieldu není v GraphQL Admin API podporováno u variant (`metafields(query:)`/`metafields(key:)` na variantě vrací chybu) — lze číst metafield, když už znáte ID objektu, ale nelze se zeptat "dej mi všechny varianty, kde metafield X = Y" přímo. Nutná vlastní evidence na naší straně (core/db), ne spoléhání na Shopify jako zdroj pravdy pro "co má override".
- **Co by tam teoreticky šlo uložit (posouzení, ne doporučení k okamžitému použití)**:
  - customer tier — možné, ale tag je jednodušší a přímo query-fitovaný do ShopifyQL segmentů (bod 3); metafield by měl smysl jen pro doprovodná data (např. přesná snapshot hodnota `amountSpent` v okamžiku posledního sync, timestamp)
  - `productMaxDiscount` override — technicky ano (`Product` nebo `ProductVariant` metafield, typ `number_decimal`), ale duplikuje policy data, která core už zná; riziko drift mezi core konfigurací a Shopify metafieldem, pokud se nemění atomicky
  - audit ID / verze `PricingResult` — dobrý kandidát: metafield typu `single_line_text_field` nesoucí např. hash/verzi posledního zápisu, pro rekonciliaci (bod 11) — nízké riziko, žádná duplikace business logiky, jen operational metadata
  - Shrnutí: metafieldy jsou vhodné pro **operational/audit metadata** (verze, timestamp, ID posledního zápisu), ne pro **duplikaci policy dat** (limity, prahy) — ty musí zůstat v core, jinak vzniká druhý zdroj pravdy.

## 10. `PricingResult` → Shopify možnosti

Tři možnosti, konzistentní s bodem 5:

1. **`PriceList` fixed-price entries per tier** (doporučeno, viz bod 6) — `priceListFixedPricesAdd`/`priceListFixedPricesUpdate`, klíčováno na `variantId`. Vyžaduje Plus B2B.
2. **Discount-based** (segment + automatický/kódový discount v %) — funguje bez Plus, ale nese jen slevu, ne uloženou finální cenu; horší fit pro core, který počítá absolutní `finalPrice`.
3. **Shopify Function** — nejsilnější vyjadřovací síla (umí replikovat celou naši pravidlovou logiku ve Wasm), ale cena je efemérní (jen v košíku/checkoutu), vyšší inženýrská cena (build/deploy pipeline pro Wasm extension), a hůř se verifikuje/rekoncilíruje (bod 11), protože nejde dopředu vyčíst jako stav.

Rozhodnutí mezi 1 a 2 visí na potvrzení Plus plánu (bod 16) — bez toho nelze v Fázi 2 zamknout návrh.

## 11. Verification / reconciliation možnosti — **klíčová část, kterou první průchod nepokryl**

Tohle je jádro toho, co Jan nazývá "Price Truth" problémem: **Shopify API umí cenu uložit ≠ zákazník skutečně tuto cenu vidí a zaplatí.** Tenhle rozdíl je potřeba explicitně navrhnout, ne jen předpokládat, že se shoduje.

**Co API vrací (uložený stav):**
- `ProductVariant.price` — globální base cena, žádný customer kontext.
- `PriceList` položky přes `priceList.prices` connection — deklarovaná cena pro daný katalog/kontext, ale toto je pořád jen *deklarace*, ne potvrzení, že se skutečně použije (závisí na tom, jestli je zákazník správně přiřazen ke `CompanyLocation`, jestli katalog není překryt jiným pravidlem s vyšší prioritou, jestli není aktivní další discount, který se navíc sčítá/nesčítá).

**Co API umí vrátit jako "cenu, kterou zákazník skutečně vidí" (kontextualizovaná cena):**
- **Storefront API** s `@inContext` direktivou — umí vrátit cenu produktu kontextualizovanou pro konkrétního B2B kupujícího (customer access token + company location ID). Tohle je nejblíž tomu, co potřebujeme pro verifikaci: dotázat se "co by tenhle konkrétní zákazník viděl", ne jen "co je nastaveno v PriceListu".
- **Admin API přímý ekvivalent pro "zákazníkem viděná cena" nebyl v této rešerši nalezen s vysokou jistotou** — Admin API primárně vystavuje *konfiguraci* (PriceList, Catalog, discount pravidla), ne *vyhodnocenou* cenu pro konkrétní pár (zákazník, produkt) mimo B2B/Storefront kontext. Pro B2C segment/discount cestu (možnost 2 v bodě 5/10) je vyhodnocená cena patrně dostupná jen simulací v Storefront API košíku, ne přímým dotazem — **nutno ověřit v Fázi 2/spike, ne teď předpokládat**.

**Jak rozlišit "Shopify cenu transformoval" od "reálný pricing drift":**
- Rozdíl mezi `PriceList` deklarovanou cenou a Storefront-kontextualizovanou cenou, který **je vysvětlitelný** (např. Markets měnový přepočet, aktivní kombinovatelný automatický discount, zaokrouhlení Shopify UI) — není chyba, je to očekávaná transformace a musí být v reconciliation logice pojmenovaná a odečtená, ne nahlášená jako drift.
- Rozdíl, který **není vysvětlitelný** žádným ze známých Shopify mechanismů (Markets, kombinovatelné discounty, měnový přepočet) — to je skutečný pricing drift: buď se PriceList nesynchronizoval, nebo je zákazník přiřazen ke špatné `CompanyLocation`/katalogu, nebo Shopify aplikoval neočekávané pravidlo.
- Návrh (jen koncept, ne implementace): reconciliation job by měl pro vzorek (zákazník, SKU) párů porovnávat (core `PricingResult.finalPrice`) vs. (Storefront `@inContext` cena), s explicitním seznamem "povolených" transformací (měna, zaokrouhlení) odečtených před vyhodnocením shody — jinak bude report plný false positives.
- Metafield s verzí/hashem posledního zápisu (bod 9) pomáhá odlišit "ještě nesynchronizováno" od "synchronizováno, ale neshoduje se" — bez něj nejde rozlišit stale data od skutečné chyby.

**Nejistota k explicitnímu přiznání**: přesný rozsah toho, co Storefront `@inContext` umí vrátit mimo B2B kontext (tj. pro běžné B2C zákazníky na segment+discount cestě), nebyl v této rešerši ověřen s vysokou jistotou a je to zásadní pro to, jestli je verifikace vůbec proveditelná bez Plus B2B. **Toto je otevřený risk, ne vyřešená otázka.**

## 12. API možnosti a omezení

- GraphQL Admin API je jediná podporovaná cesta pro nové věci — REST Admin API je legacy od 1. října 2024, od 1. dubna 2025 musí nové veřejné aplikace používat výhradně GraphQL; starší REST přístup se postupně vypíná přes 2025–2026.
- API verze se pinuje explicitně (v souladu s repo pravidlem "žádné plovoucí upgrady") — ne `latest`.
- Cost-based rate limiting na GraphQL mutacích i queries — přesná čísla bucketů nebyla v této rešerši ověřena do detailu, nutný spike.
- Potřebné scopes (odhad na základě mapovaných mutací/queries výše): `read_products`/`write_products`, `read_price_lists`/`write_price_lists`, `read_customers`, `read_companies`/`write_companies` (B2B), `write_discounts` (kupóny), `read_metafields`/`write_metafields`.
- Setup: Partner účet + Development Store (s B2B funkcemi povolenými pro testování — v produkci B2B vyžaduje Plus). Custom app (privátní, store-scoped token) je nejjednodušší cesta, pokud zůstává single-store; Partner-registrovaná OAuth app jen pokud by měl adapter fungovat napříč víc obchody.

## 13. Doporučený adapter design (návrhový nákres, neimplementováno)

```typescript
// Návrh, ne implementace. Účel: vynutit stejnou hranici jako u Shoptet adapteru —
// core (PricingInput/PricingResult/determineTier) se nemění, platformní specifika
// žijí za tímto rozhraním.

interface EcommercePlatformAdapter {
  /** Přečte katalog a normalizuje na core vstup. Nečistí/nerozhoduje pricing logiku. */
  fetchProductsForPricing(params: { cursor?: string; limit?: number }): Promise<{
    items: RawPlatformProduct[];
    nextCursor?: string;
  }>;

  /** Normalizace jednoho platformního produktu/varianty na PricingInput. */
  normalizeToInput(raw: RawPlatformProduct, tier: CustomerTier | undefined): PricingInput;

  /** Zdroj obratu pro determineTier() — vrací číslo, ne tier; core rozhoduje tier. */
  fetchCustomerTotalSpend(customerId: string): Promise<number>;

  /** Zápis PricingResult zpět. Platform-specific: PriceList na Shopify,
   *  pricelist entry na Shoptet. Musí být idempotentní a dry-run-first. */
  writePricingResult(result: PricingResult, tier: CustomerTier, opts: { dryRun: boolean }): Promise<WriteOutcome>;

  /** Verifikace: co zákazník skutečně vidí, ne co je uloženo. Klíčové pro
   *  Price Truth — na Shopify by šlo přes Storefront @inContext, na Shoptet
   *  jinak. Musí explicitně vracet i "nelze ověřit" stav, ne jen boolean shodu. */
  verifyCustomerVisiblePrice(customerId: string, sku: string): Promise<{
    apiStoredPrice: Decimal;
    customerVisiblePrice: Decimal | null; // null = nešlo zjistit
    matches: boolean | "unknown";
    explainedDiff?: string; // pojmenovaná očekávaná transformace, pokud existuje
  }>;
}

interface WriteOutcome {
  sku: string;
  written: boolean;
  platformRef: string; // např. PriceList entry ID
  error?: string;
}
```

Poznámky k návrhu:
- `verifyCustomerVisiblePrice` je záměrně samostatná metoda, ne součást `writePricingResult` — Jan explicitně chce oddělit "co jsme zapsali" od "co zákazník vidí", to je celá podstata Price Truth.
- Rozhraní nepředpokládá, že každý adapter umí všechno stejně dobře — `customerVisiblePrice: Decimal | null` a `matches: boolean | "unknown"` explicitně přiznávají, že u Shopify B2C (bez Plus) verifikace možná není vůbec dostupná stejnou cestou jako u B2B.
- Toto je návrh k diskuzi pro Fázi 2, ne finální kontrakt — jméno, tvar a rozsah metod se v plánování pravděpodobně upřesní.

## 14. Co zůstává v core

- `determineTier()` a všechny prahové hodnoty — beze změny, jen jiný zdroj vstupního čísla (bod 4).
- `PricingPolicy` pravidla (loyalty, product/brand/category limit, rounding, validation) — beze změny, platformně agnostická.
- `RuleType`, `PricingCommand`, `EngineConfig` — beze změny.
- Policy data (max slevy per brand/kategorie/produkt) — zůstávají v core konfiguraci, **nekopírovat do Shopify metafieldů** jako zdroj pravdy (bod 9) — jinak vzniká druhý zdroj pravdy a riziko driftu.

## 15. Co patří do Shopify adapteru

- Normalizace `ProductVariant`/`Product` → `PricingInput` (mapovací tabulka bod 2).
- Normalizace `Customer.amountSpent` → vstup do `determineTier()` (bod 4).
- Tier → `PriceList`/`Catalog` mapování (analog `TIER_PRICELIST_MAP`, bod 6).
- Zápis `PricingResult.finalPrice` do `PriceList` fixed-price entries (bod 10).
- Tier-gating kupónů přes segmenty (bod 8).
- Verifikace přes Storefront `@inContext` (bod 11) — platformně specifická implementace `verifyCustomerVisiblePrice`.
- Operational metadata metafieldy (audit ID, verze, sync timestamp) — bod 9.

## 16. Otevřené otázky / rizika

1. **Blokující**: je/bude cílový Shopify obchod na Shopify Plus? Bez Plus padá celá B2B `Company`/`CompanyLocation`/`Catalog`-per-location cesta (body 5A, 6, 10.1) a s ní pravděpodobně i většina Storefront `@inContext` verifikace (bod 11) — nutno potvrdit před uzamčením návrhu Fáze 2.
2. Přesná definice `Customer.amountSpent` (zahrnuje refundy/zrušené/draft objednávky?) — neověřeno s vysokou jistotou, kritické pro korektní navázání na `determineTier()`.
3. Chybí nativní Shopify vyjádření "kupón se nesčítá s už maxovanou slevou" — vyžaduje buď custom Function, nebo architektonické obejití (mutually exclusive po SKU), design rozhodnutí pro Jana.
4. Kategorie: Shopify multi-membership Collections vs. náš singulární `category` string — potřeba explicitní mapovací rozhodnutí, ne automatické.
5. Metafieldy nejdou filtrovat/dotazovat podle hodnoty na variantách — bulk lookup musí jít přes vlastní evidenci nebo Bulk Operations export, ne přímý query.
6. Přesné GraphQL cost/rate limity pro hromadné `PriceList` zápisy napříč celým katalogem × 8-10 tiery neověřeny — nutný spike před odhadem výkonu Fáze 3.
7. Rozsah toho, co Storefront `@inContext` umí vrátit mimo B2B kontext, neověřen s vysokou jistotou — přímo ovlivňuje, jestli je verifikace (bod 11) proveditelná i bez Plus.
8. `salePrice`/`compareAtPrice` sémantický nesoulad (bod 2) — vyžaduje explicitní rozhodovací tabulku, ne předpoklad shody.

---

## Architecture conclusion

### CORE — co může zůstat beze změny
`PricingInput`/`PricingResult`/`PricingCommand`/`RuleType`/`EngineConfig` (`src/core/interfaces.ts`) a `determineTier()` (`src/core/customer-tier.ts`) nepotřebují žádnou úpravu pro Shopify. Celá pravidlová logika (loyalty sleva, product/brand/category stropy, zaokrouhlení, validace) je už platformně agnostická — to potvrzuje původní hypotézu, že je lze znovupoužít beze změny. Existující Shoptet adapter vzor (`TIER_PRICELIST_MAP` v `cloudflare-worker/src/coupon/tier-pricelist-map.ts`) navíc ukazuje, že tenhle typ hranice (core / adapter-specific mapování) už v repu funguje a je přenositelný.

### SHOPIFY ADAPTER — co musí být platform-specific
Normalizace produktů/variant/zákazníků (body 2–4), tier→PriceList/Catalog mapování a zápis (body 6, 10), segment-based coupon gating (bod 8), Storefront `@inContext` verifikace (bod 11), a operational metafieldy (bod 9). Tohle je zjevně samostatná, dobře ohraničená vrstva — žádný z těchto bodů nevyžaduje zásah do core.

### GAPS — co Shopify neumí nebo řeší zásadně jinak
- Žádné nativní pole "cena podle tieru" na variantě (řeší se PriceList, ale jen s Plus).
- Žádné nativní "kupón se nesčítá s už maxovanou slevou" pravidlo (řeší se Function nebo architektonickým obejitím).
- Kategorie jako multi-membership kolekce místo striktního stromu (řeší se explicitním mapovacím rozhodnutím).
- Žádný přímý, s vysokou jistotou ověřený Admin API dotaz na "cenu, kterou konkrétní B2C zákazník skutečně vidí" mimo B2B Storefront kontext — tohle je nejvážnější neznámá pro Price Truth verifikaci.

### RECOMMENDATION — jaký je nejčistší další krok
Než se Fáze 2 začne plánovat do detailu: **potvrdit Shopify Plus status cílového obchodu** (otázka 1 v bodě 16) — je to jediný fakt, který rozhoduje mezi "čistý fit" (PriceList/Catalog/CompanyLocation, silná verifikace přes Storefront `@inContext`) a "kompromisní fit" (segment+discount %, slabší nebo neověřená verifikace). Souběžně, jako levný a rychlý krok bez závislosti na Plus rozhodnutí: malý spike proti dev store ověřující (a) přesnou definici `Customer.amountSpent`, (b) chování Storefront `@inContext` bez B2B kontextu, (c) GraphQL cost limity na dávkových `priceListFixedPricesAdd` voláních. Tyto tři věci jsou v tuhle chvíli reálné neznámé, ne jen formality — bez nich nejde Fázi 2 zamknout s jistotou, kterou tenhle repo standardně vyžaduje ("Zero Error Tolerance").

---

## Spike 2: Price Truth & Customer.amountSpent Verification

Rozsah: definitivně ověřit dvě otevřené otázky ze Spike 1 (body 16.1/16.7 a 16.2) — čistě dokumentační rešerše proti shopify.dev, žádný kód, žádný store, žádná implementace.

### Price Truth (@inContext / contextualPricing)

**1. `@inContext` na Storefront API — přesné parametry (ověřeno)**

Direktiva `@inContext` se připojuje na `query`/pole a přijímá tyto parametry (zdroj: `shopify.dev/docs/storefronts/headless/building-with-the-storefront-api/in-context`):

- `country: CountryCode` — nastaví trh/měnu pro zobrazenou cenu (Markets), např. `@inContext(country: FR)`.
- `language: LanguageCode` — přepne jazyk přeloženého obsahu (title, description), např. `@inContext(language: ES)`.
- `buyer: BuyerInput` — objekt s:
  - `customerAccessToken: String!` (povinné) — identifikuje konkrétního přihlášeného zákazníka
  - `companyLocationId: ID` (volitelné) — pro B2B zákazníka s přístupem k víc lokacím určuje, za kterou lokaci se cena kontextualizuje
- `visitorConsent: VisitorConsentInput` — volitelné, cookie/consent preference zakódované do `checkoutUrl`, netýká se ceny.

**Kritické zjištění**: dokumentace `@inContext`/`buyer` explicitně a výhradně popisuje scénář "business customer buyer" — tedy B2B kontext. Žádná zmínka o obecném B2C customer-segment parametru na úrovni `@inContext`.

**2. `ProductVariant.price` vs `ProductVariant.contextualPricing` (ověřeno částečně)**

- `ProductVariant.price: MoneyV2!` — dle Storefront API dokumentace (`objects/ProductVariant`) popsáno jako prostě "The product variant's price." Bez `@inContext` je to shopová/výchozí cena, bez ohledu na konkrétního zákazníka — potvrzuje závěr Spike 1.
- `contextualPricing` **není pole na Storefront API `ProductVariant`** — nachází se na **Admin GraphQL API** jako `ProductVariant.contextualPricing(context: ContextualPricingContext!): ProductVariantContextualPricing!` (potvrzeno changelogem "Contextual pricing for products is now available in the GraphQL Admin API" a existencí objektu `ProductVariantContextualPricing` v Admin GraphQL referenci).
- `ContextualPricingContext` (input objekt, Admin GraphQL, ověřeno přímo z `shopify.dev/docs/api/admin-graphql/latest/input-objects/contextualpricingcontext`) má **přesně tři pole**:
  - `country: CountryCode` — "The country code used to fetch country-specific prices."
  - `companyLocationId: ID` — "The CompanyLocation ID used to fetch company location specific prices."
  - `locationId: ID` — "The Location ID used to fetch location specific prices." (fyzická/inventory lokace, ne zákazník)
  - **Žádné pole pro `customerId` ani `customerSegmentId`.** `contextualPricing` tedy neumí odpovědět na otázku "jakou cenu vidí zákazník X" — umí jen "jakou cenu vidí trh/měna Y" nebo "jakou cenu vidí B2B lokace Z". Toto je zásadní zjištění proti tomu, co by název pole naznačoval.

**3. Kritická otázka — může API vrátit reálnou cenu, kterou konkrétní B2C zákazník uvidí/zaplatí, včetně aktivních slev/segmentových cen? (ověřeno — NE, s výhradou)**

- Admin API: `contextualPricing` je omezené na country/companyLocation/location (bod výše) — neumí per-customer, natož per-B2C-customer s aktivními automatickými slevami.
- Storefront API `@inContext(buyer:)`: dokumentovaný use-case je výhradně B2B (`customerAccessToken` + volitelné `companyLocationId`, popsané jako "business customer buyer"). Nebylo nalezeno žádné potvrzení, že by tato cesta pro plain B2C zákazníka (bez Company) vracela cenu s promítnutými automatickými/segmentovými slevami — dokumentace o tom mlčí, což samo o sobě je signál, ne důkaz opaku.
- Ani `ProductVariant.price`, ani `contextualPricing` **nezahrnují automatické discounty ani discount kódy** — to je jednoznačně mimo scope obou polí; jsou to "list"/"deklarované" ceny, ne vyhodnocené cart/checkout ceny. Toto se dá odvodit spolehlivě z toho, že tato pole nemají žádný discount/coupon parametr a Shopify drží slevovou logiku striktně v Cart/Checkout vrstvě (Shopify Functions, `discountAutomaticBasicCreate` atd. — viz Spike 1 bod 7).
- **Závěr k bodu 3**: pro plain B2C zákazníka **žádné pole v Admin ani Storefront API nevrátí "skutečnou cenu, kterou zaplatí" včetně segmentových/automatických slev** dopředu, mimo simulaci v košíku/checkoutu. To, co API vrátí, je vždy nějaká vrstva "listové"/kontextové (měna, trh, B2B lokace) ceny — nikdy plně vyhodnocená finální částka pro anonymní/B2C zákazníka se všemi aplikovanými pravidly.

**4. Simulace přes `draftOrderCalculate` / Cart API (ověřeno částečně)**

- `draftOrderCalculate` (Admin GraphQL mutace, nezapisuje, jen počítá) — "calculates the properties of a DraftOrder without creating it and returns pricing information including line item totals, shipping charges, applicable discounts, and tax calculations based on the provided Customer and MailingAddress information" (zdroj: `shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderCalculate`). Přijímá `customerId` a umí zohlednit, zda se mají přijmout automatické slevy (`acceptAutomaticDiscounts`/obdobný přepínač).
- **Nejsilnější nástroj nalezený v této rešerši pro "predict actual price"** — na rozdíl od `price`/`contextualPricing` skutečně simuluje výpočet objednávky pro daného zákazníka, včetně slev a daní.
- **Nejistota, kterou nelze z dokumentace s vysokou jistotou uzavřít**: dokumentace nespecifikuje explicitně, zda `draftOrderCalculate` s daným `customerId` zohledňuje (a) zákazníkovy `tags`/segment-based automatické slevy, (b) B2B `PriceList`/`Catalog` přiřazené k jeho `CompanyLocation`, (c) storefront-only Shopify Functions vázané výhradně na cart/checkout kontext (např. funkce, které čtou cart attributes nedostupné v draft-order kontextu). Draft order je koncepčně administrátorský konstrukt (B2B/manuální objednávky), ne 1:1 replika zákaznického nákupního košíku — nelze bez přímého testu proti dev-store s aktivní automatickou slevou tvrdit, že vrátí identickou částku jako živý checkout.
- Cart API (Storefront) — bylo zmíněno ve Spike 1 jako "efemérní" cesta; tato rešerše nenašla specifickou dokumentaci k tomu, že by šlo Cart vytvořit/simulovat "na sucho" pro libovolného zákazníka bez skutečné accessTokenu/session téhož zákazníka — Cart je navázaný na `buyerIdentity`, což vyžaduje buď live customer token, nebo admin-side impersonaci, která nebyla v dokumentaci potvrzena jako podporovaná.

**5. Explicitní mezera mezi "API říká cena X" a "zákazník skutečně zaplatí X" (shrnutí)**

Potvrzené/odvoditelné mezery:
- **Automatické slevy a discount kódy**: nikdy nejsou součástí `price`/`contextualPricing`, jen `draftOrderCalculate`/skutečný checkout je počítá — a i tam s nejistotou u segment-specifických pravidel (bod 4).
- **Shopify Functions injektované v cart/checkout kroku** (custom Wasm logika) — dle Spike 1 bodu 5C existují mimo jakoukoli "dopředu čitelnou" hodnotu; nebyl nalezen způsob, jak je simulovat přes Admin/Storefront query bez skutečného průchodu checkoutem.
- **Currency conversion rounding** (Markets) — `@inContext(country:)` mění zobrazenou měnu/cenu, ale přesná zaokrouhlovací pravidla (rounding rules per market) nebyla v této rešerši nalezena v dokumentu s číselnou specifikací — jen potvrzeno, že přepočet existuje a je to legitimní, ne chybová transformace (viz Spike 1 bod 11).
- **Tax-inclusive vs tax-exclusive zobrazení** — cena vrácená API (`price`, `contextualPricing`) není v dokumentaci explicitně svázaná s vyhodnocenou daní pro konkrétního zákazníka/lokaci; daň se řeší separátně (shop/market tax nastavení), takže "zobrazená cena v obchodě" (může být tax-inclusive) se může lišit od holé `price` hodnoty z API bez dalšího zpracování.
- **App-injected diskonty** (třetí-stranové slevové aplikace mimo nativní Shopify discount engine) — mimo scope jakéhokoli zde zmíněného pole; nebyla nalezena žádná Shopify dokumentace garantující jejich viditelnost v API vůbec.

### Customer.amountSpent

**1–2. Přesná definice (ověřeno z Admin GraphQL API dokumentace, `shopify.dev/docs/api/admin-graphql/latest/objects/Customer`)**

- `Customer.amountSpent: MoneyV2!` — oficiální popis: **"The total amount that the customer has spent on orders in their lifetime."**
- Je to **lifetime** hodnota, ne rolling window — potvrzeno doslovným zněním "in their lifetime".
- **Nejistota, kterou nelze uzavřít s vysokou jistotou z veřejné referenční dokumentace**: přesný výpočetní vzorec (zahrnuje/nezahrnuje refundy, zrušené objednávky, draft objednávky, daně, dopravu, slevy) **není v poli-úrovňovém popisu specifikován**. Dokumentace uvádí jen jednu větu definice, bez rozpisu agregační logiky. To je stejný závěr jako Spike 1 bod 16.2 — tahle rešerše ho nedokázala rozlousknout s jistotou z dokumentace samotné, přestože to bylo cílem.
- Nepřímé signály (nižší jistota, z Shopify Help Center / komunitních zdrojů, ne z formální API reference): Shopify sales reporty obecně počítají s "open, archived, pending, and cancelled orders" a čistí net hodnoty po refundech pro reporting účely — ale to je jiný subsystém (Analytics/Reports), ne potvrzeně stejná logika jako `Customer.amountSpent`. **Nelze tvrdit rovnítko mezi těmito dvěma bez přímého empirického testu** (vytvořit objednávku, zrušit/refundovat ji, sledovat, jestli se `amountSpent` změní) — což je mimo scope čistě dokumentační rešerše.
- Související pole nalezená vedle `amountSpent`: `numberOfOrders: UnsignedInt64!` (lifetime počet objednávek) a `orders: OrderConnection!` (plný přístup k jednotlivým objednávkám pro vlastní agregaci, pokud by `amountSpent` nevyhovoval).

**3. Měnové chování**

- `amountSpent` je typu `MoneyV2`, což nese `amount` + `currencyCode` — dokumentace ho oficiálně nesvazuje explicitně s "shop base currency" na úrovni popisu pole samotného, ale `MoneyV2` obecně v Shopify API reprezentuje částku v konkrétní měně přiřazené k danému kontextu. Spike 1 (bod 3) uvádí `amountSpent` jako "v shop currency" — tato rešerše to nedokázala potvrdit jednoznačnou citací specifickou pro toto pole (na rozdíl od např. `PriceList` nebo `Order.totalPriceSet`, kde je shop-vs-presentment currency explicitně zdokumentovaná dvojicí polí `shopMoney`/`presentmentMoney`). **Otevřeno**: pokud obchod prodává ve víc měnách/marketech, není z dokumentace `amountSpent` samotné jisté, zda se přepočty do jedné referenční měny dějí Shopify-stranně konzistentně, nebo zda pole jen sčítá nominální částky bez ohledu na měnu objednávky (což by bylo nebezpečné). Toto je risk k explicitnímu ověření empirickým testem v Fázi 2, ne k předpokladu.

**4. Doporučení pro determineTier() input — viz samostatná sekce níže.**

### Doporučení pro determineTier() input

**Nedoporučuji navázat `determineTier()` přímo a naslepo na `Customer.amountSpent`** navzdory tomu, že je to nejpohodlnější a nejlevnější cesta (jedno pole, žádná paginace). Důvod: dvě klíčové neznámé zůstávají neověřené i po této druhé rešerši —
1. zda `amountSpent` odečítá refundy/zrušené objednávky (rozdíl mezi "hrubým" a "čistým" obratem — Shoptet-based `determineTier()` byl pravděpodobně navázán na jinou definici a tichý posun tieru je přesně to riziko, které "Zero Error Tolerance" pravidlo zakazuje),
2. zda je měnově konzistentní napříč markety/multi-currency prodejem.

**Konkrétní doporučení (dvoufázové, ne buď-anebo)**:
- **Krok A (levný, first-pass)**: použít `Customer.amountSpent` jako výchozí/rychlý signál, ale **empiricky ověřit na dev-store před navázáním na core** — vytvořit testovací objednávku, zrušit ji / refundovat ji, sledovat změnu `amountSpent`; vytvořit objednávku ve druhé měně (pokud multi-currency), ověřit, zda se `amountSpent` přepočítává konzistentně. Tohle je přesně ten "dry-run first" krok, který repo pravidla vyžadují — bez něj nelze nic navázat naostro.
- **Krok B (fallback, pokud test v kroku A odhalí nesoulad s naší definicí obratu)**: vlastní agregace přes `Customer.orders` connection s explicitním filtrem na `financialStatus` (typicky `PAID`, případně `PARTIALLY_REFUNDED` dle toho, jak se historicky počítal Shoptet obrat) a explicitním vyloučením `CANCELLED`/draft objednávek, sečtené z `Order.totalPriceSet.shopMoney.amount` (ne `presentmentMoney`, aby byla měna konzistentní napříč zákazníky). Nákladnější (paginace, cost budget), ale definičně kontrolovatelné a auditovatelné.
- Rozhodnutí mezi A a B se **nedá udělat čistě z dokumentace** (jak tahle rešerše ukázala) — vyžaduje jeden malý empirický test proti dev-store. To by mělo být první konkrétní krok Fáze 2 spike, ne odklad.

### Zdroje

- `@inContext` — https://shopify.dev/docs/storefronts/headless/building-with-the-storefront-api/in-context
- `ProductVariant` (Storefront API) — https://shopify.dev/docs/api/storefront/latest/objects/ProductVariant
- `ContextualPricingContext` (Admin GraphQL input object) — https://shopify.dev/docs/api/admin-graphql/latest/input-objects/contextualpricingcontext
- `ProductVariantContextualPricing` (Admin GraphQL) — https://shopify.dev/docs/api/admin-graphql/latest/objects/productvariantcontextualpricing
- Changelog: "Contextual pricing for products is now available in the GraphQL Admin API" — https://shopify.dev/changelog/contextual-pricing-for-products-is-now-available-in-the-graphql-admin-api
- Changelog: "Storefront API @inContext supports channelId" — https://shopify.dev/changelog/new-channelid-argument-for-incontext-directive-in-storefront-api-2026-10
- `draftOrderCalculate` (Admin GraphQL mutation) — https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderCalculate
- `CalculatedDraftOrder` (Admin GraphQL) — https://shopify.dev/docs/api/admin-graphql/latest/objects/CalculatedDraftOrder
- `Customer` (Admin GraphQL, pole `amountSpent`, `numberOfOrders`, `orders`) — https://shopify.dev/docs/api/admin-graphql/latest/objects/Customer
- Headless with B2B (kontext pro `@inContext(buyer:)`) — https://shopify.dev/docs/storefronts/headless/bring-your-own-stack/b2b

### Verdikt

**Price Truth NENÍ spolehlivě řešitelný čistě přes API pro plain B2C zákazníka — existuje neodstranitelná mezera, ověřená touto rešerší, ne jen domněnka ze Spike 1.** `ProductVariant.price` a Admin `contextualPricing` vracejí jen "list"/kontextovou (měna/trh/B2B-lokace) cenu, nikdy plně vyhodnocenou cenu s automatickými slevami, segment-pricing nebo Shopify Functions logikou pro anonymního/B2C zákazníka. `@inContext(buyer:)` je dokumentačně B2B-only konstrukce. Jediný nástroj, který se reálně blíží "predikci skutečné ceny", je `draftOrderCalculate` — ale i ten má nepotvrzenou přesnost vůči skutečnému storefront/checkout výpočtu (draft order ≠ zaručeně identická cesta jako živý cart). Pro 100% jistotu shody by bylo nutné buď (a) periodicky simulovat skutečný checkout (mimo scope čisté API integrace, křehké, nedoporučeno), nebo (b) architektonicky obejít problém tak, že Shopify **je** zdroj finální ceny (PriceList fixed-price entries = jediná aktivní cenová vrstva, žádné kombinovatelné automatické slevy navrch) — pak "co je v PriceItemu" a "co zákazník zaplatí" spadají do sebe z konstrukce, ne z verifikace. Tohle druhé (b) je jediná spolehlivá cesta k Price Truth, ne API-based verifikace posteriori.

**`Customer.amountSpent` je použitelný jako pracovní vstup pro `determineTier()`, ale ne bez jednoho levného empirického ověření na dev-store před naostrým nasazením** — dokumentace samotná nepotvrzuje s dostatečnou jistotou zacházení s refundy/zrušenými objednávkami ani měnovou konzistenci napříč markety, což jsou přesně ty detaily, kde by tichý rozdíl proti Shoptet-definici obratu posunul zákazníky mezi tiery bez varování.

---

## Spike 1: Shopify Plus Gate Verification

**Klíčové zjištění, které mění závěr Fáze 1**: hypotéza "B2B/`Company`/`CompanyLocation`/`PriceList`/`Catalog` = Shopify Plus-only" byla **vyvrácena**. Shopify B2B prošel v dubnu 2026 změnou ("B2B for all") a od té doby je nativně dostupný na Basic/Grow/Advanced plánech, ne jen na Plus. Tohle zásadně mění doporučení z bodu 16/RECOMMENDATION výše — Plus-gate je z velké části pryč pro core mechanismus (tier → PriceList), zůstává jen pro škálovací a pokročilé detaily.

### SHOPIFY STANDARD (Basic / Grow / Advanced)

Co jde použít jako persisted per-customer/per-tier cenu **bez Plus**:

- **`Company` + `CompanyLocation` (B2B zákazníci)** — plně dostupné na Basic/Grow/Advanced. Zdroj: `help.shopify.com/en/manual/b2b/getting-started/plan-features` — "Companies and company locations", "Quantity rules and price breaks", "Net terms", "Draft orders and reorders" atd. jsou uvedeny jako dostupné na všech placených plánech.
- **`Catalog` objekt** — dostupný na Basic/Grow/Advanced, ale s limitem: **max 3 aktivní katalogy napříč všemi B2B markety** ("On the Basic, Grow, and Advanced plans, you can assign up to 3 active catalogs across all your B2B markets" — `help.shopify.com/en/manual/b2b/getting-started/plan-features`, `help.shopify.com/en/manual/b2b/catalogs/creating-catalogs`). Tohle je **tvrdý strop** relevantní pro náš návrh — máme 8 ZR tierů (ZR4/6/8/10/14/16/20/25), tj. potenciálně 8 katalogů. Na Standard plánu se **8 tierů do 3 katalogů nevejde 1:1** bez úpravy návrhu (buď sloučit tiery do max 3 cenových hladin, nebo katalog sdílet přes víc tierů s jemnějším price-list dělením uvnitř).
- **`PriceList`** — jako objekt/API existuje nezávisle na B2B; používá se i pro Shopify Markets (měnové price listy per region), což **je dostupné na standardních plánech** — potvrzeno strukturálně přes `shopify.dev/docs/apps/build/markets/build-catalog` a `catalogs-different-markets` (Markets katalogy nejsou v žádné nalezené dokumentaci vázány na Plus). `PriceList` scoped na `CompanyLocation` (tj. přesně náš use-case tier→cena per zákazník) je součástí B2B `Catalog`/`CompanyLocationCatalog` mechanismu popsaného výš — a ten je od "B2B for all" **také dostupný na Standard**, jen s limitem 3 katalogů.
- **Co NENÍ dostupné na Standard**: přímé přiřazení katalogu jednotlivé company/location bez market wrapperu ("direct catalog assignment to companies/locations" je Plus-only dle více zdrojů), neomezený počet katalogů, partial payments/deposits, "contextual checkout and storefront customization through Shopify Markets" (to je dokonce Advanced+Plus, ne Basic/Grow — `help.shopify.com/en/manual/b2b/getting-started/plan-features`), custom Shopify Functions (vlastní Wasm discount/cart transform logika vyžaduje Plus — `shopify.dev/changelog/plus-merchants-can-now-start-building-with-shopify-functions`; pouze *předpřipravené* Function-apps z App Store fungují na všech plánech po instalaci, ne vlastní custom function).
- **Honest assessment**: na Standardu tedy jde postavit persisted per-tier cenu přes B2B `Company`→`CompanyLocation`→`Catalog`→`PriceList` (fixed price mód), ale **s tvrdým stropem 3 katalogů/price-listů současně napříč celým B2B marketem shopu** — což je architektonicky významné omezení proti 8 ZR tierům, ne triviální detail.

### SHOPIFY PLUS

Co přidá Plus navíc oproti Standard cestě:

- **Neomezený počet B2B katalogů** — řeší přímo problém "8 tierů = 8 katalogů" bez kompromisu.
- **Přímé přiřazení katalogu konkrétní company/location** (bez omezení přes market wrapper).
- **Custom Shopify Functions** (`discount.function.run`, `cart.function.run`) — vlastní Wasm logika pro cokoliv, co B2B PriceList nepokryje (např. "kupón se nesčítá s už maxovanou slevou", bod 8/16.3 výše).
- **Partial payments, deposity, kontextová checkout/storefront customizace** — méně relevantní pro pricing-core use-case, spíš pro platební/UX flow.

### Zdroje

- `help.shopify.com/en/manual/b2b/getting-started/plan-features` — oficiální matice B2B funkcí podle plánu (Basic/Grow/Advanced vs Plus), včetně limitu 3 katalogů a seznamu funkcí dostupných na všech plánech.
- `help.shopify.com/en/manual/b2b/getting-started/considerations` — potvrzuje, že B2B je dostupné na "Basic, Grow, Advanced, and Shopify Plus" plánech (ne jen Plus).
- `help.shopify.com/en/manual/b2b/catalogs/creating-catalogs` — detail limitu 3 aktivních katalogů napříč B2B markety na non-Plus plánech.
- `shopify.dev/docs/apps/build/b2b` — API-side poznámka: přístup k B2B GraphQL Admin API resources je omezen na dev stores, Shopify Plus Partners a Shopify affiliates (partnerský/vývojářský rámec, ne totéž jako "merchant musí mít Plus plán" — merchant plán je oddělená otázka od toho, kdo smí vyvíjet/testovat přes partner účet).
- `shopify.dev/docs/api/admin-graphql/latest/objects/pricelist`, `.../objects/Company`, `.../objects/CompanyLocation`, `.../objects/CompanyLocationCatalog` — datový model PriceList/Company/CompanyLocation/Catalog vazeb.
- `shopify.dev/docs/apps/build/markets/build-catalog`, `.../markets/catalogs-different-markets` — PriceList/Catalog použití pro Markets (měnové price listy), nezávisle na B2B/Plus.
- `shopify.dev/changelog/plus-merchants-can-now-start-building-with-shopify-functions` — potvrzení, že custom Shopify Functions jsou vázané na Plus.
- `shopify.com/news/b2b-for-all` — oznámení změny politiky (B2B rozšířeno na všechny placené plány).
- Ceny Shopify plánů (kontext, sekundární): Basic ~$39/měs (~$29 roční), Grow ~$105/měs (~$79 roční), Advanced ~$399/měs (~$299 roční), Plus od ~$2 300/měs (typicky s minimální roční revenue-based smlouvou, orientačně relevantní od ~$1–2M ročního obratu) — tahle čísla pocházejí z sekundárních zdrojů (shopify.com/pricing agregátorů), ne přímo z shopify.dev, brát jako orientační kontext, ne jako ověřený fakt na úrovni ostatních citací výše.

### Verdikt

**ČÁSTEČNĚ.** Hypotéza "tier → `PriceList`/`Catalog`" **je použitelná i na Standard (Basic/Grow/Advanced) plánu** — B2B mechanismus (`Company`/`CompanyLocation`/`Catalog`/`PriceList` s fixed-price módem) tam od aktualizace "B2B for all" reálně existuje a není vázaný na Plus. Není to ale beze zbytku 1:1 fit jako v původním (nesprávném) předpokladu "bez Plus to nejde vůbec" ani jako v opačném extrému "funguje to úplně stejně jako na Plus":

- Blokující strop na Standardu: **max 3 aktivní katalogy napříč celým B2B marketem** vs. 8 ZR tierů. Návrh z bodu 6/13 výše ("1 PriceList/Catalog pár na tier, 1:1 analog `TIER_PRICELIST_MAP`") **musí se na Standardu upravit** — buď (a) sloučit 8 ZR tierů do max 3 cenových skupin na úrovni katalogu (ztráta granularity), nebo (b) zjistit, zda lze víc price-listů/fixed-price sad namapovat do jednoho catalogu s jemnějším rozlišením per company location (k ověření v dalším spiku — nebylo v této rešerši potvrzeno s vysokou jistotou, zda `Catalog`-limit počítá price-listy nebo katalogy jako takové vs. kolik `PriceList` objektů lze mít přiřazeno k jedné company location nezávisle na katalogovém stropu).
- Plus tenhle strop řeší úplně (neomezené katalogy) a navíc dává custom Shopify Functions pro věci, co PriceList nepokryje (coupon-cap logika, bod 16.3).

**Praktický důsledek pro Jana**: adapter architektura (`EcommercePlatformAdapter`, bod 13) **nemusí čekat na rozhodnutí "Plus nebo nic"** — dá se stavět i na Standard plánu, jen s vědomím katalogového stropu 3, který je potřeba vyřešit v Fázi 2 designem (redukce tierů na úrovni katalogu, nebo přechod na Plus, pokud 8 samostatných cenových hladin je tvrdý požadavek). Tohle je jiný a mnohem příznivější závěr, než co naznačoval bod 16.1/RECOMMENDATION v původní verzi dokumentu ("bez Plus celá cesta padá") — ta věta je tímto spikem **opravena**, ne jen doplněna.
