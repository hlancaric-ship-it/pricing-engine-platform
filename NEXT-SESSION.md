# Stav pricing-engine-platform (aktualizováno 2026-08-22)

## Hotovo

Platform-independence hypotéza ověřená: stejný Pricing Core (`src/core`,
`src/policies`, beze změny) funguje na Shoptet (produkčně), Shopify Plus
(živě, 4/4 checkout-verified — `SHOPIFY-SPIKE-2-PLUS-RESULTS.md`) a Medusa
(živě, 5/5 order-verified — `MEDUSA-SPIKE-RESULTS.md`).

**Discount-lock pattern — hotovo pro obě live-ověřené platformy:**
- Shopify: `extensions/discount-lock/` — Shopify Function na
  `cart_lines_discounts_generate_run`, zkompilovaný `function.wasm`,
  fixture testy proti kompilovanému wasm.
- Medusa: `src/adapters/medusa/index.ts` — promotion pravidla scoped na
  `customer.groups.id` (`createLockedPromotion`), plus
  `auditPromotionCollisions()` pro detekci promocí vytvořených mimo tenhle
  adapter. 12 testů v `tests/medusa-adapter-discount-lock.test.ts`.
- `docs/DISCOUNT-LOCK-PATTERN.md` odráží implementovaný stav.

**Stage 4/5 (fail-closed + reconciliation)**, portováno konceptuálně z
okfish incident logu (INC-006/010/011), bez kopírování okfish kódu:
`src/adapters/write-locked-prices-batch.ts`,
`src/adapters/reconcile-prices.ts`.

**Ověřeno 2026-08-22:** build (`npm run build`, `tsc`) čistý, testy zelené
napříč oběma balíčky — root 326/326, `cloudflare-worker/` 97/97. Git strom
čistý, nic necommitnutého.

## Klientský analyzer — HOTOVO (2026-08-22)

`scripts/analyze-client-exports.ts` -- funguje přesně podle plánu níže.
Použití: `npx tsx scripts/analyze-client-exports.ts --client <jméno>` (čte
`clients/<jméno>/02-exporty/{zakaznici,produkty}/*.csv`, najde první CSV v
každé složce) nebo `--customers <path> --products <path> --out <dir>`
přímo. Vlastní loosely-typed CSV parser (auto-detekce delimiteru
`;`/`,`/tab), heuristika na název sloupce (skupina/tier/pricelist/atd.) s
fallbackem na "malá množina distinct krátkých hodnot, ne skoro-unikátní".

**Otestováno proti syntetickým datům** (ne reálným klientským, viz
`clients/README.md`) -- sloupcová detekce, fallback heuristika i
brandLimits "konzistentní vzor" logika (≥50 % pokrytí značky, odchylka
≤3 p.b., ≥3 produkty) fungují podle očekávání. `tsc --noEmit` i `eslint`
čisté, celá test suite (651/651, mimo 1 pre-existující selhání souvisejícího
s chybějícím zkompilovaným wasm fixture pro discount-lock -- nesouvisí s
tímhle skriptem, stejné na `main` i tady) prochází beze změny.

**Vědomě nedodělané / rohové případy pro příště:**
- % slevy per tier **nejde odvodit** ze zákaznického exportu (neobsahuje
  ceny) -- draft JSON nechává `loyaltyTiers_DRAFT_percentChybi` jako
  `null` per skupina, člověk musí doplnit ručně.
- XLSX se nečte přímo (v repu není xlsx knihovna) -- obsluha/klient musí
  export uložit jako CSV, stejná konvence jako jinde (např. dodavatelské
  ceníky v brani-cistytriko).
- Fallback heuristika na tier sloupec (bez shody v názvu) je čistě
  statistická -- na exportu s divnou strukturou může minout nebo najít
  špatný sloupec; vždycky se to promítne do reportu, kde jde ověřit, jestli
  detekovaný sloupec dává smysl.

Původní plán (pro referenci):
- Zákaznický export → najít sloupec skupina/tier/pricelist (heuristika na
  název sloupce + na to, že hodnoty vypadají jako malá množina opakujících
  se řetězců), spočítat distinct hodnoty + počty → návrh `loyaltyTiers`.
- Produktový export → najít sloupec značka/manufacturer + cena/sleva →
  spočítat průměrnou/nejčastější slevu per značka → návrh `brandLimits`
  kandidátů (jen značky s konzistentním vzorem slevy napříč produkty, ne
  šum).
- Výstup: markdown report (co našel, s čísly) + draft JSON do
  `clients/<klient>/03-analyza/`, výslovně označený "NÁVRH — zkontroluj
  před nasazením", nikdy auto-aplikovaný do `src/config/policies/`.
- `src/csv/reader.ts` je pro `PricingInput` (produktový feed formát), ne
  pro syrové klientské exporty — ty mají jiné/neznámé sloupce dopředu,
  potřebuje se vlastní loosely-typed parser s heuristikou na názvy sloupců.
- Testovat proti `_template/` s libovolnými syntetickými/mock daty (ne
  reálnými klientskými daty, ta se necommitují — viz `clients/README.md`).

## Otevřené body

1. **Sjednocené `EcommercePlatformAdapter` rozhraní** existuje
   (`src/adapters/types.ts`), ale Shopify a Medusa adaptery vznikly jako
   dva samostatné spiky před sjednocením — stojí za kontrolu, jestli oba
   plně implementují stejné rozhraní 1:1, ne jen strukturně podobně.
2. **Core logika (`DiscountLimitPolicy.ts`)** má fix, co existuje jen tady,
   ne v `okfish-pricing-engine` — vědomé rozhodnutí (Jan: "nejdřív u sebe,
   pak až v okfish"). Port zpátky do okfish je samostatný, vědomý krok,
   ne vedlejší efekt práce v tomhle repu.
3. BigCommerce/Magento/commercetools zůstávají jen jako discovery
   dokumenty (`*-DISCOVERY.md`) — finančně gated na straně klienta nebo
   neověřené naživo, viz `AUDIT-PLATFORM-INDEPENDENCE.md`.
4. Shoptet adapter (`src/adapters/shoptet/index.ts`) zůstává záměrně jen
   dokumentační shim (`NOT_IMPLEMENTED`) — nevolá produkční okfish kód.

## Přísná pravidla (nezměněná)

- `okfish-pricing-engine` se nesmí dotknout — ani commit, ani push, ani
  čtení mimo referenci.
- `src/core`/`src/policies` beze změny — core nesmí vědět o platformě.
- Žádná duplikovaná pricing logika v adapterech.
- Nová worktree/agent musí nejdřív `git fetch platform && git checkout
  platform/main` (nebo pracovat přímo v `~/pricing-engine-platform`, což je
  plnohodnotný lokální clone, ne dočasná worktree).
