# BigCommerce Discovery — Fáze 1

Rozsah: pochopit datový model a API možnosti BigCommerce natolik hluboko, aby šel v budoucnu navrhnout normalizer BigCommerce → `PricingInput` a zápisová/verifikační cesta `PricingResult` → BigCommerce, beze změny existující core pricing logiky. Čistě rešeršní dokument — žádný kód, žádný store, žádný adapter, žádné zápisy, žádná implementace. Zdroje: oficiální `developer.bigcommerce.com` / `docs.bigcommerce.com` a `bigcommerce.com/essentials/pricing` (oficiální feature-matice per plán). Mirroruje strukturu `SHOPIFY-DISCOVERY.md`.

Referenční soubory z repa: `src/core/interfaces.ts` (`PricingInput`, `PricingResult`, `CustomerTier`), `src/core/customer-tier.ts` (`determineTier()`), `src/core/PricingEngine.ts` (policy pipeline), `cloudflare-worker/src/coupon/tier-pricelist-map.ts` (existující Shoptet-adapter vzor `TIER_PRICELIST_MAP`, který se osvědčil i pro návrh Shopify `PriceList`/`Catalog` mapování — stejný vzor je relevantní i zde).

---

## 1. Data model relevantní pro pricing

- `Product` → 1..N `Variant` (BigCommerce terminologie: "variants", dřív částečně přes "SKUs" v legacy V2 API). Variant nese vlastní `sku`, `id`, a vlastní `price`/`sale_price`/`cost_price` override vůči produktu — **na rozdíl od Shopify, kde base cena žije výhradně na variantě**, BigCommerce nechává base cenu primárně na `Product` (`price`, `sale_price`, `retail_price`, `cost_price`) a variant má tato pole jako **volitelný override** (nullable — pokud `null`, dědí se z produktu).
- `Product.sku` i `Variant.sku` existují nezávisle — SKU se dá nastavit na produktové i variantové úrovni, což je jiný vzor než Shopify (kde SKU je čistě variant-level).
- Kategorie: `Product.categories` je pole ID kategorií (`[Int]`) — multi-membership, podobně jako Shopify `Collection`, ne striktní jedna-kategorie-na-produkt strom. Stejný strukturální nesoulad proti našemu singulárnímu `category: string` jako u Shopify.
- `Brand` (dříve "Brand"/"Manufacturer" objekt) — nejbližší analog `manufacturer`, je to skutečný referenční objekt (`brand_id` na produktu), ne volný text jako Shopify `vendor` — potenciálně čistší mapování.
- `Customer`/`Customer Group` — B2C i B2B mechanismus, viz body 3–6.
- `Price List` — samostatný objekt nesoucí kolekci `Price Record` (viz bod 5) — koncepčně blízký Shopify `PriceList`, ale s jiným plánovým gatingem (bod 6).
- Hlavní API surface: REST Management API v3 (Catalog, Customers, Price Lists) + GraphQL Storefront API (čtení kontextualizované ceny pro přihlášeného zákazníka) — viz bod 12.

## 2. Product mapping

| Náš `PricingInput` field | BigCommerce API objekt.pole | Typ | Vždy dostupné? | Omezení / poznámka |
|---|---|---|---|---|
| `sku` | `Product.sku` nebo `Variant.sku` | `String` | Ano na produktu (často povinné v praxi), na variantě volitelné | Dvouvrstvý SKU model — normalizer musí explicitně rozhodnout prioritu (variant SKU > product SKU), jinak riziko kolize identity |
| — (variant identita) | `Variant.id` | `Int` | Ano, vždy | Stabilní primární klíč pro `Price Record.variant_id` (viz bod 5) — price records se váží na `variant_id`, ne na SKU, stejný vzor jako Shopify |
| — (produkt identita) | `Product.id` | `Int` | Ano | Potřebné pro metafieldy na úrovni produktu, `categories`, `brand_id` |
| `basePrice` | `Product.price` (dědí se do `Variant.price`, pokud variant override `null`) | `Decimal`/`Number` | Ano | Na rozdíl od Shopify jde o produkt-úrovňové pole s volitelným variant override — normalizer musí řešit resoluci "efektivní base cena" (variant override, pokud existuje, jinak product price), ne jen přečíst jedno pole |
| `salePrice` | `Product.sale_price` / `Variant.sale_price` | `Decimal`/`Number`, nullable | Ne vždy | Sémanticky bližší našemu konceptu než Shopify `compareAtPrice` — `sale_price` je aktivní snížená cena k prodeji (ne "přeškrtnutá" referenční cena), ale pořád nutná explicitní rozhodovací tabulka v případné Fázi 2, protože BigCommerce navíc má `retail_price` jako samostatné "MSRP/přeškrtnutá cena" pole — tj. BigCommerce má rozdělené to, co Shopify slévá do `compareAtPrice` |
| `manufacturer` | `Product.brand_id` → `Brand.name` | `Int` → `String` | Ano, pokud produkt má přiřazený brand | Čistší mapování než Shopify `vendor` (referenční objekt, ne volný text) — méně rizika normalizačního driftu |
| `category` | `Product.categories` (`[Int]`, N:M na `Category`) | `[Int]` | Ano, ale multi-membership | Stejný strukturální nesoulad jako Shopify `Collection` proti singulárnímu `category: string` — potřeba explicitní rozhodnutí (primární kategorie? první ID v poli? mapovací tabulka?), neověřeno jako triviální |
| `productMaxDiscount` | Žádné nativní pole — jedině metafield/custom field | — | Ne, muselo by se vytvořit | Stejný závěr jako u Shopify — policy data zůstávají v core, ne na platformě |
| `purchasePrice` | `Product.cost_price` | `Decimal`/`Number`, nullable | Ne vždy vyplněno | Na rozdíl od Shopify (kde nejbližší ekvivalent `InventoryItem.unitCost` žije na jiném objektu) je tohle přímo pole na `Product`/`Variant` — čistší mapování |
| `currency` | Store-level `default_currency` (Store Information API) nebo `Price Record.currency` v Price List kontextu | `String` (ISO 4217) | Ano | Price List umí nést více měn současně v jednom listu (multi-currency price records) — viz bod 5 |
| `vatRate` | Žádné přímé pole na produktu — daň se řeší přes `Tax Classes`/`Tax Zones` (Store-level tax settings, případně Avalara/TaxJar integrace) | — | Ne přímo | Stejná situace jako Shopify — DPH je odvozená z tax konfigurace obchodu/regionu, ne uložená jako sazba per produkt; pokud core potřebuje explicitní `vatRate`, musí přijít z vlastní konfigurace, ne z API |

## 3. Customer mapping

| Náš potřebný vstup | BigCommerce API objekt.pole | Typ | Vždy dostupné? | Omezení / poznámka |
|---|---|---|---|---|
| identita zákazníka | `Customer.id` | `Int` | Ano | Primární klíč (REST Customers V3) |
| e-mail | `Customer.email` | `String` | Ano (povinné pro registrovaného zákazníka) | — |
| skupina | `Customer.customer_group_id` | `Int`, nullable | Ano jako pole, ale hodnota jen pokud je zákazník do skupiny přiřazen | Přímý nosič tier-signálu — analog Shopify `Customer.tags`, ale silnější: je to skutečný referenční, strukturovaný FK na `Customer Group`, ne volný tag string |
| objednávky | Orders API (`GET /v2/orders?customer_id=`) | kolekce `Order` | Ano | Žádné agregační pole na `Customer` objektu — nutná vlastní agregace, viz bod 4 |
| celkový obrat | **Žádné nativní pole na `Customer` objektu** (ověřeno — v REST Customers V3 schema nenalezeno žádné `lifetime_spend`/`total_spent`/`amount_spent` pole; jen `store_credit`) | — | **Ne** | **Klíčový rozdíl proti Shopify**: Shopify má `Customer.amountSpent` jako přímo dostupné agregované pole (byť s nejistou přesnou definicí, viz Shopify Spike 2). BigCommerce nemá tento field vůbec. Jan by musel od prvního dne stavět vlastní agregaci obratu z Orders API (viz bod 6) — žádná "levná první cesta" tady neexistuje |
| tier (ZR4…ZR25) | Žádné nativní BigCommerce pole — musí se odvodit nebo uložit | — | Ne | Stejné dvě cesty jako u Shopify: (a) odvodit za běhu z vlastní agregace a nikam neukládat, (b) promítnout odvozený tier do `customer_group_id` (přiřazení zákazníka do konkrétní `Customer Group` odpovídající tieru) pro použití v nativním Price List mechanismu — (b) je tady navíc přímo nutná podmínka pro Price List fungování, ne jen volitelný cache/signál jako Shopify tag |
| B2B kontext | `Customer Group` (nativní, dostupné od plánu Growth výš) + volitelně `B2B Edition` (samostatný Enterprise add-on s vlastním Company/Buyer Portal modelem) | objekty | `Customer Group` ano od Growth; `B2B Edition` ne, samostatný placený add-on | Klíčové rozlišení — viz bod 6 |

## 4. Customer tier mapping — datová cesta do existujícího `determineTier()`

`determineTier()` (`src/core/customer-tier.ts`) zůstává čistá funkce `(totalOrderValue: number) => CustomerTier | undefined` s pevnými prahy. Tahle rešerše nenavrhuje měnit tuto logiku — jen popisuje, odkud by přitékal `totalOrderValue` na BigCommerce.

Navrhovaná datová cesta (bez implementace):

1. **Neexistuje BigCommerce-natívní "levná cesta"** jako Shopify `amountSpent` — adapter by musel od začátku číst `Orders API` (`GET /v2/orders?customer_id={id}&status_id=...`, paginovaně) a sčítat `Order.total_inc_tax`/`total_ex_tax` (rozhodnutí, které pole odpovídá historické Shoptet definici obratu, je otevřená otázka, ne technický fakt).
2. Nutné explicitní filtrování stavu objednávky (`status_id`) — BigCommerce order statusy zahrnují mj. Incomplete, Pending, Shipped, Completed, Cancelled, Refunded, Declined — bez filtru na "platné/zaplacené" statusy by agregace nekonzistentně zahrnula zrušené/nedokončené objednávky. Přesná množina statusů, která odpovídá Shoptet-definici "obratu", je otevřená otázka pro budoucí Fázi 2, ne teď.
3. Výsledné číslo se předá do `determineTier(totalOrderValue)` beze změny — stejný kontrakt jako u Shopify a Shoptet adapterů.
4. Výstup `CustomerTier | undefined` by se pak musel zapsat zpět jako `customer_group_id` přiřazení (viz bod 3, bod 6) — to je BigCommerce specifický extra krok, který Shopify nevyžadoval nutně (tag byl volitelný cache, tady je `customer_group_id` sám mechanismus, který Price List používá k rozlišení ceny).
5. **Důsledek**: BigCommerce adapter má od dne 1 vyšší implementační náklad na "customer tier" větev než Shopify adapter měl (žádné hotové agregované pole k ověření/použití) — to je zásadní rozdíl k zohlednění v odhadu Fáze 2/3, ne detail.

## 5. Customer-specific pricing možnosti — Price Lists + Customer Groups (deep dive)

**A. `Price List` + `Price List Assignment` na `Customer Group` (+ volitelně `channel_id`)** — nejsilnější/nejčistší mechanismus, přímý analog Shopify `PriceList`/`Catalog`:

- `Price List` je "kolekce price records" (ověřeno, `docs.bigcommerce.com/developer/docs/admin/catalog-and-inventory/pricing/price-lists`).
- `Price Record` — jednotka uvnitř Price Listu, klíčovaná na `variant_id`, s poli `price` (povinné), `currency` (povinné), a volitelně `sale_price`, `retail_price`, `map_price`. **Ukládá absolutní fixní cenu, ne procento** — to je přesně ten fit, který náš core potřebuje (`finalPrice` je už vypočtená absolutní hodnota po všech pravidlech), stejný závěr jako u Shopify fixed-price PriceList módu.
- `Price List Assignment` — samostatný objekt spojující `price_list_id` + `customer_group_id` (+ volitelně `channel_id` pro víc-kanálové obchody) — "Price list assignments combined with a customer group assignment allows you to better target the signed-in customers shopping on that channel" (`docs.bigcommerce.com/developer/docs/admin/catalog-and-inventory/pricing/price-lists`).
- Bulk zápis: `PriceRecordBatch` endpoint podporuje až 1000 price records na jedno API volání; paralelní volání na stejný store vrací `429` — nutná sekvenční/frontovaná strategie pro velký katalog × 10 tierů, stejná třída problému jako Shopify Fáze 2 spike bod 6.
- Vztah k Bulk Pricing Rules (bod 5B níže): existující price record na variantě **potlačuje** produktovou bulk-pricing pravidlo v košíku ("If a variant has a Price Record, any existing product-level bulk pricing will not apply in the cart") — důležité pro návrh, protože znamená, že Price List a Bulk Pricing Rules nejsou nezávislé vrstvy, ale Price List vyhrává.
- **Doporučený vzor 1:1 s existujícím `TIER_PRICELIST_MAP`**: jeden `Customer Group` + jeden `Price List` pár na tier (ZR4…ZR25), analogicky k Shoptet/Shopify vzoru — strukturálně čistý přenos, žádný objevený tvrdý strop na počet Customer Groups nebo Price Listů byl v této rešerši nalezen (na rozdíl od Shopify Standard plánu se stropem 3 katalogů) — **ale toto neplatí, protože samotný Price List mechanismus je na jiném plánu než Customer Groups, viz bod 6, což je závažnější blokace než číselný strop**.

**B. Bulk Pricing Rules** — kvantitativní slevy (množstevní pásma) na úrovni produktu/varianty, typy úpravy `price`/`percent`/`fixed`. Nejsou zákaznicky specifické (nevážou se na `customer_group_id`), takže nejsou přímým fitem pro tier-based pricing — spíš doplňkový mechanismus, ne náhrada Price Listu.

**C. Customer Group Discounts (procentuální)** — starší/jednodušší mechanismus, kde lze skupině nastavit plošnou % slevu z katalogové ceny bez Price Listu. Funguje jako sleva aplikovaná za běhu, ne jako uložená absolutní cena — stejný nevýhodný fit jako Shopify "cesta B" (segment + %) proti "cestě A" (uložená absolutní PriceList cena): nekryje naši potřebu nést přesně vypočtenou `finalPrice` po víc pravidlech najednou (tier + brand/category cap).

**Nepoužitelné**: přímá úprava `Product.price`/`Variant.price` — globální hodnota pro celý shop, ne per-zákazník, stejný závěr jako Shopify.

## 6. Plan/tier gating — kritické srovnání se Shopify Plus

**Ověřeno přímo z oficiální feature-matice BigCommerce (`bigcommerce.com/essentials/pricing`, plány Core/Growth/Scale/Performance = BigCommerce interní ekvivalenty Standard/Plus/Pro/Enterprise):**

| Feature | Core | Growth | Scale | Performance (Enterprise) |
|---|---|---|---|---|
| Customer Groups and Segmentation | — | ✓ | ✓ | ✓ |
| Price Lists | — | — | — | ✓ |

- **`Customer Group` je dostupný od druhého nejnižšího plánu (Growth) výš** — nejde o Enterprise-exkluzivní feature.
- **`Price List` je exkluzivní pro nejvyšší plán (Performance/Enterprise)** — potvrzeno doslovným popisem z oficiální stránky: "Give B2B customers a B2C-level experience with custom pricing at the SKU level for customer groups."
- **Důsledek pro architekturu**: na rozdíl od Shopify (kde se po "B2B for all" ukázalo, že `Company`/`CompanyLocation`/`Catalog`/`PriceList` fungují i na Standard/Basic/Grow/Advanced, jen se stropem 3 katalogů), BigCommerce má **tvrdší a jednoznačnější gate** — Price List mechanismus, jediná cesta k uložené absolutní per-tier ceně, **není dostupný vůbec** mimo nejvyšší (Enterprise) plán. Customer Groups samotné (bez Price Listu) umožňují jen procentuální slevu (bod 5C) nebo produkt-viditelnost, ne uloženou absolutní `finalPrice`.
- **`B2B Edition`** je samostatný placený add-on nad Enterprise (vlastní custom pricing, ne součást žádného standardního plánu) — přidává Company/Buyer-Portal/role-based schvalování nad rámec toho, co potřebujeme (tier pricing). Pro čistě cenový use-case (ne celý B2B nákupní workflow) **není nutný** — nativní Price List na Enterprise stačí. To je důležité rozlišení, protože prodejní materiály B2B Edition a Price Lists často míchají dohromady.
- **Menší nejistota**: jeden sekundární zdroj (agenturní blog, ne `developer.bigcommerce.com`) tvrdil "Price lists are available starting with the Pro (Scale) plan" — v přímém rozporu s oficiální feature-matici BigCommerce. Vzhledem k rozporu beru za autoritativní přímo `bigcommerce.com/essentials/pricing` (primární, oficiální zdroj) a sekundární tvrzení odmítám jako pravděpodobně zastaralé/nepřesné — ale doporučuji ověřit proti aktuálnímu Janovu obchodnímu plánu/kontraktu před uzamčením návrhu, protože feature-matice na marketing stránkách se občas mění bez API-side changelogu.

**Srovnání se Shopify jednou větou**: Shopify Plus gate byl z velké části **odstraněn** (B2B for all, jen strop 3 katalogů na nižších plánech); BigCommerce gate na Price Lists je **plně zachovaný a jednoznačný** — bez Enterprise plánu není nativní uložená per-tier cena na BigCommerce vůbec dostupná.

## 7. Discounts / Coupons — interakce s Price List cenami

- Coupony (`Coupon Codes API`, `discountAutomaticBasicCreate`-analog neexistuje 1:1, BigCommerce má vlastní `Promotions API`) podporují typy `per_item_discount`, `per_total_discount`, `shipping_discount`, `free_shipping`, `percentage_discount`.
- **Kombinovatelnost**: BigCommerce ve výchozím stavu povoluje jen jeden coupon na objednávku, pokud administrátor explicitně nepovolí "Allow multiple coupons per order" v Promotion Settings — to je jinačí výchozí chování než Shopify (kde `DiscountCombinesWith` je vždy explicitně nakonfigurovaná matice per-discount).
- **Explicitně potvrzené omezení**: "You cannot add a coupon when an item-level manual discount is already applied" — signál, že BigCommerce má nějakou vrstvu vzájemného vyloučení mezi manuálními/item-level slevami a coupony, ale přesný vztah **konkrétně mezi aktivní Price List cenou a coupon aplikací nebyl v této rešerši nalezen s vysokou jistotou** v žádném oficiálním dokumentu — je to otevřená otázka.
- **Odvoditelný, ne přímo potvrzený závěr**: Price List cena je uložená "list" cena produktu/varianty pro danou customer group/kanál (nahrazuje `Product.price` v tom kontextu) — coupon/promotion aplikace se typicky odehrává jako dodatečná vrstva nad výslednou cenou v košíku, ne jako něco, co se automaticky "ví" o tom, že cena už je tier-specifická. To znamená **stejné strukturální riziko jako u Shopify `combinesWith`**: pokud je Price List cena už finální vypočtená core hodnota (tier + capy), coupon na ni **pravděpodobně** může sáhnout navíc, pokud není explicitně nakonfigurováno jinak — ale BigCommerce nemá zdokumentovaný ekvivalent Shopify Functions pro vlastní "nekombinuj, pokud už je produkt na max slevě" pravidlo mimo základní `combinesWith`-styl coupon/promotion nastavení. **Nutno ověřit empiricky v případné Fázi 2** — tahle rešerše to nedokázala uzavřít s jistotou z dokumentace samotné, stejná limitace jako u Shopify.
- Architektonické obejití je stejné jako u Shopify: pokud Price List cena je jediná aktivní cenová vrstva a coupony pro tier-locked zákazníky (ZR20/ZR25 analog) se prostě nepovolí/nevydají, problém kombinovatelnosti odpadá designem, ne verifikací.

## 8. Metafieldy / Custom Fields

BigCommerce má **dva oddělené mechanismy**, na rozdíl od Shopify (jeden `Metafield` systém):

- **Custom Fields** (`Product.custom_fields`) — jednoduché name/value páry, **dostupné jen na úrovni produktu, ne varianty** (ověřeno: "custom fields are available only for products, not variants" — support.bigcommerce.com). Slabý fit pro cokoliv, co potřebuje být per-variant/per-tier.
- **Metafields** (`Product Metafields`, `Variant Metafields`) — silnější mechanismus, key-value s `namespace` + `permission_set`, dostupný i na úrovni varianty (`/v3/catalog/products/{id}/variants/{id}/metafields`). Limit: **max 250 metafieldů na variantu na client ID** (ověřeno).
- Metafieldy jsou API-only (žádné natívní admin UI zobrazení bez custom app) — podobná charakteristika jako Shopify metafieldy bez definice.
- **Posouzení (ne doporučení k okamžitému použití), stejná logika jako u Shopify**: vhodné pro operational/audit metadata (verze/hash posledního zápisu `PricingResult`, sync timestamp) na úrovni varianty; nevhodné pro duplikaci policy dat (limity, prahy), která musí zůstat v core — jinak druhý zdroj pravdy.
- **Neověřeno s vysokou jistotou**: zda lze filtrovat/dotazovat varianty podle hodnoty metafieldu v bulku (u Shopify tohle bylo explicitně potvrzeno jako nemožné) — tahle rešerše to pro BigCommerce nenašla zdokumentované ani jedním směrem, nutno ověřit v případném spiku.

## 9. `PricingResult` → BigCommerce write možnosti

Konzistentní s bodem 5:

1. **`Price Record` v `Price List` přiřazeném k `Customer Group`** (doporučeno, viz bod 5A) — `PriceRecordBatch` bulk upsert, klíčováno na `variant_id`. **Vyžaduje Enterprise plán** (bod 6) — to je tvrdší blokující předpoklad než u Shopify.
2. **Customer Group % sleva** (bod 5C) — funguje na nižších plánech (Growth+), ale nese jen procentuální slevu z `Product.price`, ne uloženou absolutní `finalPrice` — core produkuje absolutní hodnotu po víc pravidlech (tier + capy + rounding), takže tenhle mód by vyžadoval buď zjednodušení (jeden % strop na skupinu, ztráta granularity produktových/brand capů), nebo obcházení přes fiktivní "jeden produkt = jedna sleva" mapping, což je architektonicky slabší fit.
3. Bulk Pricing Rules (bod 5B) nejsou per-customer, nehodí se jako primární zápisová cesta pro tier pricing.

Rozhodnutí mezi 1 a 2 visí čistě na tom, jestli cílový BigCommerce obchod je/bude na Enterprise plánu — bez toho nelze plnohodnotný (absolutní, přesný) zápis `finalPrice` navrhnout.

## 10. Price Truth — může API spolehlivě říct, co konkrétní zákazník skutečně zaplatí?

Stejná klíčová otázka jako u Shopify, položená pro BigCommerce:

**Co API vrací (uložený stav):**
- `Product.price`/`Variant.price` — globální/produktová base cena, žádný customer kontext.
- `Price Record` v Price Listu — deklarovaná cena pro danou `customer_group_id` (+ volitelně kanál), ale je to pořád *deklarace* vázaná na to, že zákazník je správně přiřazený do dané `Customer Group` a že žádná jiná vrstva (coupon, bulk pricing rule) cenu dodatečně nemění.

**Co API umí vrátit jako kontextualizovanou cenu:**
- **GraphQL Storefront API** — při dotazu s autentizovaným `customer access token` "it's possible to fetch... real-time storefront data such as customer-specific pricing in the shopper's currency" a "Pricing... response values can vary based on the customer... returns pricing that reflects that specific customer's pricing tier or discounts" (ověřeno z oficiální dokumentace/přehledů `developer.bigcommerce.com/docs/storefront/graphql`). **To je silnější signál než u Shopify** — BigCommerce GraphQL Storefront API explicitně popisuje customer-specific pricing jako běžný, ne B2B-exkluzivní scénář (na rozdíl od Shopify `@inContext(buyer:)`, který je dokumentačně výhradně B2B).
- Nalezená konkrétní pole (`prices { price { ...PriceFields } priceRange { min max } }`) v příkladové query nepotvrzují explicitně, že hodnota zahrnuje i aktivní coupon/promotion – dokumentace k tomu mlčí, stejná mezera jako u Shopify. **Nejistota k přiznání**: přesný rozsah toho, co `prices` v GraphQL Storefront API zahrnuje (jen Price List override, nebo i aktivní automatické promotion), nebyl v této rešerši ověřen s vysokou jistotou — nutný empirický test proti dev/sandbox store v případné Fázi 2.
- `show_product_price` toggle v control panelu může nastavit `prices` na `null` v GraphQL odpovědi — provozní detail k zohlednění, ne blokující.

**Rozdíl proti Shopify**: u Shopify byla zásadní mezera "žádný obecný B2C per-customer price-truth kanál, jen B2B `@inContext`". U BigCommerce GraphQL Storefront API se customer-specific pricing (přes customer access token) jeví jako **obecně dostupný mechanismus, ne B2B-vázaný** — to je potenciálně příznivější Price Truth situace, **ale s výhradou**, že tahle rešerše nenašla stejně důkladné primární-zdrojové potvrzení jako u Shopify Spike 2 (kde bylo `contextualPricing`/`@inContext` ověřeno pole-po-poli z Admin GraphQL reference). Toto je **otevřená otázka k dořešení případným spikem**, ne uzavřený závěr.

**Shrnutí**: Price Truth na BigCommerce je pravděpodobně **lépe řešitelný** než na Shopify B2C (obecný GraphQL Storefront kontextualizovaný dotaz existuje, není B2B-gated), ale **jen pokud je Price List (Enterprise) dostupný** — bez Enterprise nemá smysl Price Truth vůbec řešit, protože není co verifikovat (jen % skupinová sleva, bod 5C).

## 11. Verification/reconciliation možnosti

- Analogicky k Shopify: reconciliation by porovnával `core PricingResult.finalPrice` vs. GraphQL Storefront kontextualizovaná cena pro daného zákazníka/SKU, s explicitním seznamem povolených transformací (měna, zaokrouhlení) odečtených před vyhodnocením shody.
- Operational metadata metafield (bod 8) na variantě — verze/hash posledního zápisu — stejná role jako u Shopify, pomáhá odlišit "nesynchronizováno" od "neshoduje se".
- **Neověřeno**: BigCommerce ekvivalent Shopify `draftOrderCalculate` (simulace objednávky bez jejího vytvoření, se zohledněním customer/discount kontextu) — v této rešerši nebyl nalezen jasný BigCommerce protějšek; pokud neexistuje, verifikace by musela spoléhat čistě na GraphQL Storefront kontextualizovanou cenu (bod 10) nebo na skutečný testovací checkout, což je slabší pozice než Shopify mělo (tam `draftOrderCalculate` byl identifikován jako nejsilnější dostupný nástroj, byť s vlastní nejistotou).

## 12. API surface & limitations

- **REST Management API v3** — jediná podporovaná cesta pro Price Lists a Customer Groups. Ověřeno: "Price lists and customer groups are only available through the REST API and not GraphQL currently" — to je **opačný poměr sil** než u Shopify (kde GraphQL Admin je jediná nová cesta a REST je legacy/vypínaný). Na BigCommerce je REST Management API pořád primární pro zápis/administraci.
- **GraphQL Storefront API** — určený pro čtení kontextualizovaných dat z pohledu konkrétního zákazníka/kanálu (ceny, dostupnost) — relevantní pro Price Truth (bod 10), ne pro zápis Price Listů.
- Doporučený API surface pro naši integraci: **REST Management API v3** pro čtení katalogu, zápis Price Records, správu Customer Group přiřazení; **GraphQL Storefront API** pro Price Truth verifikaci. Stejné dvouvrstvé schéma jako u Shopify (Admin pro zápis, Storefront pro verifikaci), jen s prohozenou REST/GraphQL rolí.
- Rate limity: `PriceRecordBatch` — max 1000 records/volání, žádné paralelní volání na stejný store (429). Přesná obecná REST rate-limit čísla (requests/min) nebyla v této rešerši ověřena do detailu — nutný spike, stejně jako u Shopify GraphQL cost limitů.
- Potřebné OAuth scopes (odhad z mapovaných endpointů): Products (read/modify), Customers (read/modify), Price Lists (read/modify — pravděpodobně samostatný scope, neověřeno přesné jméno), Orders (read, pro spend agregaci), Information/Store (read).

## 13. Doporučený adapter design (návrhový nákres, neimplementováno)

```typescript
// Návrh, ne implementace. Stejná hranice jako Shopify adapter návrh (SHOPIFY-DISCOVERY.md bod 13) —
// core (PricingInput/PricingResult/determineTier) se nemění, platformní specifika
// žijí za tímto rozhraním. Rozhraní EcommercePlatformAdapter je sdílené napříč platformami,
// jen implementace se liší.

interface EcommercePlatformAdapter {
  fetchProductsForPricing(params: { cursor?: string; limit?: number }): Promise<{
    items: RawPlatformProduct[];
    nextCursor?: string;
  }>;

  normalizeToInput(raw: RawPlatformProduct, tier: CustomerTier | undefined): PricingInput;

  /** Na BigCommerce nutně přes vlastní Orders API agregaci (bod 4) — na rozdíl
   *  od Shopify tu není žádné hotové "amountSpent"-like pole k prvnímu použití. */
  fetchCustomerTotalSpend(customerId: string): Promise<number>;

  /** Zápis PricingResult zpět. Na BigCommerce: Price Record v Price Listu
   *  přiřazeném k Customer Group (bod 5A, 9) — vyžaduje Enterprise plán (bod 6).
   *  Musí být idempotentní a dry-run-first, stejně jako Shoptet/Shopify adapter. */
  writePricingResult(result: PricingResult, tier: CustomerTier, opts: { dryRun: boolean }): Promise<WriteOutcome>;

  /** Verifikace přes GraphQL Storefront API s customer access token (bod 10) —
   *  potenciálně silnější než Shopify B2C cesta, ale neověřeno stejnou jistotou. */
  verifyCustomerVisiblePrice(customerId: string, sku: string): Promise<{
    apiStoredPrice: Decimal;
    customerVisiblePrice: Decimal | null;
    matches: boolean | "unknown";
    explainedDiff?: string;
  }>;
}
```

Poznámky:
- Rozhraní je záměrně identické se Shopify návrhem — potvrzuje, že `EcommercePlatformAdapter` kontrakt je skutečně platformně-agnostický na úrovni typového rozhraní, i když implementace `fetchCustomerTotalSpend` a `writePricingResult` se budou lišit podstatně (BigCommerce nemá hotové spend pole, má tvrdší plan gate na zápisovou cestu).
- Toto je návrh k diskuzi pro případnou Fázi 2, ne finální kontrakt.

## 14. Co zůstává v core

Stejně jako u Shopify — beze změny:
- `determineTier()` a všechny prahové hodnoty (`src/core/customer-tier.ts`).
- `PricingPolicy` pravidla, `RuleType`, `PricingCommand`, `EngineConfig` (`src/core/interfaces.ts`, `src/core/PricingEngine.ts`).
- Policy data (max slevy per brand/kategorie/produkt) — zůstávají v core konfiguraci, nekopírovat do BigCommerce metafieldů jako zdroj pravdy.

Tahle rešerše potvrzuje podruhé (po Shopify) tutéž hypotézu: core logika je skutečně platformně nezávislá, žádný z bodů 1–12 výše nevyžaduje zásah do `src/core/`.

## 15. Co patří do BigCommerce adapteru

- Normalizace `Product`/`Variant` → `PricingInput` (bod 2), včetně resoluce variant-vs-product cenového override.
- Vlastní agregace obratu z Orders API → vstup do `determineTier()` (bod 4) — BigCommerce-specifický extra krok, žádné hotové pole.
- Tier → `Customer Group` přiřazení + `Customer Group` → `Price List` mapování (analog `TIER_PRICELIST_MAP`, bod 5A, 6).
- Zápis `PricingResult.finalPrice` do `Price Record` (bod 9) — podmíněno Enterprise plánem.
- Verifikace přes GraphQL Storefront customer-specific pricing (bod 10).
- Operational metadata metafieldy na variantě (bod 8).

## 16. Otevřené otázky / rizika

1. **Blokující**: je/bude cílový BigCommerce obchod na Enterprise (Performance) plánu? Bez něj Price List mechanismus (jediná cesta k uložené absolutní per-tier ceně) není dostupný vůbec — na rozdíl od Shopify, kde po "B2B for all" existovala i kompromisní cesta na nižších plánech. Zde kompromisní cesta (Customer Group % sleva, bod 5C/9.2) existuje, ale je architektonicky slabší fit (jen % strop, ne absolutní finalPrice).
2. Chybí `Customer.amountSpent`-analog — vlastní Orders API agregace je nutná od dne 1, s otevřenou otázkou přesné definice statusů/polí odpovídajících historické Shoptet definici obratu (bod 4).
3. Přesný vztah Price List ceny vs. coupon/promotion aplikace (bod 7) neověřen s vysokou jistotou — riziko stejné třídy jako Shopify `combinesWith`, ale bez zdokumentovaného BigCommerce ekvivalentu Shopify Functions pro vlastní řešení.
4. Kategorie: multi-membership `Product.categories` vs. singulární `category` string (bod 2) — stejné otevřené rozhodnutí jako u Shopify.
5. Rozsah toho, co GraphQL Storefront `prices` pole skutečně zahrnuje (jen Price List override, nebo i coupon/promotion) — neověřeno s vysokou jistotou (bod 10), přímo ovlivňuje spolehlivost Price Truth verifikace.
6. Neexistuje potvrzený BigCommerce ekvivalent `draftOrderCalculate` (bod 11) — pokud chybí, verifikační nástroj je slabší než u Shopify.
7. Přesné REST rate limity a Price List OAuth scope jméno neověřeny do detailu (bod 12) — nutný spike před odhadem výkonu případné Fáze 3.
8. `sale_price`/`retail_price` sémantický rozklad (bod 2) — o něco čistší než Shopify `compareAtPrice`, ale pořád vyžaduje explicitní rozhodovací tabulku, ne předpoklad shody s naším `salePrice`.
9. Menší nejistota z bodu 6 (rozporné sekundární tvrzení o plánu, kde se Price Lists odemykají) — doporučeno ověřit přímo u BigCommerce/aktuální smlouvy, ne jen z veřejné feature-matice, než se cokoliv uzamkne.

---

## Architecture conclusion

### CORE — co může zůstat beze změny
`PricingInput`/`PricingResult`/`PricingCommand`/`RuleType`/`EngineConfig` a `determineTier()` nepotřebují žádnou úpravu pro BigCommerce — druhé nezávislé potvrzení (po Shopify) hypotézy "stejné jádro + tenký platformní adapter = stejná deterministická cena". Existující `TIER_PRICELIST_MAP` vzor je přenositelný i sem (tier → `Customer Group` + `Price List` pár).

### BIGCOMMERCE ADAPTER — co musí být platform-specific
Normalizace produktů/variant s resolucí product-vs-variant cenového override (bod 2), vlastní Orders-API agregace obratu (bod 4, BigCommerce-specifická zátěž navíc oproti Shopify), tier→CustomerGroup/PriceList mapování a zápis (bod 5, 9), GraphQL Storefront verifikace (bod 10), operational metafieldy (bod 8).

### GAPS — co BigCommerce neumí nebo řeší zásadně jinak
- Žádné hotové "lifetime spend" pole na `Customer` (na rozdíl od Shopify `amountSpent`) — vlastní agregace nutná bez volby od začátku.
- Žádný potvrzený ekvivalent `draftOrderCalculate` pro simulaci objednávky/cen před zápisem.
- Přesný vztah Price List ceny vs. coupon/promotion kombinovatelnosti nezdokumentovaný stejně jasně jako Shopify `DiscountCombinesWith`.
- Price List (jediná cesta k absolutní per-tier ceně) je tvrdě vázaný na nejvyšší (Enterprise) plán, bez kompromisní "skoro stejně dobré" cesty na nižších plánech — Customer Group % sleva je architektonicky slabší náhrada.

### COMPARISON TO SHOPIFY — víc/míň plan-gated, víc/míň deterministický?

**Plan gating: BigCommerce je přísnější a jednoznačnější.** Shopify po "B2B for all" (duben 2026) zpřístupnil B2B/`PriceList`/`Catalog` mechanismus i na nižších (Basic/Grow/Advanced) plánech, jen se stropem 3 katalogů. BigCommerce naopak drží `Price List` — svůj jediný mechanismus pro absolutní per-tier cenu — výhradně na nejvyšším (Enterprise/Performance) plánu, bez kompromisní cesty srovnatelné kvality. `Customer Groups` samotné jsou dostupné dřív (od Growth), ale bez Price Listu nesou jen procentuální slevu, ne core-kompatibilní absolutní `finalPrice`.

**Price Truth: BigCommerce je potenciálně lépe řešitelný, ale s nižší jistotou ověření.** GraphQL Storefront API explicitně popisuje customer-specific pricing jako obecně dostupný mechanismus (ne B2B-exkluzivní, jak byl Shopify `@inContext(buyer:)`), což je nadějný signál. Ale tahle rešerše ho neověřila se stejnou pole-po-poli jistotou, jakou měla Shopify Spike 2 (kde `contextualPricing`/`@inContext` byly ověřeny přímo z Admin GraphQL schema). BigCommerce Price Truth zůstává otevřená otázka k dořešení spikem, ne uzavřený závěr — ale výchozí signál je příznivější než Shopify B2C mezera.

**Celkově**: BigCommerce nabízí čistší datový model (base cena i `purchasePrice`/`brand` referenčně čistší než Shopify), ale drsnější obchodní gate na jediném mechanismu, který core potřebuje (absolutní per-tier cena = Enterprise-only), a chybí mu jakákoliv hotová "spend" pole, což zvyšuje implementační náklad na tier-mapping větev adapteru oproti Shopify.

### RECOMMENDATION — je architektura CORE + BIGCOMMERCE ADAPTER realistická, a jaký je další krok?

**Ano, architektura je realistická** — potvrzeno stejně jako u Shopify, žádný z nalezených faktů nevyžaduje zásah do core. Ale **než se cokoliv plánuje do detailu**, je nutné vyřešit jeden blokující fakt, stejné pořadí priorit jako u Shopify Spike 1:

1. **Potvrdit plán cílového BigCommerce obchodu.** Bez Enterprise (Performance) je Price List nedostupný a celý návrh musí buď počítat s kompromisní % slevovou cestou (ztráta přesnosti/granularity core logiky), nebo se Fáze 2 nemá začít plánovat do detailu, dokud plán není jasný — přesná paralela s doporučením ze Shopify Spike 1, jen s obráceným závěrem (tam gate z velké části padl, tady drží).
2. **Spike-worthy, ale až po bodu 1**: malý spike proti sandbox/dev store (pokud BigCommerce nabízí něco analogického Shopify Partner dev store) ověřující (a) přesný vztah GraphQL Storefront `prices` pole vs. aktivní coupon/promotion, (b) zda existuje BigCommerce ekvivalent `draftOrderCalculate`, (c) přesnou definici polí pro Orders-API agregaci obratu odpovídající historické Shoptet definici. Tyto tři věci jsou reálné neznámé, ne formality — ale nemá smysl je řešit dřív, než je jasné, jestli je Price List (bod 1) vůbec v ekonomické úvaze pro tenhle obchod.

Jinými slovy: **u Shopify byl další krok "ověřit tři technické detaily, protože Plus gate z velké části padl a cesta je otevřená"; u BigCommerce je další krok "napřed obchodní rozhodnutí o Enterprise plánu, protože bez něj se technický spike vyplatí jen pro slabší (% sleva) variantu".**
