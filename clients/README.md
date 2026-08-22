# Klientský intake proces

Jedna složka na klienta, jedna standardní struktura — od prvního kontaktu
až po hotovou konfiguraci. Kopíruj `_template/` jako `clients/<jméno-klienta>/`.

## Struktura

```
clients/<klient>/
  01-pozadavky/     ← co klient chce (e-maily, poznámky ze schůzky, jeho
                       popis věrnostního systému, značkových/kategoriových
                       stropů, výprodejové logiky atd.)
  02-exporty/
    zakaznici/      ← aktuální export zákazníků z klientovy platformy
                       (CSV/XLSX) — vidíme skutečné skupiny/tiery, co už
                       reálně existují, ne jen co si klient myslí, že má
    produkty/       ← aktuální export produktů/ceníků — vidíme skutečnou
                       stavbu cen, značky, kategorie, aktuální slevy
  03-analyza/       ← naše zjištění: odvozená tier struktura, návrh
                       policy-v1.json, co v exportech sedí/nesedí s tím,
                       co klient v 01-pozadavky říká
```

## ⚠️ Bezpečnost dat — přísně dodržovat

**Nic z `02-exporty/` (ani `01-pozadavky/`, pokud obsahuje reálná
zákaznická data) se nesmí dostat do gitu.** Viz `.gitignore` v tomhle
adresáři — `clients/*/02-exporty/` a `clients/*/01-pozadavky/` jsou
ignorované, commituje se jen `_template/` (prázdná struktura) a
`03-analyza/` (naše odvozené závěry, ne surová data), a i tam zvážit,
jestli analýza neobsahuje něco citlivého (reálná jména, e-maily) předtím,
než se commitne.

## Proč tahle struktura

- **Nevěříme jen tomu, co klient řekne, že má za pravidla** — reálný export
  zákazníků/produktů ukáže skutečnou stavbu ceníků a skupin, což se často
  liší od toho, jak si to klient pamatuje nebo popisuje.
- **Jedno místo pro celý onboarding** — než se začne psát jediný řádek
  konfigurace, je jasné, co klient chce (01) vs. co skutečně má (02) vs.
  co jsme z toho odvodili (03).
- Odpovídá stejné disciplíně jako zbytek repa (žádné tvrzení "funguje" bez
  ověření proti reálným datům) — tady totéž, jen na začátku procesu místo
  na konci.
