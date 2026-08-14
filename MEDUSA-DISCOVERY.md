# Medusa Discovery

Rozsah: pochopit datový model a architekturu Medusa.js natolik hluboko, aby šlo posoudit, jestli hypotéza "stejné core + tenký platformní adapter = stejná deterministická cena" (potvrzená pro Shopify, s tvrdým Enterprise-gate blokerem pro BigCommerce) drží i pro **self-hosted, open-source** platformu bez SaaS plánového gatingu. Čistě rešeršní dokument — žádný kód, žádný store, žádný adapter, žádné zápisy, žádná implementace. Zdroje: `docs.medusajs.com` (oficiální dokumentace a API reference), `medusajs.com/pricing`, GitHub `medusajs/medusa`. Mirroruje strukturu `SHOPIFY-DISCOVERY.md` a `BIGCOMMERCE-DISCOVERY.md`.

Referenční soubory z repa: `src/core/interfaces.ts` (`PricingInput`, `PricingResult`, `CustomerTier`, `EngineConfig`), `src/core/customer-tier.ts` (`determineTier()`), `src/core/PricingEngine.ts` (policy pipeline — `PricingEngine.calculatePrice()` prohání `PricingContext` sekvencí `PricingPolicy` seřazených podle `priority`), `src/policies/*` (`BasePricePolicy`, `DiscountLimitPolicy`, `HighestDiscountPolicy`, `RoundingPolicy`). Tenhle core je beze změny stejný jako u předchozích dvou rešerší.

**Zásadní rámcová poznámka hned na začátek**: Medusa je jiná kategorie platformy než Shopify/BigCommerce. Není to SaaS s plánovými tiery, které něco gatují — je to self-hosted open-core framework, který Jan sám nasazuje a provozuje. "Plan gate" otázka z bodů 6 u předchozích dvou rešerší se tu z velké části **nepoužije** — místo ní nastupuje jiná osa rizika: Medusa má **vlastní zabudovaný Pricing Module**, který je architektonicky centrální součástí platformy (ne doplněk), a otázka zní "dá se ho obejít/nahradit", ne "je zamčený za paywallem".

---

## 1. Data model relevantní pro pricing

- **Modulární architektura**: Medusa v2 je složená z nezávislých modulů (Product, Pricing, Customer, Promotion, Order, ...), každý vlastní svá data a service. Moduly spolu nekomunikují přímo přes cizí klíče/joiny na úrovni DB — propojují se přes tzv. **module links** (Medusa "Module Links" mechanismus), řízené v aplikační vrstvě, ne skrze sdílenou relační DB napříč moduly. To je zásadně jiný vzor než Shopify/BigCommerce, kde je vše jeden vendor-spravovaný monolitní datový model za jedním API.
- **`Product`/`ProductVariant`** (Product Module) — nesou identitu produktu/varianty, ale **žádnou cenu přímo**. Ověřeno z `docs.medusajs.com/resources/references/product/models/ProductVariant`: `ProductVariant` má `id`, `title`, `sku` (nullable), `barcode`, `ean`, `upc`, `allow_backorder`, `manage_inventory`, `hs_code`, `origin_country`, `mid_code`, `material`, rozměry (`weight/length/height/width`), `metadata`, `variant_rank`, `thumbnail`, relace na `product` a `options`. **Žádné pole `price` na variantě neexistuje** — cena žije výhradně v Pricing Modulu a je s variantou propojená přes module link (`ProductVariant` ↔ `PriceSet`).
- **`PriceSet`** (Pricing Module) — kontejner cen pro jeden "cenovatelný" zdroj (typicky produktová varianta nebo shipping option). Nese kolekci `prices` (`HasMany` na `Price`). Přesná struktura relace `PriceSet` → `Product`/`ProductVariant` nebyla v referenční dokumentaci nalezena explicitně vypsaná (relace jde přes module link, ne přes pole na `PriceSet` samotném) — konzistentní s tím, že Pricing Module je navržený jako **doménově nezávislý na Product Modulu**, cenovatelný zdroj může být cokoliv, ne jen produkt.
- **`Price`** — jednotlivý cenový záznam uvnitř `PriceSet`: `id`, `title` (volitelné), `currency_code`, `amount`, `min_quantity`/`max_quantity` (volitelné, pro množstevní pásma), `rules_count`, reference zpět na `PriceSet`, a asociované `PriceRule`/`PriceList` záznamy.
- **`Customer`/`CustomerGroup`** (Customer Module) — `Customer` obsahuje `id`, `company_name`, `first_name`, `last_name`, `email`, `phone`, `has_account`, `metadata`, `created_by`, relace `groups` (M:N na `CustomerGroup`) a `addresses`. **Žádné agregované finanční pole** (spend, lifetime value, order count) na `Customer` samotném — potvrzeno.
- **`Order`** (Order Module) — samostatný modul, nutný pro jakoukoliv agregaci obratu (viz bod 4).
- **`Promotion`** (Promotion Module) — samostatný modul pro slevy/kupóny, viz bod 7.

## 2. Product mapping

| Náš `PricingInput` field | Medusa entita.pole | Typ | Vždy dostupné? | Omezení / poznámka |
|---|---|---|---|---|
| `sku` | `ProductVariant.sku` | `string`, nullable | Ne — volitelné pole, obchodník ho nemusí vyplnit | Stejný pattern jako Shopify — nutný fallback na `ProductVariant.id` jako klíč pokud SKU chybí |
| — (variant identita) | `ProductVariant.id` | `string` (prefix `variant_...`) | Ano | Stabilní primární klíč; `PriceSet` je s variantou propojen přes module link, ne přes `sku` |
| `basePrice` | Neexistuje na `ProductVariant` — žije v Pricing Modulu jako `Price.amount` uvnitř `PriceSet` propojeného s variantou, pro daný `currency_code` a bez matchujících `PriceRule` (tj. "default" cena) | `number` (integer, v nejmenší měnové jednotce — Medusa ceny obvykle ukládá jako celá čísla, ne desetinná místa, podobně jako Stripe) | Ano jako koncept, ale vyžaduje dotaz přes Pricing Module (`calculatePrices`/`pricing.list`), ne přímé pole na produktu | **Zásadní strukturální rozdíl proti Shopify/BigCommerce**: "base cena" není pole na produktu/variantě, je to výsledek dotazu do samostatného modulu s kontextem (měna, případně rules) — normalizer musí volat Pricing Module API, ne jen číst produkt |
| `salePrice` | `PriceList` typu `sale` propojený s `PriceSet` varianty, vs. `PriceList` typu `override`/žádný list (default) | — | Ne vždy | Medusa má nativní rozlišení `sale`/`override` price list typů (viz bod 5) — sémanticky nejblíž ze všech tří platforem k tomu, co core očekává, ale je to pořád jiný koncept než jedno pole |
| `manufacturer` | Žádné nativní pole na `Product`/`ProductVariant` v jádru Product Modulu — nejblíž je vlastní `metadata` nebo custom product type/attribute rozšíření | — | Ne | Medusa core produktový model nemá vestavěné "brand"/"vendor" pole (na rozdíl od BigCommerce `brand_id` nebo Shopify `vendor`) — muselo by se řešit `metadata` polem nebo vlastním rozšířením datového modelu (Medusa umí modely rozšiřovat) |
| `category` | `ProductCategory` (Product Module) — M:N na produkt | `Connection` | Ano jako mechanismus | Stejný multi-membership nesoulad proti singulárnímu `category: string` jako u Shopify Collections/BigCommerce `categories` — potřeba explicitní rozhodnutí |
| `productMaxDiscount` | Žádné nativní pole — jedině `metadata` | — | Ne, muselo by se vytvořit | Stejný závěr jako u obou předchozích platforem — policy data zůstávají v core |
| `purchasePrice` | Žádné nativní pole na `Product`/`ProductVariant` v základním modelu — Inventory Module řeší sklad/dostupnost, ne nákupní cenu | — | Ne | Nenalezeno s vysokou jistotou v této rešerši; pravděpodobně mimo core Product/Inventory Module, řešeno by muselo být `metadata` nebo vlastním modulem |
| `currency` | `Price.currency_code` (v kontextu Pricing Module) nebo `Region.currency_code` (obchodní region) | `string` (ISO) | Ano | Medusa je nativně multi-currency přes `Region` a `currency_code` na `Price` — konzistentní s multi-currency dotazovacím kontextem `calculatePrices` |
| `vatRate` | Žádné přímé pole — Tax Module (samostatný modul, `TaxRegion`/`TaxRate`) | — | Ne přímo | Stejný vzor jako obě předchozí platformy — DPH je odvozená z tax konfigurace (tady vlastního Tax Modulu), ne uložená jako sazba per produkt |

## 3. Customer mapping

| Náš potřebný vstup | Medusa entita.pole | Typ | Vždy dostupné? | Omezení / poznámka |
|---|---|---|---|---|
| identita zákazníka | `Customer.id` | `string` (`cus_...`) | Ano | Primární klíč |
| e-mail | `Customer.email` | `string`, nullable | Ne vždy (guest zákazníci) | — |
| skupina | `Customer.groups` (M:N na `CustomerGroup`) | `Connection` | Ano jako mechanismus | Přímý strukturovaný analog BigCommerce `customer_group_id` — silnější než Shopify volný `tags` string, protože je to skutečný referenční FK vztah a navíc M:N (zákazník může být ve víc skupinách současně, což Shopify/BigCommerce single-group model neumožňuje) |
| objednávky | Order Module — žádná přímá relace `Customer.orders` v Customer Modulu samotném (moduly jsou izolované, propojení přes module link) | — | Ano jako mechanismus, dotaz přes Order Module | Nutná agregace přes Order Module query, ne přes pole na `Customer` |
| celkový obrat | **Žádné nativní pole na `Customer`** — ověřeno z reference `docs.medusajs.com/resources/references/customer/models/Customer` — model obsahuje jen identitu/kontakt/`has_account`/`metadata`/`groups`/`addresses`, žádné finanční agregační pole | — | **Ne** | **Stejný gap jako BigCommerce, horší než Shopify**: žádný `amountSpent`-like field. Musí se stavět vlastní agregace z Order Modulu od dne 1 — viz bod 4 |
| tier (ZR4…ZR25) | Žádné nativní pole — musí se odvodit nebo uložit | — | Ne | Dvě cesty stejné jako u předchozích platforem: (a) odvodit za běhu, nikam neukládat, (b) promítnout tier jako členství v odpovídající `CustomerGroup` (`ZR4`...`ZR25` skupiny) — a tady je to navíc **přímo nutná podmínka** pro fungování `PriceRule` na `customer.groups.id` (bod 5), stejně jako u BigCommerce `customer_group_id`, ne jen volitelný cache signál jako Shopify tag |
| B2B kontext | Medusa nemá vestavěný "Company"/"CompanyLocation" objekt v jádru (na rozdíl od Shopify B2B nebo BigCommerce B2B Edition) — B2B scénáře se v Medusa ekosystému typicky řeší přes `CustomerGroup` + vlastní rozšíření, nebo komunitní/partnerské B2B moduly | — | Ne nativně | Medusa core je spíš obecný headless commerce framework než B2B-first platforma — pokud by byl potřeba plnohodnotný company/multi-buyer model, je to buď custom modul, nebo (dle veřejných zdrojů) samostatná komerční nabídka B2B v ekosystému, ne ověřeno s vysokou jistotou v této rešerši |

## 4. Customer tier mapping — datová cesta do existujícího `determineTier()`

`determineTier()` (`src/core/customer-tier.ts`) zůstává čistá funkce `(totalOrderValue: number) => CustomerTier | undefined`. Tahle rešerše nenavrhuje měnit tuto logiku.

Navrhovaná datová cesta (bez implementace):

1. **Žádná Medusa-nativní "levná cesta"** — stejně jako u BigCommerce, jinak než u Shopify (`Customer.amountSpent`). Adapter by musel dotazovat Order Module (`orderModuleService.listOrders({ customer_id })` nebo Admin API `/admin/orders?customer_id=`) a sečíst relevantní částky.
2. Nutné explicitní rozhodnutí, které pole a jaký filtr odpovídá historické Shoptet definici obratu — Medusa `Order` nese `total`, `subtotal`, atd. a stavový model objednávky (draft, pending, completed, canceled...), ale přesná sada polí a stavů nebyla v této rešerši ověřena do úrovně jednotlivých názvů s vysokou jistotou (mimo hlavní scope — Pricing Module byl prioritou). **Otevřená otázka pro budoucí spike**, stejná třída rizika jako u obou předchozích platforem.
3. Výsledné číslo se předá do `determineTier(totalOrderValue)` beze změny.
4. Výstup `CustomerTier | undefined` se musí zapsat zpět jako členství v `CustomerGroup` (analog BigCommerce `customer_group_id` přiřazení) — nutný extra krok, protože `PriceRule` na `customer.groups.id` (bod 5) potřebuje, aby zákazník byl fakticky ve skupině, ne jen že to core "ví".
5. **Výhoda oproti oběma SaaS platformám**: protože je Medusa self-hosted, Jan má **přímý přístup k databázi a service layer** Order Modulu — agregace obratu nemusí jít nutně přes REST/Admin API s paginací a rate limity, může jít přímo přes Medusa service volání uvnitř vlastního custom modulu/subscriberu běžícího ve stejném backendu. To je kvalitativně jiná pozice než u Shopify/BigCommerce, kde je adapter vždy externí klient volající cizí API přes síť.

## 5. Customer-specific pricing možnosti — Pricing Module deep dive

Toto je architektonicky nejdůležitější a nejsilnější mechanismus ze všech tří platforem prozkoumaných dosud — Medusa staví pricing jako **first-class doménu**, ne jako doplněk k produktovému katalogu.

**Core entity (ověřeno z `docs.medusajs.com/resources/references/pricing/models/*`):**

- **`PriceSet`** — kontejner `prices` pro jeden cenovatelný zdroj (variantu).
- **`Price`** — `id`, `title` (volitelné), `currency_code`, `amount`, `min_quantity`/`max_quantity` (množstevní pásma), `rules_count`, vazba zpět na `PriceSet`, a asociace na `PriceRule`/`PriceList`.
- **`PriceRule`** — `id`, `attribute` (text, např. `customer.groups.id`, `region_id`), `value` (text, hodnota k porovnání), `operator` (enum `PricingRuleOperator`, např. `eq`, `gte`, `in`), `priority` (číslo pro pořadí vyhodnocení), vazba `belongs to` na `Price`. **Tohle je klíčový mechanismus pro customer-group-specific pricing** — pravidlo typu `attribute: "customer.groups.id", operator: "eq", value: "<group_id>"` na konkrétní `Price` znamená "tahle cena platí jen pro zákazníky v této skupině".
- **`PriceList`** — `id`, `title`, `description`, `status` (enum `PriceListStatus`), **`type`** (enum `PriceListType` s hodnotami **`sale`** a **`override`**), `starts_at`/`ends_at` (volitelné časové okno), `rules_count`, `metadata`, relace `prices` (HasMany `Price`) a `price_list_rules` (HasMany `PriceListRule`, atribut-hodnota matching stejného tvaru jako `PriceRule`, ale na úrovni celého listu).
  - **`sale`** typ — cena je nabízena jako "akční" vedle původní ceny (analog Shopify `compareAtPrice`/BigCommerce `sale_price` konceptu, ale nativně strukturovaný jako typ price listu, ne separátní pole).
  - **`override`** typ — cena kompletně nahrazuje/přepisuje default cenu pro daný kontext, bez vztahu k "původní" ceně jako referenci.
  - Toto přesné rozlišení (`sale` vs `override`) je **nativně silnější a explicitnější** než cokoliv nalezené u Shopify (`compareAtPrice`, sémanticky nejednoznačné) nebo BigCommerce (`sale_price`/`retail_price`, dvě oddělená pole bez formálního "typu").

**Jak se počítá finální cena — `calculatePrices` (ověřeno z `docs.medusajs.com/resources/commerce-modules/pricing/price-calculation`):**

- Metoda `calculatePrices` na Pricing Module service přijímá ID jednoho nebo více `PriceSet` a **kontext** (key-value páry, např. `{ currency_code: "eur", region_id: "reg_123" }`, do kontextu patří i `customer.groups.id` pro group-scoped ceny).
- Vrací pro každý `PriceSet` **dvě ceny**: `calculated_price` (cena k zobrazení zákazníkovi — buď z matchujícího price listu, nebo default) a `original_price` (referenční cena pro srovnání — nikdy z `sale`-typu listu, pokud existuje default).
- **Ranking algoritmus** (přesně, ověřeno): (1) pokud nejsou v kontextu žádná pravidla, vybere se default cena; (2) pokud pravidla existují a nějaká cena matchuje všechna pravidla, vybere se ta; (3) při částečné shodě se ceny seřadí podle počtu matchnutých pravidel sestupně a vybere se nejvyšší shoda. Tohle je **deterministický, dokumentovaný algoritmus** — silnější garance než cokoliv nalezené u Shopify/BigCommerce, kde přesný interní resolution order nebyl nikde takhle explicitně popsaný.
- **Customer-group-specific pricing prakticky**: vytvoří se `Price` (v rámci `PriceList` typu `override`, přiřazeného variantě) s `PriceRule`/`PriceListRule` `attribute: "customer.groups.id"`, `value: "<ZR20 group id>"`. Když se `calculatePrices` zavolá s kontextem obsahujícím `customer.groups.id` daného zákazníka, tahle cena vyhraje nad default cenou.
- **Přímý analog `TIER_PRICELIST_MAP`**: jeden `PriceList` (typ `override`) na tier (ZR4…ZR25), s `PriceListRule` navázaným na odpovídající `CustomerGroup`, obsahující `Price` záznamy pro každou variantu. Strukturálně stejný vzor jako Shopify `PriceList`/`Catalog`-per-tier a BigCommerce `Customer Group` + `Price List`-per-tier — potřetí nezávisle potvrzený vzor napříč platformami.
- **Neověřeno v této rešerši s vysokou jistotou**: přesný horní limit počtu `PriceList`/`PriceRule` záznamů na store (self-hosted DB nemá vendor-vynucený "3 katalogy" nebo podobný strop jako BigCommerce Standard — limit by byl čistě výkonnostní/databázový, ne produktový/plánový, ale přesné praktické škálovací chování při 8-10 tierech × celý katalog nebylo v dokumentaci kvantifikováno).

## 6. Plan/tier gating — platí tenhle koncept vůbec na self-hosted OSS platformě?

**Krátká odpověď: ne stejným způsobem jako u Shopify/BigCommerce, ale ne úplně "žádný gate" buď.**

- **Licenční model (ověřeno z GitHub `medusajs/medusa`)**: Medusa core je **MIT licencovaný** a plně open source. Repo explicitně uvádí: *"The core is licensed under the MIT License."* Vedle toho existuje **Enterprise Edition** s RBAC (role-based access control) funkcemi, která vyžaduje komerční smlouvu s Medusa, Inc. — ale tohle je **admin-panel access control feature, ne pricing/commerce funkce**. Pricing Module, Promotion Module, Customer Module, Order Module — celá komerční logika relevantní pro naši integraci — je **MIT, plně open source, žádný paywall**.
- **Medusa Cloud** (`medusajs.com/pricing`) — samostatná, volitelná **hostingová** nabídka (Develop od ~$29/měs, Launch od ~$99/měs, Scale od ~$299/měs, Enterprise custom). Podle marketingové stránky "No GMV-tax or special licenses" na commerce funkcích a "Unlimited" objednávky/produkty/prodejní kanály napříč tiery — rozdíly mezi Cloud tiery se týkají **infrastruktury** (autoscaling, zálohy, background workers, SLA), ne odemykání commerce funkcí jako Pricing Module nebo Price List typy. Toto **nebylo ověřeno se stejnou jistotou jako licenční fakt výše** — stránka explicitně nerozepisuje feature-matici commerce modulů per Cloud tier tak jako to udělal BigCommerce (`bigcommerce.com/essentials/pricing`), je to nepřímý závěr z formulace "Unlimited" a "no special licenses", ne přímá citace.
- **Důsledek pro Jana**: pokud si Medusa nasadí sám (vlastní server/VPS/Docker, mimo Medusa Cloud úplně), **žádný z mechanismů popsaných v bodě 5 (PriceSet/PriceList/PriceRule/CustomerGroup) není gatovaný vůbec** — je to MIT kód, který běží na jeho vlastní infrastruktuře. Medusa Cloud by byl jen volitelná hostingová vrstva navrch, ne požadavek pro použití Pricing Modulu.
- **Srovnání jednou větou se Shopify/BigCommerce**: u Shopify byl gate z velké části odstraněný (B2B for all), u BigCommerce zůstal tvrdý a jednoznačný (Price Lists = Enterprise-only), u Medusy **otázka v tomhle tvaru vůbec nedává smysl** — není tu vendor, který by mohl gate nastavit na commerce logiku, protože Jan by byl sám provozovatelem. Riziko se přesouvá jinam: ne "zaplatit za feature", ale "postavit a provozovat feature sám" (bod 9, bod 19).

## 7. Discounts / Promotions — interakce s Price List cenami

- **Promotion Module** (ověřeno z `docs.medusajs.com/resources/commerce-modules/promotion`) — samostatný modul, "a promotion discounts an amount or percentage of a cart's items, shipping methods, or the entire order". Podporuje pravidla omezující, kdy promoce platí, a **campaign** koncept (sdílené podmínky start/end dat a rozpočtu napříč víc promocemi).
- **Neověřeno s vysokou jistotou v této rešerši**: přesné chování stackování (kombinovatelnost víc promocí najednou), a **explicitní interakce mezi aktivní Promotion a cenou vyplývající z Price Listu** (typ `override` nebo `sale`). Dokumentace k tomuhle konkrétnímu průsečíku nebyla v rámci téhle rešerše nalezena s dostatečnou jistotou — stejná třída mezery jako u obou předchozích platforem (Shopify `combinesWith`, BigCommerce coupon/Price-List vztah).
- **Odvoditelný, ne přímo potvrzený závěr** (na základě modulární architektury): Promotion Module je **oddělený modul od Pricing Modulu** — Promotion se aplikuje na úrovni cart/checkout výpočtu (line item, shipping, order total), zatímco Price List/Price Rule mění to, jaká je "vstupní" cena položky předtím, než se promoce spočítá. To znamená stejné strukturální riziko jako u obou předchozích platforem: pokud je Price List cena už finální vypočtená core hodnota (tier + capy), promoce na ni **pravděpodobně** může sáhnout navíc, pokud administrátor/kód promoci explicitně neomezí (Promotion Rules umí cílit na `customer.groups.id` stejně jako Price Rules, takže by šlo teoreticky zamezit tier-locked zákazníkům dostat kupón vůbec — architektonické obejití, stejné jako u Shopify/BigCommerce).
- **Výhoda self-hosted pozice**: protože Promotion Module je taky jen MIT modul běžící v Janově vlastní instanci, dá se jeho zdrojový kód **přímo přečíst** (ne jen odhadovat z dokumentace), aby se ověřilo přesné pořadí aplikace Promotion vs. Pricing Module ve výpočtu cart totalu — to je zásadní rozdíl proti Shopify/BigCommerce, kde je tahle logika uzavřená v proprietárním backendu (bod 10).

## 8. Metadata (Medusa's metadata fields) pro tier/audit info

- `metadata` je univerzální JSON key-value pole dostupné na většině Medusa entit (`Customer`, `ProductVariant`, `PriceList`, `Order`, ...) — koncepčně blízké Shopify metafieldům, ale bez formálního "definice"/typového systému jako Shopify `MetafieldDefinition` nebo BigCommerce `namespace`/`permission_set` — je to prostý JSON blob bez vestavěné validace na úrovni schématu.
- **Stejné posouzení jako u obou předchozích platforem**: vhodné pro operational/audit metadata (verze/hash posledního zápisu `PricingResult`, sync timestamp, ID poslední synchronizace) na `ProductVariant` nebo `PriceList`; nevhodné pro duplikaci policy dat (limity, prahy core konfigurace) — ty musí zůstat v core, jinak druhý zdroj pravdy.
- **Výhoda self-hosted pozice**: protože Jan má přímý DB přístup, mohl by pro audit/verzování místo (nebo vedle) `metadata` pole použít i vlastní tabulku/vlastní Medusa modul propojený přes module link — čistší řešení než přetěžovat JSON blob, dostupné jen proto, že vlastní celý backend.

## 9. `PricingResult` → Medusa write možnosti — VČETNĚ bypass/override otázky

Tohle je nejdůležitější sekce celé rešerše, protože Medusa jako jediná ze tří platforem má **vlastní first-class pricing engine** integrovaný do jádra — otázka není "kam zapsat číslo", ale "jak se vztahovat k tomu, že platforma už umí počítat ceny sama".

**Tři možné architektonické cesty, seřazené od nejjednodušší po nejsilnější/nejinvazivnější:**

**A. "Psát do Pricing Modulu jako do Price Listu" (stejný vzor jako Shopify/BigCommerce)**
- Core spočítá `PricingResult.finalPrice` beze změny.
- Adapter zapíše `finalPrice` jako `Price.amount` v `PriceList` (typ `override`) přiřazeném danému tieru/`CustomerGroup`, přes Pricing Module Admin API (`POST /admin/price-lists`, `POST /admin/price-lists/:id/prices/batch` nebo ekvivalentní service volání `pricingModuleService.createPriceLists`/`addPriceListPrices`).
- **Tohle je 1:1 stejný vzor jako u Shopify `PriceList` fixed-price entries a BigCommerce `Price Record`** — core zůstává "zdroj pravdy pro číslo", Medusa Pricing Module jen *ukládá* výsledek, ne že by ho počítal nezávisle.
- **Klíčová podmínka, aby tohle fungovalo čistě**: `calculatePrices` ranking algoritmus (bod 5) musí vybrat právě tenhle `override` list a žádnou jinou konkurenční cenu (jiný price list, jiné pravidlo) — to je návrhová disciplína (jeden `override` list per tier, žádné překrývající se price listy), ne technická nemožnost. Pokud se to udrží čistě, Medusa **nerecomputuje** nic navíc, jen vrací uloženou hodnotu podle kontextu — sémanticky ekvivalentní Shopify/BigCommerce fixed-price přístupu.

**B. Bypass — číst finální cenu přímo z core, obejít Pricing Module úplně v hot-path**
- Protože je Medusa self-hosted a modulární, je teoreticky možné **napsat vlastní resolver/middleware/subscriber**, který by v cart/checkout flow volal externí `PricingResult` (core enginu) přímo místo/vedle `calculatePrices`, a vnutil výslednou cenu do cart line itemu jinak než přes standardní Pricing Module dotaz.
- **Medusa to architektonicky umožňuje** — Medusa dokumentuje **Module Isolation** (`docs.medusajs.com/learn/fundamentals/modules/isolation`) jako explicitní design princip: *"You can replace existing modules with your custom implementation if your use case is drastically different. Medusa defines interfaces for all modules to make deep integrations easy to set up."* Tzn. Pricing Module je **v principu nahraditelný vlastní implementací modulu se stejným rozhraním** — Medusa container by pak injectoval Janův custom modul místo vestavěného.
- **Cena za tuhle cestu**: je to podstatně invazivnější zásah než u Shopify/BigCommerce, kde adapter nikdy nenahrazoval platformní pricing engine, jen do něj zapisoval čísla. Tady by šlo o **nahrazení celé domény** (implementovat `IPricingModuleService`-kompatibilní rozhraní, zajistit, že všechny interní Medusa subsystémy — cart, checkout, order — které volají Pricing Module, dostanou konzistentní chování z náhradní implementace). Riziko regresí a nutnost sledovat Medusa upstream API kontrakt modulu při každém upgradu.
- **Doporučení této rešerše**: cesta A (psát do Pricing Modulu jako do Price Listu) je **jasně preferovaná** — dává stejnou garanci (core zůstává zdroj pravdy pro číslo, Medusa jen persistuje a vydává) za zlomek inženýrské ceny cesty B. Cesta B (nahrazení celého modulu) by dávala smysl jen pokud by ranking algoritmus `calculatePrices` (bod 5) systematicky selhával v pokrytí core logiky (např. potřeba dynamicky přepočítávat cenu podle kontextu, který `PriceRule` atributy nepokrývají) — což v této rešerši nebylo identifikováno jako nutnost.

**C. Replikace policy logiky jako nativní `PriceRule`/`PriceListRule` sadu (bez zápisu předpočítaného čísla)**
- Alternativa k A/B: místo aby core počítal `finalPrice` a zapisoval ho, mohla by se logika (tier sleva, brand/category cap, rounding) přepsat jako sada `PriceRule` s prioritami přímo v Pricing Modulu.
- **Nedoporučeno** — porušuje architektonický princip celého projektu ("core zůstává jediný zdroj pravdy pro pricing logiku", `PricingPolicy` pipeline v `src/policies/*`) a vytváří přesně to riziko duplicity/driftu, které bod 14 (a ekvivalentní body u obou předchozích rešerší) explicitně varuje. Zmíněno jen pro úplnost coby možnost, kterou Medusa technicky umožňuje díky bohatosti `PriceRule` mechanismu — ne jako doporučená cesta.

**Závěr bodu 9**: Medusa má vlastní pricing engine, ale to **neznamená**, že "thin adapter + external core" vzor nefunguje — cesta A ukazuje, že se dá zachovat stejně čistě jako u Shopify/BigCommerce, pokud se `override` typ Price Listu použije disciplinovaně jako jediná aktivní cenová vrstva pro daný kontext. Friction, kterou Medusa přidává navíc oproti Shopify/BigCommerce, není v tom, že by bypass nebyl možný — je v tom, že Medusa **nabízí** i mnohem invazivnější cestu (B, nahrazení modulu) a je architektonicky lákavé po ní sáhnout, i když to pro tenhle use-case není nutné.

## 10. Price Truth — mění self-hosting tenhle problém zásadně?

**Ano, zásadně — ale ne tak, že by problém zmizel, spíš že mění svoji podstatu.**

- **Shopify/BigCommerce pozice**: Jan má jen API přístup k černé skříňce. Otázka "shoduje se to, co API říká, s tím, co zákazník skutečně zaplatí" musí být řešena **posteriori verifikací** (Storefront `@inContext`, GraphQL Storefront `prices`, `draftOrderCalculate`) — a v obou rešerších to zůstalo částečně otevřenou otázkou s citelnou nejistotou (Shopify: `@inContext` je B2B-dokumentovaný, nejisté chování pro B2C; BigCommerce: `prices` pole nejisté ohledně promotion zahrnutí).
- **Medusa pozice**: Jan by **vlastnil a nasazoval celý backend**, včetně přesného zdrojového kódu, který cart/checkout flow používá k výpočtu ceny. To znamená:
  - **Price Truth se dá ověřit čtením kódu, ne černou skříňkou** — místo hádání "co `@inContext` zahrnuje" lze přímo přečíst, jak Medusa cart-line-item pipeline volá `calculatePrices` a jestli/jak se do toho promítá Promotion Module (bod 7). To je kvalitativně silnější pozice — z "nejistota vyžadující empirický test proti API černé skříňce" na "ověřitelný fakt čtením zdrojového kódu".
  - Pokud se použije cesta A z bodu 9 disciplinovaně (jeden `override` price list = jediná aktivní cenová vrstva, žádné konkurenční price listy/pravidla, promoce buď vypnuté pro tier-locked zákazníky nebo explicitně prověřené), pak "co je zapsáno" a "co zákazník zaplatí" **spadají do sebe z konstrukce** — stejný závěr jako doporučení (b) ze Shopify Spike 2 verdiktu, ale tady je to snáz *ověřitelné* (kód po ruce), ne jen *navržitelné*.
- **Nová vrstva rizika, kterou self-hosting přináší a kterou SaaS platformy nemají**: **Jan teď vlastní uptime, konzistenci a korektnost celého pricing subsystému sám.** U Shopify/BigCommerce je zaručeno (SLA vendora), že `ProductVariant.price`/`Price Record` výpočet běží korektně a je dostupný — Jan jen řeší, jestli tam zapsal správné číslo. U Medusa self-hosted by DB výpadek, migrace, race condition v Pricing Modulu, nebo bug v Janově vlastním subscriberu/module-linku mohl **rozbít samotný mechanismus výpočtu ceny**, ne jen synchronizaci k němu. Tohle je operational riziko navíc, ne řešené touto rešerší (mimo scope — dotýká se bodu 19 self-host operations).
- **Shrnutí**: self-hosting **neodstraňuje** Price Truth problém jako koncept (pořád je potřeba disciplína "jedna aktivní cenová vrstva"), ale **mění nástroj řešení** z empirické API-verifikace na code-level auditovatelnost — a **přidává** nové riziko (vlastní odpovědnost za korektnost/dostupnost pricing enginu), které Shopify/BigCommerce jako spravovaný SaaS Janovi automaticky odebíraly.

## 11. Verification/reconciliation možnosti

- Stejný obecný vzor jako u obou předchozích platforem: reconciliation job porovnávající `core PricingResult.finalPrice` vs. hodnota vrácená `calculatePrices` pro daný kontext (customer group, měna) — s explicitním seznamem povolených transformací (zaokrouhlení, měna) odečtených před vyhodnocením shody.
- **Silnější nástroj dostupný jen díky self-hostingu**: protože `calculatePrices` je service metoda dostupná přímo v Medusa backendu (ne jen přes REST), reconciliation kód by mohl běžet **ve stejném procesu/monorepu** jako Medusa samotná (vlastní subscriber/scheduled job v Medusa instanci), volat `calculatePrices` přímo přes service layer bez síťového API volání a rate limitů — rychlejší a spolehlivější než ekvivalentní Shopify/BigCommerce reconciliation přes veřejné API.
- Operational metadata (bod 8) na `PriceList`/`ProductVariant.metadata` — stejná role jako u předchozích platforem, odlišuje "nesynchronizováno" od "neshoduje se".
- **Neověřeno v této rešerši**: existence Medusa ekvivalentu Shopify `draftOrderCalculate` (simulace objednávky/cart bez vytvoření) — nebylo cíleně hledáno v rámci scope této rešerše (prioritou byl Pricing Module deep-dive); pravděpodobně existuje nějaká `cart` simulace (Medusa má plnohodnotný Cart Module), ale přesný název a chování nebyly ověřeny.

## 12. API surface & limitations

- **Admin API** (`/admin/*`, REST, plus `@medusajs/js-sdk` JS/TS klient) — pro správu produktů, cen, price listů, zákazníků, objednávek. Tohle by byl primární povrch pro zápis `PricingResult` (cesta A z bodu 9).
- **Store API** (`/store/*`) — pro storefront/zákaznický kontext, čtení kontextualizovaných cen pro přihlášeného zákazníka.
- **Service layer (jen self-hosted)** — protože Medusa běží jako Janův vlastní Node.js backend, je možné psát **vlastní custom moduly/subscribery/API routes přímo uvnitř Medusa instance**, volající `pricingModuleService`, `customerModuleService`, `orderModuleService` atd. přímo jako TypeScript volání, bez HTTP vrstvy vůbec. Tohle je zásadně jiná a silnější pozice než u Shopify/BigCommerce, kde adapter je **vždy** externí HTTP klient podléhající rate limitům, API verzování a síťové latenci. Pro Medusa by "adapter" mohl být z podstatné části **vlastní Medusa modul**, ne externí service.
- **Rate limity / verzování** — self-hosted Medusa nemá vendor-vynucené API rate limity (na rozdíl od Shopify GraphQL cost-based throttlingu nebo BigCommerce `PriceRecordBatch` 429 limitů) — jediný limit je hardware/DB kapacita, kterou Jan sám dimenzuje a kontroluje.

## 13. Doporučený adapter design (návrhový nákres, neimplementováno)

```typescript
// Návrh, ne implementace. Stejná hranice jako u Shopify/BigCommerce adapter návrhů —
// core (PricingInput/PricingResult/determineTier) se nemění, platformní specifika
// žijí za tímto rozhraním. Rozhraní EcommercePlatformAdapter zůstává sdílené napříč
// platformami; Medusa implementace se ale liší v jedné podstatné věci (viz poznámky níže).

interface EcommercePlatformAdapter {
  fetchProductsForPricing(params: { cursor?: string; limit?: number }): Promise<{
    items: RawPlatformProduct[];
    nextCursor?: string;
  }>;

  normalizeToInput(raw: RawPlatformProduct, tier: CustomerTier | undefined): PricingInput;

  /** Na Medusa: vlastní agregace přes Order Module (bod 4) — žádné hotové "amountSpent"
   *  pole, stejná zátěž jako BigCommerce. Ale pokud adapter běží uvnitř Medusa instance
   *  (viz poznámky níže), může volat orderModuleService přímo, ne přes HTTP. */
  fetchCustomerTotalSpend(customerId: string): Promise<number>;

  /** Zápis PricingResult zpět. Na Medusa: Price v PriceList (typ "override") přiřazeném
   *  odpovídající CustomerGroup (bod 5, 9, cesta A) — MIT, žádný plan gate.
   *  Musí být idempotentní a dry-run-first, stejně jako u ostatních adapterů. */
  writePricingResult(result: PricingResult, tier: CustomerTier, opts: { dryRun: boolean }): Promise<WriteOutcome>;

  /** Verifikace přes calculatePrices s daným customer-group kontextem (bod 5, 11) —
   *  na Medusa dostupné i jako přímé service volání, ne jen HTTP round-trip. */
  verifyCustomerVisiblePrice(customerId: string, sku: string): Promise<{
    apiStoredPrice: Decimal;
    customerVisiblePrice: Decimal | null;
    matches: boolean | "unknown";
    explainedDiff?: string;
  }>;
}
```

**Klíčová architektonická otázka zodpovězena**: **"thin adapter + external core" vzor fitne na Medusa stejně čistě jako na Shopify/BigCommerce, pokud se drží cesta A z bodu 9** — psát do Pricing Modulu (`PriceList` typu `override`) stejně, jako se psalo do Shopify `PriceList` nebo BigCommerce `Price Record`. Friction, kterou Medusa přidává, není v tom, že by adapter musel core logiku replikovat (bod 9, cesta C, výslovně nedoporučeno) nebo že by musel Pricing Module nahrazovat (bod 9, cesta B, technicky možné přes Module Isolation, ale zbytečně invazivní pro tenhle use-case). Friction je jinde:

1. **Dvoufázový zápis místo jednofázového** — u Shopify/BigCommerce byl zápis "najdi variantu → zapiš cenu do existujícího PriceList mechanismu". Na Medusa je nejdřív nutné vytvořit/spravovat vlastní `PriceSet`↔`ProductVariant` module link (pokud ho Medusa nevytváří automaticky při vytvoření produktu — nebylo ověřeno s vysokou jistotou v této rešerši) a teprve pak psát `Price` záznamy.
2. **Adapter může (a možná by měl) žít uvnitř Medusa instance samotné**, ne jako čistě externí klient — to je jak výhoda (bod 12, silnější přístup), tak posun v tom, co "adapter" vůbec znamená oproti Shopify/BigCommerce vzoru, kde byl adapter vždy jasně oddělená externí vrstva (Cloudflare Worker apod., stejně jako existující Shoptet adapter v tomhle repu).
3. **Žádný hotový spend-agregační zdroj** (stejné jako BigCommerce) — vyšší implementační náklad na tier-mapping větev než u Shopify.

## 14. Co zůstává v core

Stejně jako u obou předchozích platforem — beze změny:
- `determineTier()` a všechny prahové hodnoty (`src/core/customer-tier.ts`).
- `PricingPolicy` pravidla, `RuleType`, `PricingCommand`, `EngineConfig`, `PricingEngine.calculatePrice()` (`src/core/interfaces.ts`, `src/core/PricingEngine.ts`, `src/policies/*`).
- Policy data (max slevy per brand/kategorie/produkt) — zůstávají v core konfiguraci, **nekopírovat do Medusa `PriceRule`/`metadata`** jako zdroj pravdy (bod 9, cesta C explicitně nedoporučena) — jinak vzniká druhý zdroj pravdy, stejné riziko jako u obou předchozích platforem.

Tahle rešerše potvrzuje **potřetí** nezávisle (po Shopify, po BigCommerce) tutéž hypotézu: core logika je platformně nezávislá i vůči architektonicky nejvyspělejší a nejinvazivnější ze tří zkoumaných platforem — žádný z bodů 1–13 výše nevyžaduje zásah do `src/core/`.

## 15. Co patří do Medusa adapteru

- Normalizace `ProductVariant`/`Product` → `PricingInput`, včetně dotazu do Pricing Modulu pro default/base cenu (bod 2) — na rozdíl od Shopify/BigCommerce tohle vyžaduje volání samostatného modulu, ne čtení pole na produktu.
- Vlastní agregace obratu z Order Modulu → vstup do `determineTier()` (bod 4) — stejná zátěž jako BigCommerce adapter.
- Tier → `CustomerGroup` přiřazení + `CustomerGroup` → `PriceList` (typ `override`) mapování a správa `PriceListRule` (analog `TIER_PRICELIST_MAP`, bod 5, 9).
- Zápis `PricingResult.finalPrice` do `Price` záznamů v odpovídajícím `PriceList` (bod 9, cesta A) — bez plánového gatingu, ale s nutností spravovat `PriceSet`↔`ProductVariant` module link.
- Verifikace přes `calculatePrices` s customer-group kontextem (bod 5, 11) — s možností volat přímo jako service, ne jen přes HTTP.
- Operational metadata v `metadata` poli (bod 8).
- Rozhodnutí a disciplína zajišťující, že `override` price list je **jediná aktivní cenová vrstva** pro daný tier (žádné konkurenční price listy/promoce bez explicitního review) — architektonická podmínka Price Truth (bod 10), tady je to na adapteru/návrhu, ne na platformě samotné to vynutit.

## 16. Otevřené otázky / rizika

1. Přesný vztah `PriceSet`↔`ProductVariant` module linku — vytváří ho Medusa automaticky při vytvoření produktu, nebo je nutná explicitní správa v adapteru? Neověřeno s vysokou jistotou v této rešerši.
2. Přesná interakce Promotion Module vs. Price List `override`/`sale` typ (bod 7) — analogická mezera jako Shopify `combinesWith`/BigCommerce coupon-vs-Price-List, tady navíc s výhodou, že je zdrojový kód čitelný (bod 10), ale samotná rešerše ho nepřečetla (mimo scope dokumentační rešerše).
3. Chybí `Customer`-úrovňové spend pole (bod 3, 4) — stejný gap jako BigCommerce, vyžaduje vlastní Order Module agregaci s otevřenou otázkou přesné definice statusů/polí.
4. Žádné nativní `manufacturer`/brand pole na produktu (bod 2) — na rozdíl od BigCommerce `brand_id` nebo Shopify `vendor`, Medusa core produktový model tohle nemá vůbec, řešeno by muselo být přes `metadata` nebo vlastní rozšíření.
5. Neověřeno: horní praktické škálovací chování `PriceList`/`PriceRule` při 8-10 tierech × celý katalog (bod 5) — self-hosted DB nemá vendor-vynucený strop, ale to neznamená, že to je zadarmo výkonnostně; nutný spike, pokud by šlo do produkce.
6. Neověřeno: existence/název Medusa ekvivalentu `draftOrderCalculate` pro simulaci cart/order bez vytvoření (bod 11).
7. **Medusa Cloud feature-matice per tier nebyla ověřena se stejnou jistotou jako licenční fakt** (bod 6) — pravděpodobně jde jen o infrastrukturu, ne o commerce feature gating, ale tohle je odvozený závěr z formulace marketingové stránky, ne přímá citace feature-matice.
8. Kategorie: multi-membership `ProductCategory` vs. singulární `category` string (bod 2) — stejné otevřené rozhodnutí jako u obou předchozích platforem.
9. B2B/multi-buyer koncept (bod 3) — Medusa core nemá vestavěný ekvivalent Shopify `Company`/`CompanyLocation` nebo BigCommerce B2B Edition; pokud by byl v budoucnu potřeba, vyžadovalo by to vlastní modul nebo ověření komerčních B2B nabídek v Medusa ekosystému, což tato rešerše necílila.
10. **Cesta B z bodu 9 (nahrazení celého Pricing Modulu vlastní implementací) je technicky potvrzená jako možná (Module Isolation), ale nebyla ověřena na úrovni "jak přesně se to dělá krok za krokem"** — pokud by cesta A z nějakého důvodu nestačila, nutný samostatný spike, ne teoretický předpoklad.

---

## Architecture conclusion

### CORE — co může zůstat beze změny
`PricingInput`/`PricingResult`/`PricingCommand`/`RuleType`/`EngineConfig` (`src/core/interfaces.ts`), `determineTier()` (`src/core/customer-tier.ts`) a celá `PricingEngine`/`PricingPolicy` pipeline (`src/core/PricingEngine.ts`, `src/policies/*`) nepotřebují žádnou úpravu pro Medusu. Třetí nezávislé potvrzení (po Shopify, po BigCommerce) hypotézy "stejné jádro + tenký platformní adapter = stejná deterministická cena" — a tentokrát proti platformě, která má vlastní zabudovaný pricing engine, což byl nejsilnější možný test téhle hypotézy ze všech tří.

### MEDUSA ADAPTER — co musí být platform-specific
Normalizace `ProductVariant` → `PricingInput` včetně dotazu do Pricing Modulu pro base cenu (bod 2), vlastní Order-Modul agregace obratu (bod 4, stejná zátěž jako BigCommerce), tier→`CustomerGroup`/`PriceList`(`override`) mapování a zápis přes `Price` záznamy (bod 5, 9, cesta A), `calculatePrices`-based verifikace s možností přímého service volání (bod 11), operational `metadata` (bod 8). Zvláštnost oproti oběma předchozím platformám: adapter může (a v duchu self-hosted výhody pravděpodobně by měl) běžet **uvnitř** Medusa instance jako vlastní modul/subscriber, ne jen jako externí HTTP klient.

### GAPS — co Medusa neumí nebo řeší zásadně jinak
- Žádné hotové "lifetime spend" pole na `Customer` (stejný gap jako BigCommerce, na rozdíl od Shopify `amountSpent`).
- Žádné nativní `manufacturer`/brand pole na produktu (na rozdíl od obou předchozích platforem).
- Base cena není pole na produktu/variantě vůbec — vyžaduje dotaz do samostatného Pricing Modulu i pro tu nejzákladnější "výchozí" cenu, což je koncepčně náročnější první krok než u Shopify/BigCommerce (kde alespoň base cena byla přímé pole).
- Přesný vztah Promotion Module vs. Price List zůstává neověřený (stejná třída mezery jako u obou předchozích platforem), i když je teoreticky ověřitelný čtením kódu.
- Medusa **nabízí** invazivnější cestu (nahrazení celého Pricing Modulu, bod 9 cesta B), kterou Shopify/BigCommerce vůbec nenabízely jako možnost — to není gap ve schopnostech, je to riziko špatného architektonického rozhodnutí (sáhnout po B, když stačí A).

### COMPARISON TO SHOPIFY/BIGCOMMERCE — plan-gating story a otázka architektonického fitu

**Plan-gating**: koncept se na Medusu nevztahuje ve stejném tvaru. Shopify po "B2B for all" má gate z velké části odstraněný (jen strop 3 katalogů na nižších plánech), BigCommerce má gate tvrdý a jednoznačný (Price Lists = Enterprise-only), Medusa **nemá žádný vendor-vynucený gate na commerce logiku vůbec** — celý Pricing/Promotion/Customer/Order Module je MIT open source, Enterprise Edition se týká jen RBAC admin-panel přístupu, ne pricing mechanismu. Jediná "cena" je operační: Jan musí backend sám nasadit a provozovat (bod 19), což SaaS platformy dělaly za něj.

**Architektonický fit (bypass vs. replikace)**: na rozdíl od zadání této rešerše, které předpokládalo, že vlastní pricing engine Medusy by mohl vytvořit friction, tahle rešerše zjistila, že **fit zůstává stejně čistý jako u Shopify/BigCommerce** — pokud se zvolí cesta A z bodu 9 (psát do `PriceList` typu `override` jako do "fixed-price" mechanismu, přesně jako Shopify `PriceList`/BigCommerce `Price Record`). Medusa nenutí Jana k replikaci core logiky jako nativní pravidla (cesta C, nedoporučeno) ani k nahrazení celého modulu (cesta B, technicky možné přes Module Isolation, ale zbytečné pro tenhle use-case). Skutečná friction je jinde: base cena vyžaduje dotaz do modulu místo čtení pole (bod 2), a "adapter" se architektonicky rozostřuje mezi "externí klient" a "vlastní Medusa modul" (bod 12, 13) — což je posun v designové otázce, ne blokující překážka.

**Price Truth**: self-hosting problém nezruší, ale mění nástroj řešení z empirické API-verifikace (Shopify Spike 2, BigCommerce bod 10 — obojí zůstalo částečně otevřené s nejistotou) na code-level auditovatelnost (bod 10) — silnější epistemická pozice, ale s novým rizikem: Jan teď vlastní korektnost a dostupnost samotného pricing mechanismu, ne jen synchronizaci k němu.

### RECOMMENDATION — je architektura CORE + MEDUSA ADAPTER realistická, a jaký je nejčistší další krok?

**Ano, architektura je realistická — třetí nezávislé potvrzení bez blokujícího faktu srovnatelného s BigCommerce Enterprise-gate.** Na rozdíl od BigCommerce (kde další krok byl "napřed obchodní rozhodnutí o Enterprise plánu") a částečně Shopify (kde další krok byl "potvrdit Plus status"), u Medusy **není žádné obchodní rozhodnutí o plánu, které by blokovalo návrh** — jediné rozhodnutí je "chce Jan self-hostovat Medusu vůbec" (out of scope téhle rešerše, je to volba platformy, ne feature-gate).

Doporučený další krok, spike-worthy položky (neřešit teoreticky, ověřit prakticky proti lokální/dev Medusa instanci):
1. **Ověřit `PriceSet`↔`ProductVariant` module link chování** (otázka 16.1) — vytváří se automaticky, nebo je nutná explicitní správa v adapteru? Tohle je první praktický krok, protože bez něj nejde ani začít s normalizací base ceny (bod 2).
2. **Přečíst zdrojový kód** (ne dokumentaci) cart/checkout pipeline ohledně přesného pořadí Pricing Module vs. Promotion Module aplikace (otázka 16.2) — tohle je jedinečná výhoda self-hosted pozice (bod 10), měla by se využít, ne obcházet stejnou empirickou cestou jako u SaaS platforem.
3. **Malý spike** ověřující (a) přesné chování `calculatePrices` rankingu s reálným `override` price listem + `customer.groups.id` pravidlem proti lokální instanci, (b) dostupná pole/statusy Order Modulu pro spend agregaci odpovídající historické Shoptet definici obratu, (c) praktickou latenci/výkon zápisu `Price` záznamů napříč celým katalogem × 10 tiery.

Tyto tři kroky jsou levné (lokální dev instance, žádná závislost na obchodním rozhodnutí o plánu) a měly by jít provést rovnou, na rozdíl od obou předchozích platforem, kde se čekalo na potvrzení plánu/kontraktu.
