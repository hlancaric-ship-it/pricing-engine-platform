# Audit: platform-independent Pricing Core — je engine připravený jako produkt?

Datum: 2026-08-15
Zdroj: `SHOPIFY-DISCOVERY.md`, `SHOPIFY-SPIKE-1-RESULTS.md`, `SHOPIFY-SPIKE-2-PLUS-RESULTS.md`, `BIGCOMMERCE-DISCOVERY.md`, `MEDUSA-DISCOVERY.md`, `MEDUSA-SPIKE-RESULTS.md`, `MAGENTO-DISCOVERY.md`, `COMMERCETOOLS-DISCOVERY.md`.
Baseline: `okfish-pricing-engine` (Shoptet, produkčně nasazený pro okfish.sk) — nedotčen po celou dobu experimentu.

---

## Otázka 1: Dokážeme naroubovat engine beze změny core na jakýkoliv další e-shop?

**Odpověď: ANO, na úrovni core kódu — potvrzeno nezávisle 5×. NE bezpodmínečně na úrovni "funguje to hned a stejně dobře všude" — platí to s různou mírou obchodní/technické překážky podle platformy.**

`PricingInput`/`PricingResult`/`PricingEngine`/`determineTier()`/policies (`src/core`) prošly beze změny přes:

| Platforma | Jak ověřeno | Core nedotčen |
|---|---|---|
| Shoptet | produkčně, roky | ano |
| Shopify | 2× živý spike (Basic i Plus), reálný checkout | ano |
| BigCommerce | dokumentační discovery | ano (nepotřeba měnit) |
| Medusa | živý spike, self-hosted instance, reálná objednávka | ano |
| Magento/Adobe Commerce | dokumentační discovery | ano (nepotřeba měnit) |
| commercetools | dokumentační discovery | ano (nepotřeba měnit) |

To je šestinásobné nezávislé potvrzení základní hypotézy: **core neví a nemusí vědět, na jaké platformě běží.** Tohle je vyřešené — dál to netřeba dokazovat.

Co ale **není** vyřešené stejnoměrně, je otázka, jestli se cena z core na dané platformě dá **doručit zákazníkovi jako uzamčená, deterministická finální hodnota** — a tady se platformy zásadně liší:

| Platforma | Mechanismus pro absolutní per-tier cenu | Gate | Ověřeno živě? | Discount stacking riziko |
|---|---|---|---|---|
| Shoptet | pricelist (`TIER_PRICELIST_MAP`) | žádný, vlastní infrastruktura | ano, produkčně | řízeno vlastním kódem |
| Shopify | `PriceList` + `Catalog` na `CompanyLocation` | Basic: katalog nejde aktivovat (ověřeno živě, blokující). Plus: funguje bez omezení | **ano, 4/4 na Plus** | ano — `combinesWith` cenu neuzamkne, nutná Shopify Function |
| BigCommerce | `Price List` | Enterprise-only, žádná kompromisní cesta | ne | nezdokumentováno s jistotou |
| Medusa | `PriceList` typu `override` | žádný (MIT open-source), jen operační náklad self-hostingu | **ano, 5/5, reálná objednávka** | ano — promo kód reálně stáhl 800→720 |
| Magento OSS/Adobe Commerce | Shared Catalog (čistý) vs. Tier Price qty=1 (fallback) | Shared Catalog = Commerce+B2B licence $32k–190k+/rok. Tier Price je zdarma, ale sémanticky hrubší | ne, jen dokumentace | dokumentačně přiznané riziko i s "Stop Further Rules" |
| commercetools | `Price.customerGroup` (nativní pole) | nejasné, sales-led kontrakt $40k–300k+/rok | ne | ano, stejné riziko jako Shopify/Medusa, jen "Best Deal" mode jako slabá pojistka |

**Klíčové zjištění napříč všemi platformami, které se opakuje bez výjimky:** *fixed/override cena ≠ uzamčená cena.* Všude, kde jsme to ověřili živě (Shopify, Medusa) i tam, kde to zůstalo jen v dokumentaci (Magento, commercetools), platí, že další slevový mechanismus (coupon, promotion, cart discount) může naši vypočtenou cenu přebít, pokud se to explicitně neošetří na platformní vrstvě. To není chyba core — je to standardní vlastnost všech těchto platforem, se kterou musí počítat každý adapter.

---

## Otázka 2: Můžeme z toho začít stavět produkt?

**Odpověď: Ano, ale ne jako "jeden univerzální adapter pro všechno" — jako produkt s jasně odstupňovanou platformní podporou.**

### Co je hotové a stabilní už teď
- **Core samotný je produkčně vyzrálý a prokazatelně přenositelný.** Tohle je ta těžká část a je hotová. Zbytek je integrační práce, ne výzkum.
- **Vzor adapteru je opakovaně stejný a levný na replikaci**: normalizace platformních dat → `PricingInput`, `PricingResult` → zápis do platformního "fixed price" mechanismu. U Shopify i Medusy to zabralo řádově hodiny agentní práce, ne týdny.
- **Máme funkční, dvakrát nezávisle ověřený referenční adapter** (Shopify Plus, Medusa) jako šablonu pro každý další.

### Kde je reálné obchodní rozhodování, ne technický problém
Pořadí platforem podle toho, jak snadno se dá tenhle produkt na ně dnes prodat:

1. **Shoptet** — hotovo, v produkci.
2. **Medusa** — technicky nejčistší, žádný gate, ale je to self-hosted → prodáváš to jako implementaci/službu klientovi, který musí mít vlastní backend. Nejlepší pro klienty, co chtějí plnou kontrolu a mají/chtějí vlastní infrastrukturu.
3. **Shopify** — funguje, ale jen na Plus (~$2300+/měsíc pro klienta). Pro klienty na Basic/Grow to zatím nemá čistou cestu (potvrzeno živě, ne teoreticky) — buď je přesvědčíš na upgrade, nebo pro ně nabídneš slabší % slevovou variantu.
4. **BigCommerce, Magento (Shared Catalog), commercetools** — technicky pravděpodobně proveditelné, ale buď s tvrdým finančním gatem na straně klienta (Magento Commerce+B2B, commercetools kontrakt), nebo neověřené live (BigCommerce). Nedávalo by smysl stavět produkt kolem těchto platforem, dokud nemáš konkrétního klienta, který na nich už je a je ochotný platit za vyšší tier.

### Co chybí, než se to dá nazvat "produkt" a ne "sada úspěšných experimentů"
1. **Sjednocené `EcommercePlatformAdapter` rozhraní** — zatím máme dva samostatné, strukturně podobné, ale formálně neuniformní adaptery (`spikes/shopify-adapter-spike/`, `spikes/medusa-adapter-spike/`). Produkt potřebuje jedno rozhraní, ne dva paralelní spiky.
2. **Řešení discount-collision jako standardní součást adapteru, ne poznámka.** U Shopify to znamená Shopify Function, u Medusy scoped promotion pravidla. Tohle je jediná opakující se technická mezera napříč platformami a měla by se vyřešit jednou jako vzor, ne ad-hoc pro každého klienta znovu.
3. **Rozhodnutí, které platformy produkt oficiálně podporuje na startu.** Doporučuji: Shoptet (hotovo) + Shopify Plus + Medusa jako první tři podporované platformy — to jsou ty, co mají ověřený, ne jen predikovaný, funkční řetězec až do objednávky.
4. **Mapování na tvých 5 konkrétních e-shopů/subjektů** — tohle nemám, potřebuju vědět, na jaké platformě každý z nich běží, abych ti řekl přesně, který je "hned proveditelný", který "vyžaduje upgrade tarifu" a který "zatím nedává obchodní smysl řešit".

---

## Doporučení, další krok

Než se pustíme do stavby produktu (sjednocené rozhraní, discount-lock vzor), potřebuju od tebe jednu věc: **na jaké platformě běží každý z tvých 5 subjektů?** Bez toho je zbytek téhle analýzy teoretický — s tím z ní udělám konkrétní realizační plán (kdo je "hned", kdo "po upgradu", kdo "čeká na commercetools trial").
