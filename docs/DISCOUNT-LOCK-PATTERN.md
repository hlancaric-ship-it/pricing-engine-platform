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

**Implementováno (kód + mock/unit testy, viz `tests/shopify-adapter-discount-lock.test.ts`,
`tests/medusa-adapter-discount-lock.test.ts`, 8/8 zelených, celá sada 247/247).
Živě ještě neověřeno** — to vyžaduje Shopify CLI interaktivní OAuth deploy
(`shopify app deploy`) a lokální Medusa+Postgres instanci, obojí mimo dosah
tohoto agenta (žádný přístup k `.env`/store credentials, žádné spuštěné
Medusa prostředí v tomto běhu). Než se tohle prohlásí za "produkčně hotovo",
Jan musí spustit oba live testy popsané níže.

### Shopify — `extensions/discount-lock/`

Shopify Function na `cart.lines.discounts.generate.run` targetu (Discount API
2025-01). Mechanismus:

1. `src/adapters/shopify/index.ts` `writeLockedPrice()` teď dělá dva kroky
   atomicky: `priceListFixedPricesAdd` (jako dřív) + `metafieldsSet` na
   variantě (`pricing_engine.locked = "true"`). Pokud zápis metafieldu selže,
   cena se rollbackne (`priceListFixedPricesDelete`) — napůl zapsaný stav
   (cena bez zámku) je přesně ta nechráněná situace ze
   `SHOPIFY-SPIKE-2-PLUS-RESULTS.md` sekce D, takže se nesmí nechat stát.
2. Function čte `pricing_engine.locked` metafield přes cart line input
   (běží ve Wasm sandboxu bez API přístupu, proto musí ten signál dostat
   v inputu, ne dotazem za běhu) a vyloučí locknuté lines z jakýchkoliv
   kandidátů na slevu. Pokud jsou locknuté všechny lines v košíku, vrátí
   prázdné `operations` (žádná sleva vůbec).
3. Hodnotu slevy (percentage/fixed, order/product class) čte Function
   z vlastního `pricing_engine.discount_config` metafieldu na Discount
   objektu — Function nevymýšlí žádnou cenovou logiku, jen rozhoduje
   eligibilitu, podle pravidla že veškerá aritmetika žije v `src/core`.

**Co zbývá pro živé ověření**: `shopify app generate extension` (nebo ruční
scaffold jako tady) → `shopify app deploy` na existující dev store → vytvořit
discount přes tuto Function → zopakovat test ze SPIKE-2 sekce D (10% automatic
discount na cart s fixed B2B cenou) → potvrdit total zůstává 800.0, ne 720.0.

### Medusa — `createLockedPromotion` / `auditPromotionCollisions`

`src/adapters/medusa/index.ts` přidává dvě metody nad `MedusaAdminClient.admin.promotion`:

1. **`createLockedPromotion(input)`** — vytvoří promotion s `rules` automaticky
   doplněnými o `{ attribute: "customer.groups.id", operator: "ne", values: [...] }`
   pro všechny customer group id tierů, které aktuálně mají aktivní override
   PriceList (zjištěno přes stejnou `findExistingPriceListId` logiku jako
   `writeLockedPrice`). Promotion vytvořená touto metodou strukturálně nemůže
   kolidovat s locknutým tierem.
2. **`auditPromotionCollisions()`** — projde všechny aktivní promotions a
   vlajkuje ty, co nemají `customer.groups.id` `ne`-vyloučení pro locknuté
   tiery (typicky promotions vytvořené mimo tento adapter — admin UI, přímé
   SDK volání, nebo promotion starší než aktivace daného tieru).

**Co zbývá pro živé ověření**: proti lokální Medusa+Postgres instanci
zopakovat test 5 z `MEDUSA-SPIKE-RESULTS.md` (override cena 800, promo kód
na cart) — jednou bez scopingu (potvrdit že to pořád stackuje, baseline),
jednou s promotion vytvořenou přes `createLockedPromotion` (potvrdit že
`unit_price` i `total` zůstanou 800.0 pro zákazníka v locknuté skupině).

### Co NENÍ pokryto
`auditPromotionCollisions` je detekční, ne blokující — nezabrání vzniku
kolidující promotion vytvořené mimo `createLockedPromotion`, jen ji po faktu
najde. Pro plné vynucení by musel existovat webhook/subscriber na
`promotion.created`, který audit spustí automaticky — mimo scope tohohle kroku,
zmíněno jako navazující práce.

## Stage-5 reconciliation (`verifyPrice`) — přenesené z okfish-pricing-engine

Read-only audit `okfish-pricing-engine` repa (produkční Shoptet engine, roky
živého provozu) potvrdil, že core pricing policies (`DiscountLimitPolicy`,
`HighestDiscountPolicy`, `CouponPolicy`, `RoundingPolicy`) jsou v
`pricing-engine-platform` už 1:1 přenesené, byte-identické. Jedna věc ale
chyběla a byla v okfish nejdráž vykoupená lekce: **`INC-010`** — chybná
předpokládaná struktura API response (`json.data.product` místo `json.data`)
způsobila, že incremental pricing pipeline 12 dní tiše no-opovala, každý sync
run hlásil úspěch, a 812 z 16 705 produktů (~4.9 % katalogu) mělo špatnou nebo
chybějící tier cenu — bez jediného erroru nebo failnutého testu.

Poučení: **"API call prošel" a "zákazník vidí správnou cenu" jsou dvě různé
claims** — druhá se dá ověřit jen nezávislým znovu-dotazem na to, co platforma
sama vydává, ne dotazem na výsledek zápisu. `verifyPrice()` v obou adapterech
byla do teď jen stub (`method: "unavailable"`) — teď je implementovaná doopravdy:

- **Shopify**: `ProductVariant.contextualPricing(companyLocationId)` — přesně
  ověřený query shape ze `SHOPIFY-SPIKE-2-PLUS-RESULTS.md` sekce C. Vyžaduje
  novou config položku `companyLocationIdByTier` na `ShopifyAdapterConfig`.
- **Medusa**: postaví efemérní cart přes Store API (`POST /store/carts` →
  přidá line item → přečte `unit_price` → cart smaže), stejný mechanismus
  live-ověřený v `MEDUSA-SPIKE-RESULTS.md` sekce 4 (customer.groups.id
  pricing context se odvozuje automaticky z připojeného zákazníka, bez
  nutnosti manuální context injection). Vyžaduje novou config položku
  `storeApi` (storeUrl, publishableApiKey, regionId,
  `verificationCustomerIdByTier`) na `MedusaAdapterConfig`.

Obě implementace mají 8 nových unit testů proti mockům (fetch), včetně case
"promotion/discount stackla, verifyPrice to musí zachytit jako mismatch"
(720 vs. očekávaných 800 — stejná čísla jako v obou spike testech). **Živě
neověřeno** ze stejného důvodu jako zbytek discount-lock práce — chybí
přístup k `.env`/store credentials v tomto běhu.

## Stage 4/5 vrstva — `writeLockedPricesBatch` / `reconcilePrices`

Read-only audit `INCIDENTS.md` (11 incidentů, 2026-08-03 až 2026-08-13)
odhalil dominantní opakující se vzorec: **"run doběhl zeleně" ≠ "práce se
skutečně udělala"**, pětkrát nezávisle (`INC-006`, `INC-010` třikrát, `INC-011`)
— vždy tichý `catch`/`return` nebo chybný předpoklad o response shape, co se
nikde nezalogoval a nezpůsobil selhání buildu/cronu.

Při hledání téhle třídy bugu ve vlastním kódu (na explicitní požadavek —
"nesmíš nechat žádná zadní vrátka") se našly dvě konkrétní instance:

1. **Shopify `rollbackFixedPrice()`** volalo `priceListFixedPricesDelete`
   a nikdy nekontrolovalo jeho vlastní `userErrors`/`deletedFixedPriceVariantIds`
   — kdyby rollback sám selhal, `writeLockedPrice()` by to hlásilo jako
   `"rolled back"`, i kdyby cena zůstala živá a nezamčená. Opraveno: rollback
   vrací `{succeeded, error}`, a pokud selže i on, `writeLockedPrice()` vrací
   explicitní `"MANUAL INTERVENTION REQUIRED"` chybu, ne zavádějící "rolled back".
2. **Ani Shopify `graphql()`, ani Medusa `storeFetch()`** nekontrolovaly
   HTTP status / top-level GraphQL `errors[]` — 4xx/5xx tělo, co náhodou
   parsuje jako JSON, by se četlo jako úspěšná odpověď (přesně tvar
   `INC-010` bodu 4: `json.data.product` vs. `json.data`, špatný předpoklad
   o shape, nikdy nezkontrolováno, 12 dní ticha). Opraveno v obou — throw na
   `!res.ok` i na `json.errors`.

Nad tím teď existuje generická (platform-agnostic, nezávislá na
`src/core`) Stage 4/5 vrstva:

- **`src/adapters/write-locked-prices-batch.ts`** — `writeLockedPricesBatch()`.
  Vždy `throw`ne (fail-closed), pokud jakýkoliv zápis v dávce selže
  (`BatchWriteFailedError`, se seznamem VŠECH selhání, ne jen prvního), a
  vždy `throw`ne i na prázdnou dávku (`EmptyBatchError`) — dávka, co
  nezpracovala nic, nesmí vypadat jako úspěšný no-op.
- **`src/adapters/reconcile-prices.ts`** — `reconcilePrices()`. Volá
  `verifyPrice()` pro každý záznam, klasifikuje na matches/mismatches/
  unavailable, nikdy nic nezapisuje (striktně read-only, stejná disciplína
  jako okfish `reconcile-*-drift.ts`). **Self-check**: `throw`ne
  `ReconciliationSelfCheckError`, pokud dostal míň záznamů, než volající
  explicitně řekl že očekává (`minExpectedChecks`) — přesně ten samý guard,
  co si okfish musel dostavět dodatečně, když si uvědomili, že "0 alertů"
  může znamenat "nic se nezkontrolovalo", ne "vše sedí".

8 nových unit testů (`tests/write-locked-prices-batch.test.ts`,
`tests/reconcile-prices.test.ts`), celá sada 259/259 zelených, typecheck čistý.

**Živě neověřeno** ze stejného důvodu jako zbytek — bez přístupu k reálné
platformě jde ověřit jen vnitřní konzistence logiky, ne to, že HTTP odpovědi
reálného Shopify/Medusa API mají přesně ten shape, který kód předpokládá.

### Co z okfish auditu NEBYLO přeneseno (vědomě)
- Stage 1–4 validačního modelu (config-load-time konflikty, pre-write
  dry-run diff, CI regresní testy, run-level fail-closed) jsou obecně
  hodnotné, ale netýkají se přímo discount-lock problému — jsou to
  samostatná, širší zlepšení `src/core`/sync pipeline, mimo scope tohohle
  kroku.
- Shoptet-specifické DOM hacky (`vip_cart_coupon_lock.js` overlay,
  `vip_prices.js` decorator) jsou frontend/theme-specifické a nepřenositelné
  1:1 — koncept "frontend jen dekoruje, nikdy nepočítá slevu znovu" je ale
  dobrá připomínka pro případný Shopify/Medusa storefront kód, kdyby vznikl.

## Shopify Function — živě ověřeno end-to-end (2026-08-15)

Celý discount-lock pattern pro Shopify je teď **skutečně nasazený a ověřený
naživo**, ne jen napsaný a otestovaný proti mockům:

1. **`writeLockedPrice`** — zapsal fixed cenu (800 CZK) a `pricing_engine.locked`
   metafield v jedné operaci na reálný Shopify Plus B2B store
   (`l-code-laboratory-tarif-plus.myshopify.com`, SPIKE-A-PLUS varianta).
   `written=true`.
2. **`verifyPrice`** — nezávisle přes `contextualPricing` potvrdil `matchesExpected=true`.
3. **`extensions/discount-lock`** Function — zkompilována a nasazena přes
   `shopify app deploy`. Reálná cesta ke kompilaci se lišila od původního
   plánu — viz "Poznámky k Function toolchainu" níže.
4. **Discount-collision test (SPIKE-2 sekce D repro)** — vytvořen automatický
   10% discount používající tuhle Function (`discountAutomaticAppCreate`,
   `pricing_engine.discount_config` metafield = `{"type":"percentage","value":"10.0"}`),
   aplikován na cart s SPIKE-A-PLUS, **dokončena skutečná objednávka**:
   **Total = 800.00 CZK, ne 720 CZK.** Function úspěšně vyloučila locknutou
   line z automatického discountu.

### Poznámky k Function toolchainu (pro příště)

- `@shopify/shopify_function` musí být `^2.0.1` (`^1.1.0` neexistuje).
- Manuální `javy build` (i s `-C dynamic=y` a vlastním `emit-plugin`) narazil
  na verzní nesoulad s Shopify serverem (`javy-default-plugin-v4` ABI
  mismatch) — Shopify CLI si přesnou verzi toolchainu řídí interně.
  **Správná cesta:** `shopify app generate extension --template discount`
  (oficiální šablona), do ní přenést business logiku, a nechat build script
  být `npm exec -- shopify app function build` (deleguje zpátky na CLI).
- Function ID z `{ shopifyFunctions { nodes { id } } }` query je **UUID
  formát** (ne standardní číselné Shopify ID) — použít **syrové**, ne
  obalené do `gid://shopify/Function/...`. Obalení způsobovalo "Function
  not found" i když ID bylo jinak správně.
- `shopify.app.toml` s `embedded = true` a placeholder `application_url`
  dělá embedded admin UI appky nepoužitelné (jen "Example Domain") —
  discount se dá i tak vytvořit přímo přes `discountAutomaticAppCreate`
  GraphQL mutaci, UI appky k tomu není potřeba.
- Testovací skripty: `spikes/shopify-adapter-spike/live-test-discount-lock.ts`
  (write+verify), `spikes/shopify-adapter-spike/setup-discount-e2e.ts`
  (OAuth code → token → najít Function → vytvořit discount).
