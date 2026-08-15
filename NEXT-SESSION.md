# Zadání pro novou session — pricing-engine-platform

## Kontext

Platform-independence hypotéza je ověřená: stejný Pricing Core (`src/core`,
`src/policies`, beze změny) funguje na Shoptet (produkčně), Shopify Plus
(živě, 4/4 checkout-verified — `SHOPIFY-SPIKE-2-PLUS-RESULTS.md`) a Medusa
(živě, 5/5 order-verified — `MEDUSA-SPIKE-RESULTS.md`).

Existuje sjednocené rozhraní a dvě produkční implementace:

- `src/adapters/types.ts` — `EcommercePlatformAdapter` rozhraní
- `src/adapters/shopify/index.ts` — produkční, živě ověřený
- `src/adapters/medusa/index.ts` — produkční, živě ověřený
- `src/adapters/shoptet/index.ts` — záměrně jen dokumentační shim
  (každá metoda hodí `NOT_IMPLEMENTED`), nikdy nevolá produkční
  `okfish-pricing-engine` kód
- `docs/DISCOUNT-LOCK-PATTERN.md` — pojmenovaný, ale **neimplementovaný**
  problém

## Jediný zbývající krok před "produkčně hotovo"

Na obou platformách (Shopify, Medusa) platí totéž, potvrzeno živě:
**fixed/override cena ≠ uzamčená cena.** Další slevový mechanismus
(automatic discount, promo kód) může vypočtenou cenu přebít, pokud se to
výslovně neošetří.

### Úkol

1. **Shopify**: implementovat Shopify Function na `discount.function.run`
   targetu, která vyloučí lines s aktivní B2B catalog cenou (PriceList
   scoped na CompanyLocation) z dalšího discountování. `combinesWith` flag
   na discount objektu sám o sobě nestačí (ověřeno živě, viz
   `SHOPIFY-SPIKE-2-PLUS-RESULTS.md` sekce D).

2. **Medusa**: promotion pravidla scoped na `customer.groups.id`, aby se
   nikdy nekryla s tiery, pro které existuje override `PriceList`. Ověřeno
   živě, že bez tohohle promo kód reálně stáhne cenu (800→720,
   `MEDUSA-SPIKE-RESULTS.md` test 5).

3. Testovat živě proti existujícím prostředím (Shopify Plus dev store,
   lokální Medusa + Postgres instance) — stejná disciplína jako předchozí
   spiky: žádné tvrzení "funguje" bez skutečného ověření.

4. Aktualizovat `docs/DISCOUNT-LOCK-PATTERN.md` se stavem implementace.

## Přísná pravidla (nezměněná)

- `okfish-pricing-engine` se nesmí dotknout — ani commit, ani push, ani čtení
  mimo referenci.
- `src/core`/`src/policies` beze změny — core nesmí vědět o platformě.
- Žádná duplikovaná pricing logika v adapterech.
- Nová worktree/agent musí nejdřív `git fetch platform && git checkout
  platform/main` (nebo pracovat přímo v `~/pricing-engine-platform`, což je
  teď plnohodnotný lokální clone, ne dočasná worktree) — historicky se tu
  několikrát stalo, že nový agent omylem začal z `okfish-pricing-engine`
  baseline.

## Mimo scope (neřešit teď)

- BigCommerce/Magento/commercetools adaptery — zůstávají jen jako discovery
  dokumenty, žádný spike (buď finančně gated na straně klienta, nebo
  neověřené naživo — viz `AUDIT-PLATFORM-INDEPENDENCE.md`).
- Shoptet skutečná implementace přes tohle rozhraní — samostatné, vědomé
  rozhodnutí, ne vedlejší efekt téhle práce.
