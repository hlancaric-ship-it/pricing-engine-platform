# Ochrana osobních údajů (GDPR)

Jak Pricing Engine (a L-Code Dynamics jako dodavatel) zpracovává osobní údaje.

## Minimalizace dat

Do cenové/kupónové vrstvy se ukládá jen to, co je nezbytné pro výpočet ceny
podle věrnostní úrovně — typicky hash e-mailu a přidělený tier, ne jméno,
adresa ani historie objednávek. Zdrojem pravdy zůstává vždy platforma
klienta (Shoptet/Shopify/Medusa), engine ji jen zrcadlí pro rychlý výpočet.

## Zpracovatel, ne správce

L-Code Dynamics vystupuje jako zpracovatel osobních údajů dle čl. 28 GDPR —
klient (provozovatel e-shopu) zůstává správcem a určuje účel i rozsah
zpracování. Zpracovatelská smlouva (DPA) je součástí každého nasazení.

## Šifrování a přístup

Přenos výhradně přes HTTPS, přístup k API tokenům a produkčním datům
omezen na nutné minimum osob, žádné citlivé údaje v logách ani v otevřeném
incident logu.

## Doba uchování a výmaz

Data v cenové vrstvě se přepisují při každé synchronizaci s platformou
klienta — smazání/anonymizace zákazníka na straně platformy se promítne
i sem v rámci nejbližšího synchronizačního cyklu. Na vyžádání provedeme
výmaz i mimo běžný cyklus.

## Platformové rozdíly

- **Shoptet**: hash e-mailu + tier v Cloudflare KV (Worker).
- **Shopify**: `PriceList`/`Catalog` scoped na `CompanyLocation` — data žijí
  přímo v Shopify, engine je jen zapisuje/čte přes API.
- **Medusa**: `PriceList` typu `override` + `customer.groups.id` — data
  žijí v klientově vlastní (self-hosted) instanci, engine tam nic
  neukládá mimo klientovu databázi.

---

Kontakt k GDPR dotazům: ceo@l-code-dynamics.com
