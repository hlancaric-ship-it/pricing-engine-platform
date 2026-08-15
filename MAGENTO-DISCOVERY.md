# Magento / Adobe Commerce Discovery

Cíl: ověřit, jestli hypotéza "stejný Pricing Core + tenký platformní adapter = stejná deterministická cena" platí i pro Magento Open Source / Adobe Commerce / Adobe Commerce B2B, a hlavně: **který pricing mechanismus vyžaduje kterou (placenou) edici.**

Zdroje: Adobe Experience League dokumentace (`experienceleague.adobe.com/en/docs/commerce-admin`, `developer.adobe.com/commerce`) přes websearch — bez přímého přístupu k instanci, žádný spike proti reálnému API. Vše níže je z dokumentace/veřejných zdrojů, ne z ověřeného live volání — na rozdíl od Medusy, kde šlo číst zdrojový kód.

## 1. Data model relevantní pro pricing

Magento/Adobe Commerce rozlišuje tři vrstvy cen na produktu:
- **Base price** — přímé pole na produktu (`price` atribut), website-scope.
- **Special price** — časově ohraničená sleva (od–do datum), přímé pole, funguje jako Shopify `compareAtPrice`/`salePrice` analog.
- **Advanced pricing** — souhrnný pojem pro Special Price + Tier Price + Customer Group Price, spravovaný přes "Advanced Pricing" modal v adminu.

Zdroj: [Advanced pricing](https://experienceleague.adobe.com/en/docs/commerce-admin/catalog/products/pricing/pricing-advanced).

## 2. Product mapping (tabulka)

| Magento pole | `PricingInput` |
|---|---|
| `price` (base price) | `basePrice` |
| `special_price` | `salePrice` |
| SKU | `sku` |
| Attribute set / kategorie | `category` |
| Manufacturer atribut (custom, není core) | `manufacturer` — **neexistuje jako core pole**, na rozdíl od Shopify `vendor`; nutný custom EAV atribut nebo mapování na kategorii |
| Tier Price záznam (qty + customer group) | základ pro `productMaxDiscount`/per-tier override, viz bod 3 |

Poznámka: Magento nemá nativní "brand/manufacturer" pole jako Shopify — je to buď custom atribut (běžná praxe), nebo se odvozuje z kategorie. Nutno počítat s dalším mapovacím krokem v adapteru.

## 3. Customer mapping (tabulka)

| Magento entita | `PricingInput`/tier logika |
|---|---|
| `Customer` | zákazník |
| `Customer Group` (`customer_group_id`) | nejbližší analog `customerTier` — ale je to **vstup** do cenových pravidel, ne výstup dopočtu (viz bod 4) |
| Company (B2B modul) | seskupení zákazníků do firmy, s vlastní `Shared Catalog` přiřazenou |

Customer Group je v Magentu primárně mechanismus pro *segmentaci*, ne pro *automatický přepočet podle historie útraty* — na rozdíl od Shoptet ZR-tierů, které vznikají z `determineTier()`.

## 4. Customer tier mapping — datová cesta do existujícího `determineTier()`

Magento **nemá** nativní pole "lifetime spend"/"total spent" na `Customer` entitě (stejný gap jako u BigCommerce a Medusy, na rozdíl od Shopify `Customer.amountSpent`). Cesta k `determineTier()` vstupu:

- Vlastní agregace přes `Sales Order Grid`/`sales_order` tabulku (REST `orders` search s `customer_id` filtrem a součtem `grand_total`), analogicky k BigCommerce/Medusa řešení.
- Není známa žádná standardní Adobe Commerce feature, která by toto počítala automaticky a vystavovala jako pole — nutno ověřit, zda B2B modul (Company credit limit tracking) nenabízí něco blízkého, ale to je odlišný koncept (kreditní limit, ne kumulativní historie).

Po dopočtu `CustomerTier` (`ZR4`…`ZR25`) je nutné mapování `CustomerTier → Customer Group ID`, analogicky k tier→`price list ID` mapování na ostatních platformách.

## 5. Tier Pricing — je v Open Source, nebo Commerce-only?

**Tier Pricing (qty-based i customer-group-based) je součástí Magento Open Source (free), není to Commerce-exkluzivní feature.** Nastavuje se přes Advanced Pricing modal na produktu — kombinace qty breaks (např. "10 % sleva při 10+ ks") a volitelně customer group scope (website scope, pokud multi-website instalace).

Tohle je zásadní rozdíl oproti BigCommerce (Price Lists = Enterprise-only) — Magento dává základní customer-group cenovou diferenciaci zdarma už v Open Source.

**Ale** — Tier Pricing je navázaná na **kvantitu** (qty breaks), ne čistě na "zákazník v tieru dostane pevnou cenu bez ohledu na množství". Dá se nastavit qty=1 s tier cenou pro danou customer group, což funguje jako fixní přepis ceny, ale sémanticky to zůstává "quantity price break" mechanismus, ne dedikovaný "price list po zákaznické skupině" objekt jako Shopify `PriceList`/BigCommerce `Price List`/Medusa `PriceList`.

Zdroj: [Advanced pricing](https://experienceleague.adobe.com/en/docs/commerce-admin/catalog/products/pricing/pricing-advanced).

## 6. Adobe Commerce B2B's Shared Catalogs — přesné gating

**Shared Catalogs jsou B2B-modulem, který je součástí Adobe Commerce (placená edice), a NENÍ dostupný v Magento Open Source.** Zároveň platí: B2B modul (Company accounts, Shared Catalogs, Negotiated Quotes, Requisition Lists, Purchase Orders) je u Adobe Commerce **zahrnutý v licenci bez dalšího poplatku navíc** — tedy není to samostatně prodávaný add-on nad Commerce, jak by mohl naznačovat název "B2B pro Adobe Commerce", ale je nedostupný, pokud provozujete Open Source.

Mechanismus: Shared Catalog = kurátorovaný katalog (podmnožina produktů) s vlastním pricing — buď **Fixed Price**, **Percentage discount/markup z base ceny**, nebo **Tier Price** v rámci katalogu — přiřaditelný ke konkrétní `Company` (skupině zákazníků). Existují dva typy: `Custom` (gated, jen pro přiřazené firmy) a `Public` (nahrazuje výchozí katalog pro hosty/nepřiřazené zákazníky).

Toto je nejbližší analog k Shopify `Catalog`+`PriceList` a BigCommerce `Price List` — **ale je zamčené za plnou cenou Adobe Commerce licence** ($32k–$125k/rok on-premise, $55k–$190k+/rok cloud dle veřejných odhadů), ne za samostatným "B2B add-on" poplatkem.

Zdroje: [Shared catalog overview](https://experienceleague.adobe.com/en/docs/commerce-admin/b2b/shared-catalogs/catalog-shared), [Set shared catalog pricing and structure](https://experienceleague.adobe.com/en/docs/commerce-admin/b2b/shared-catalogs/define/catalog-shared-pricing-structure), [Manage Shared Catalogs tutorial](https://league.adobe.com/docs/commerce-learn/tutorials/b2b/shared-catalogs.html?lang=en).

## 7. Catalog Price Rules vs. Cart Price Rules — stacking riziko

- **Catalog Price Rule**: aplikuje se na produkt/kategorii *před* vložením do košíku (analog Shopify Automatic Discount na úrovni produktu), bez kupónu.
- **Cart Price Rule**: aplikuje se v košíku/checkoutu, může vyžadovat kupón kód.
- **Zdokumentované riziko stackingu**: Catalog a Cart Price Rules se mohou skládat i přes nastavení "Stop Further Rules Processing" na "Yes" — konkrétně kupónové Cart Price Rule se aplikuje na cenu **už sníženou** Catalog Price Rule, ne na base cenu. Toto je přesně stejná třída rizika jako Shoptet native aditivní stacking, kterému se tento engine architektonicky vyhýbá zápisem přímo do wholesale pricelistů.
- Community workaround: ručně dopočítat, jestli Cart Price Rule dává lepší slevu než už aplikované Catalog Price Rule, a aplikovat jen rozdíl — což je manuální obcházení chybějící nativní ochrany, ne řešení dodané platformou.

Analog k Shoptet situaci: pokud tier-based override cena zapsaná Core enginem žije jako Tier Price/Shared Catalog cena, kupón (Cart Price Rule) se na ni pravděpodobně aplikuje navrch bez blokace — **stejné riziko jako u Shopify a Medusa** (kupón se skládá nad override cenou), pokud není explicitně nastaveno "Discard subsequent rules" a ověřeno, že to skutečně zabraňuje i coupon-on-top scénáři (dokumentace naznačuje, že i to selhává).

Zdroje: [Catalog Price Rules vs Cart Price Rules](https://webiators.com/catalog-price-rules-vs-cart-price-rules-in-magento2/), [Prevent Catalog And Cart Rules From Stacking](https://www.foobl.com/blog/2013/10/catalog-shopping-cart-pricing-rules-stacking).

## 8. Customer entity / lifetime-spend field

Viz bod 4 — **žádné nativní pole**. Nutná custom agregace přes Sales Order data (REST `orders` search API nebo přímý DB dotaz při self-hosted on-premise instanci). Adobe Commerce B2B nabízí Company-level "credit limit" tracking, ale to je jiný koncept (spotřebovaný kredit, ne kumulativní historický obrat) a není potvrzeno, že by šel přemapovat na Shoptet definici obratu bez vlastní logiky.

## 9. API surface (REST/GraphQL) pro programový zápis cen

- **REST**: dedikovaný `TierPriceStorageInterface` service pro hromadný zápis tier cen (base/special/tier/cost) jedním voláním přes více produktů. Existuje i specifický KB návod na update Shared Catalog cen přes REST API.
- **GraphQL**: primárně určený pro storefront queries (čtení), ne pro zápis cen — psaní cen (včetně Shared Catalog) je dokumentováno přes REST, ne GraphQL mutace. Nový SaaS "Catalog Service" GraphQL schema existuje pro čtení produktového katalogu, ale B2B/core Commerce GraphQL schémata dle zdrojů nativně neinteragují (nutný API Mesh most, pokud by šlo o kombinaci).
- Pro účel tohoto enginu (zápis tier/override cen) je tedy **REST cesta jasná a dokumentovaná**, GraphQL zápis pro tento use-case není relevantní.

Zdroje: [Manage prices for multiple products](https://developer.adobe.com/commerce/webapi/rest/modules/catalog/catalog-pricing), [Update shared catalog prices using REST API](https://experienceleague.adobe.com/en/docs/commerce-knowledge-base/kb/how-to/update-shared-catalog-prices-using-rest-api), [GraphQL API reference](https://developer.adobe.com/commerce/webapi/graphql/reference/).

## 10. Price Truth — resolvuje se tier/group cena spolehlivě přes cart/checkout, nebo je tam mezera?

**Není ověřeno end-to-end** (na rozdíl od Shopify Spike 2 a Medusa confirm) — zůstává na úrovni dokumentace, ne live testu. Konkrétní otevřené otázky:
- Dokumentace potvrzuje, že Shared Catalog cena má prioritu nad Customer Group cenou ("Any custom pricing indicated in the shared catalog has priority over customer group pricing") — to je dobrý signál pro deterministické chování *mezi* mechanismy.
- Ale bod 7 ukazuje zdokumentovaný stacking bug/risk mezi Catalog a Cart Price Rules, který přímo ohrožuje "cena v košíku == cena zapsaná enginem" garanci.
- Bez přístupu k živé instanci nelze potvrdit, zda tier/shared-catalog cena skutečně a spolehlivě protéká přes cart price calculation stejně, jako se zobrazuje na PDP — to je přesně třída otázky, kterou u Shopify řešil Spike 2 (`@inContext`/`contextualPricing`) a u Medusy šlo ověřit čtením zdrojového kódu. U Magenta/Adobe Commerce **ani jedna cesta nebyla v této rešerši provedena** — flag jako neověřeno, ne jako vyřešeno.

## 11. Verifikace/reconciliace možnosti

Teoreticky dostupné cesty (nepotvrzeno prakticky):
- REST `products` / `tier-prices` GET endpointy pro zpětné čtení zapsaných cen.
- Shared Catalog specifické GET endpointy pro čtení custom cen v katalogu.
- Self-hosted on-premise varianta (Open Source i Commerce on-prem) umožňuje přímý DB read jako nejsilnější verifikační cestu — analog k Medusa code-level auditovatelnosti, ale jen pokud Jan provozuje on-premise, ne Adobe-hostovaný Cloud.

## 12. API možnosti a omezení (shrnutí)

- REST auth: OAuth 1.0a nebo token-based (integration tokens), standardní Magento vzor.
- Rate limiting: není v této rešerši specificky ověřeno (na rozdíl od Shopify, kde je dobře zdokumentované) — flag jako otevřená otázka.
- Bulk operace: REST nabízí async bulk endpoints pro velké dávky (relevantní pro sync přes celý katalog × 10 tierů, podobně jako u ostatních platforem).

## 13. Self-hosted (Open Source) varianta — je to viabilní paralela k Meduse?

**Částečně.** Magento Open Source je zdarma a self-hostovatelný, se stejnou code-auditability výhodou jako Medusa (přímý DB/kód přístup). **Ale klíčový rozdíl**: Open Source **nemá Shared Catalogs** (bod 6) — nejčistší analog k Shopify `PriceList`/BigCommerce `Price List`/Medusa `PriceList` tam prostě není. Co Open Source nabízí zdarma:
- Tier Pricing (bod 5) — funguje, ale je vázaná na qty-break sémantiku, ne na čistý "price list per tier".
- Customer Group scoping — funguje.
- Catalog Price Rules — funguje, ale se stejným stacking rizikem jako v Commerce (bod 7).

Takže self-hosted Open Source *je* viabilní cesta k nulovým licenčním nákladům, ale s méně čistým pricing-mechanismem než Shared Catalogs — je to spíš analog k "Shopify Basic bez Plus" nebo k tomu, jak by vypadal engine, kdyby musel replikovat logiku přes Tier Price qty=1 triky místo nativního price-list objektu.

## 14. Doporučený adapter design (návrhový nákres, neimplementováno)

```
MagentoAdapter
├── normalizeProduct(magentoProduct) → PricingInput
│   ├── basePrice ← product.price
│   ├── salePrice ← product.special_price
│   ├── manufacturer ← custom EAV atribut (mapování nutné)
│   └── category ← product.categories[0]
├── resolveCustomerTier(customerId) → CustomerTier
│   ├── agregace sales_order grand_total přes customer_id (vlastní implementace)
│   └── determineTier(totalOrderValue) [BEZE ZMĚNY z core]
├── tierToTargetMapping: Record<CustomerTier, SharedCatalogId | CustomerGroupId>
└── writePricingResult(result, tier)
    ├── cesta A (Commerce + B2B): zápis do Shared Catalog custom price (REST, bod 6+9)
    └── cesta B (Open Source): zápis do Tier Price záznamu pro danou Customer Group, qty=1 (bod 5, 13)
```

Cesta A je čistší (přímý analog k ostatním třem platformám), cesta B je fallback, pokud Jan zůstane na Open Source a nechce platit Commerce licenci.

## 15. Co zůstává v core

`PricingInput`/`PricingResult`/`PricingCommand`/`RuleType`/`EngineConfig` (`src/core/interfaces.ts`) a `determineTier()` (`src/core/customer-tier.ts`) nepotřebují žádnou úpravu — čtvrté nezávislé potvrzení normalizovatelnosti vstupu/výstupu napříč platformami, i když samotný zápisový mechanismus (bod 14) je u Magenta rozvětvený na dvě cesty podle edice.

## 16. Co patří do Magento/Adobe Commerce adapteru

Normalizace produktu a manufacturer-mapování (bod 2), vlastní Order-agregace obratu (bod 4, stejná zátěž jako BigCommerce/Medusa), tier→`SharedCatalog`/`CustomerGroup` mapování, REST bulk zápis (bod 9), a edice-závislá volba mezi Shared Catalog (Commerce+B2B) a Tier Price qty=1 trikem (Open Source).

## 17. Otevřené otázky / rizika

1. Price Truth end-to-end (bod 10) — není ověřeno, jen dokumentačně naznačeno; vyžaduje spike proti reálné instanci.
2. Přesné chování "Stop Further Rules Processing" u kupónu nad Shared Catalog/Tier cenou — dokumentace naznačuje selhání i s touto ochranou (bod 7), potřeba live ověřit.
3. Rate limiting REST API — neověřeno v této rešerši.
4. Zda Company credit-limit tracking (B2B) jde přemapovat na Shoptet definici "obrat" — nejasné, pravděpodobně ne bez vlastní agregace.
5. Adobe Commerce Cloud vs. on-premise: jen on-premise dává plnou DB-level auditovatelnost; Cloud varianta je blíž SaaS modelu jako Shopify/BigCommerce.

## Architecture conclusion

### CORE — co může zůstat beze změny
`PricingInput`/`PricingResult`/`PricingCommand`/`RuleType`/`EngineConfig` (`src/core/interfaces.ts`) a `determineTier()` (`src/core/customer-tier.ts`) — čtvrté nezávislé potvrzení hypotézy napříč platformami. Magento/Adobe Commerce nevynucuje žádnou změnu core rozhraní.

### ADOBE COMMERCE / MAGENTO ADAPTER — co musí být platform-specific
Normalizace produktu + manufacturer-mapping (bod 2), custom Order-agregace obratu (bod 4), tier→Shared Catalog/Customer Group mapování, REST-based bulk zápis cen (`TierPriceStorageInterface`, bod 9), a **edice-závislé rozvětvení zápisové cesty** — to je jedinečné oproti ostatním třem platformám, kde byla zápisová cesta jednotná bez ohledu na plán (jen otázka, jestli je vůbec dostupná).

### GAPS — co Magento/Adobe Commerce neumí nebo řeší zásadně jinak
- Žádné nativní lifetime-spend pole (stejný gap jako BigCommerce/Medusa).
- Žádné nativní manufacturer/brand pole (stejný gap jako Medusa).
- Zdokumentovaný, ne jen teoretický stacking risk mezi Catalog/Cart Price Rules a kupóny i při "Stop Further Rules" nastavení — nejexplicitnější zdokumentovaná verze tohoto rizika ze všech čtyř platforem.
- Price Truth end-to-end **nebylo možné ověřit** touto rešerší (žádný live přístup, žádný auditovatelný zdrojový kód jako u Medusy) — je to největší otevřená mezera v jistotě oproti ostatním třem discovery dokumentům.
- Nejčistší analog k price-listu (Shared Catalog) je striktně B2B-modul, tedy Commerce-exkluzivní — Open Source fallback (Tier Price qty=1) je funkční, ale sémanticky méně čistý.

### COMPARISON TO OTHER THREE — plan-gating story a Price Truth jistota

**Plan-gating**: Magento/Adobe Commerce je hybrid mezi BigCommerce a Medusou. Základní customer-group cenová diferenciace (Tier Pricing) je **zdarma v Open Source** — na rozdíl od BigCommerce, kde je Price Lists tvrdě Enterprise-only bez žádného free ekvivalentu. Ale nejčistší, nejbližší analog k price-listu (Shared Catalog) je **zamčený za plnou Commerce+B2B licencí** ($32k–$190k+/rok) — tvrdší a dražší gate než Shopify Plus, blíž BigCommerce Enterprise gate co do principu "žádný levnější tier", ale s Open Source fallbackem, který BigCommerce vůbec nenabízí (BigCommerce nemá žádnou free cestu k byť nedokonalému price-listu; Magento ano přes Tier Price).

**Price Truth jistota**: nejslabší ze všech čtyř platforem. Shopify má live-ověřený Spike 2, Medusa má code-level auditovatelnost (self-hosted), BigCommerce má aspoň částečně otevřenou, ale zkoumanou otázku. Magento/Adobe Commerce zůstává **čistě dokumentační** — dokumentace samotná dokonce přiznává stacking riziko (bod 7), což je horší startovní pozice než "neznámo", je to "známé riziko, neověřená míra".

### RECOMMENDATION — je architektura CORE + MAGENTO ADAPTER realistická, a jaký je nejčistší další krok?

**Ano, architektura je realistická, ale s nejvyšší mírou nejistoty ze všech čtyř dosavadních discovery dokumentů.** Na rozdíl od BigCommerce (jasný blokující obchodní gate) je tu obchodní rozhodnutí méně binární — Open Source dává částečnou funkčnost zdarma, takže "further engineering + spike" má smysl už bez nutnosti čekat na nákup Commerce licence, pokud je Tier Price qty=1 fallback (cesta B, bod 14) akceptovatelný jako dočasné řešení.

Doporučený další krok:
1. **Pokud existuje zájem o Magento vůbec**: nejdřív ověřit prakticky proti dev/sandbox instanci Open Source (zdarma), zda Tier Price qty=1 trik skutečně funguje jako spolehlivý "fixed price per customer group" zápis — analog k tomu, co u BigCommerce blokovala absence jakéhokoli free price-listu.
2. **Live ověřit stacking chování** (bod 7, 17.2) proti sandbox instanci — kupón nad Tier Price/Shared Catalog cenou — tohle je nejkritičtější neznámá, protože přímo ohrožuje architektonickou premisu "engine píše finální cenu, Shoptet/Magento ji nesmí dál měnit".
3. **Teprve pokud** je zájem o čistší Shared Catalog mechanismus, řešit obchodní otázku Commerce+B2B licence — analogicky k BigCommerce Enterprise rozhodnutí, ale s vědomím, že cenový rozdíl (Commerce běžně $32k+/rok) je řádově vyšší než u ostatních platforem, takže business case musí být silnější.

Vzhledem k nejvyšší nejistotě (Price Truth neověřeno, žádný live přístup) je tato discovery **slabší evidenční základ** než Shopify/Medusa a měla by být brána jako výchozí bod pro spike, ne jako uzavřený závěr.
