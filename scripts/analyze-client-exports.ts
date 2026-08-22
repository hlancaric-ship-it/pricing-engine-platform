/**
 * Analyzuje syrové klientské exporty (zákazníci + produkty/ceník) a navrhne
 * draft policy-v1.json. NIKDY nic sám nenasazuje -- jen markdown report +
 * draft JSON do clients/<klient>/03-analyza/, k lidské kontrole. Viz
 * clients/README.md pro adresářovou konvenci a NEXT-SESSION.md pro zadání.
 *
 * Použití:
 *   tsx scripts/analyze-client-exports.ts --client <jméno>
 *   tsx scripts/analyze-client-exports.ts --customers <path> --products <path> --out <dir>
 *
 * Formát exportů dopředu neznáme (každý klient má jiné sloupce) -- proto
 * vlastní loosely-typed CSV parser s heuristikou na názvy sloupců, ne
 * src/csv/reader.ts (ten je pevně navázaný na PricingInput/produktový feed
 * formát, který klientské exporty nemají).
 *
 * XLSX se nečte přímo (v repu není xlsx knihovna) -- klient/obsluha ho musí
 * nejdřív uložit jako CSV (stejná konvence jako jinde v ekosystému, např.
 * dodavatelské ceníky v brani-cistytriko).
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

interface Args {
    client?: string;
    customersPath?: string;
    productsPath?: string;
    outDir?: string;
}

function parseArgs(argv: string[]): Args {
    const args: Args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--client') args.client = argv[++i];
        else if (a === '--customers') args.customersPath = argv[++i];
        else if (a === '--products') args.productsPath = argv[++i];
        else if (a === '--out') args.outDir = argv[++i];
    }
    return args;
}

function detectDelimiter(sampleLine: string): string {
    const counts: Record<string, number> = {
        ';': (sampleLine.match(/;/g) || []).length,
        ',': (sampleLine.match(/,/g) || []).length,
        '\t': (sampleLine.match(/\t/g) || []).length
    };
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function readCsvGeneric(filePath: string): Record<string, string>[] {
    const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    const firstLine = raw.split(/\r?\n/, 1)[0] || '';
    const delimiter = detectDelimiter(firstLine);
    return parse(raw, { delimiter, columns: true, trim: true, skip_empty_lines: true, relax_column_count: true });
}

function findColumn(headers: string[], patterns: RegExp[]): string | undefined {
    for (const pattern of patterns) {
        const match = headers.find((h) => pattern.test(h));
        if (match) return match;
    }
    return undefined;
}

function parseNumber(val: string | undefined): number | undefined {
    if (!val) return undefined;
    const n = parseFloat(val.replace(',', '.').replace(/\s/g, ''));
    return isNaN(n) ? undefined : n;
}

// --- zákaznický export: skupina/tier/pricelist ---

interface TierCandidate {
    value: string;
    count: number;
}

interface CustomerAnalysis {
    column?: string;
    tiers: TierCandidate[];
    totalRows: number;
}

function analyzeCustomers(rows: Record<string, string>[]): CustomerAnalysis {
    if (!rows.length) return { tiers: [], totalRows: 0 };
    const headers = Object.keys(rows[0]);

    let column = findColumn(headers, [/(skupina|group|tier|pricelist|cen[íi]k|level|v[eě]rnost|loyalty)/i]);

    if (!column) {
        // Fallback: sloupec s malým počtem distinct krátkých hodnot (vypadá
        // jako kód/tier), který ale není skoro-unikátní (to by bylo id/email).
        let best: { header: string; distinct: number } | undefined;
        for (const h of headers) {
            const values = rows.map((r) => (r[h] || '').trim()).filter(Boolean);
            if (!values.length) continue;
            const distinct = new Set(values).size;
            const avgLen = values.reduce((s, v) => s + v.length, 0) / values.length;
            if (distinct >= 2 && distinct <= 20 && distinct <= values.length * 0.5 && avgLen <= 20) {
                if (!best || distinct < best.distinct) best = { header: h, distinct };
            }
        }
        column = best?.header;
    }

    if (!column) return { tiers: [], totalRows: rows.length };

    const counts = new Map<string, number>();
    for (const row of rows) {
        const val = (row[column] || '').trim();
        if (!val) continue;
        counts.set(val, (counts.get(val) || 0) + 1);
    }

    const tiers = Array.from(counts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count);

    return { column, tiers, totalRows: rows.length };
}

// --- produktový export: brandLimits kandidáti ---

interface BrandCandidate {
    brand: string;
    productCount: number;
    productsWithDiscount: number;
    coveragePct: number;
    avgDiscountPct: number;
    stddevDiscountPct: number;
    consistent: boolean;
}

interface ProductAnalysis {
    brandColumn?: string;
    priceColumn?: string;
    actionColumn?: string;
    candidates: BrandCandidate[];
    totalRows: number;
}

function analyzeProducts(rows: Record<string, string>[]): ProductAnalysis {
    if (!rows.length) return { candidates: [], totalRows: 0 };
    const headers = Object.keys(rows[0]);

    const brandColumn = findColumn(headers, [/(manufacturer|brand|zna[čc]ka|v[ýy]robce)/i]);
    const priceColumn = findColumn(headers, [/^(standardprice|price|cena)$/i, /(standardprice|cena)/i]);
    const actionColumn = findColumn(headers, [
        /^(actionprice|saleprice)$/i,
        /(action|sale|ak[čc]n[íi]|slev).*(price|cena)/i,
        /(price|cena).*(action|sale|ak[čc]n[íi]|slev)/i
    ]);

    if (!brandColumn || !priceColumn) {
        return { brandColumn, priceColumn, actionColumn, candidates: [], totalRows: rows.length };
    }

    const byBrand = new Map<string, { total: number; withDiscount: number; discounts: number[] }>();

    for (const row of rows) {
        const brand = (row[brandColumn] || '').trim();
        if (!brand) continue;
        const basePrice = parseNumber(row[priceColumn]);
        if (basePrice === undefined || basePrice <= 0) continue;

        if (!byBrand.has(brand)) byBrand.set(brand, { total: 0, withDiscount: 0, discounts: [] });
        const entry = byBrand.get(brand)!;
        entry.total++;

        const actionPrice = actionColumn ? parseNumber(row[actionColumn]) : undefined;
        if (actionPrice !== undefined && actionPrice > 0 && actionPrice < basePrice) {
            entry.withDiscount++;
            entry.discounts.push((1 - actionPrice / basePrice) * 100);
        }
    }

    const candidates: BrandCandidate[] = [];
    for (const [brand, entry] of byBrand) {
        if (entry.discounts.length === 0) continue;
        const coveragePct = (entry.withDiscount / entry.total) * 100;
        const avg = entry.discounts.reduce((s, v) => s + v, 0) / entry.discounts.length;
        const variance = entry.discounts.reduce((s, v) => s + (v - avg) ** 2, 0) / entry.discounts.length;
        const stddev = Math.sqrt(variance);
        // "Konzistentní vzor" = sleva pokrývá aspoň polovinu katalogu značky
        // s odchylkou do 3 procentních bodů -- kandidát na záměrný strop, ne
        // jen pár náhodných výprodejových kusů.
        const consistent = coveragePct >= 50 && stddev <= 3 && entry.total >= 3;
        candidates.push({
            brand,
            productCount: entry.total,
            productsWithDiscount: entry.withDiscount,
            coveragePct: Math.round(coveragePct * 10) / 10,
            avgDiscountPct: Math.round(avg * 10) / 10,
            stddevDiscountPct: Math.round(stddev * 10) / 10,
            consistent
        });
    }

    candidates.sort((a, b) => b.productCount - a.productCount);
    return { brandColumn, priceColumn, actionColumn, candidates, totalRows: rows.length };
}

// --- výstup ---

function buildMarkdownReport(clientName: string, customerResult: CustomerAnalysis, productResult: ProductAnalysis): string {
    const lines: string[] = [];
    lines.push(`# Analýza klientských exportů — ${clientName}`);
    lines.push('');
    lines.push(`Vygenerováno: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('**Tohle je NÁVRH k lidské kontrole, ne hotová konfigurace. Nic z tohohle se**');
    lines.push('**automaticky nenasazuje do `src/config/policies/`.**');
    lines.push('');

    lines.push('## Zákaznický export — skupiny/tiery');
    lines.push('');
    if (!customerResult.column) {
        lines.push('Nenašel jsem sloupec, co by vypadal jako skupina/tier/pricelist. Zkontroluj');
        lines.push('hlavičku exportu ručně, případně zadej sloupec explicitně.');
    } else {
        lines.push(`Použitý sloupec: \`${customerResult.column}\` (z ${customerResult.totalRows} řádků zákazníků)`);
        lines.push('');
        lines.push('| Hodnota | Počet zákazníků | Podíl |');
        lines.push('|---|---|---|');
        for (const t of customerResult.tiers) {
            const pct = ((t.count / customerResult.totalRows) * 100).toFixed(1);
            lines.push(`| ${t.value} | ${t.count} | ${pct}% |`);
        }
        lines.push('');
        lines.push('**% slevy pro každou skupinu není v exportu zákazníků obsažené -- to musí**');
        lines.push('**doplnit člověk** (z 01-pozadavky, nebo dotazem na klienta).');
    }
    lines.push('');

    lines.push('## Produktový export — kandidáti na brandLimits');
    lines.push('');
    if (!productResult.brandColumn || !productResult.priceColumn) {
        lines.push('Nenašel jsem sloupec značky a/nebo základní ceny v produktovém exportu.');
        lines.push(`Značka: \`${productResult.brandColumn ?? 'nenalezeno'}\`, cena: \`${productResult.priceColumn ?? 'nenalezeno'}\`.`);
    } else if (!productResult.actionColumn) {
        lines.push(`Sloupec akční/výprodejové ceny se nenašel (značka: \`${productResult.brandColumn}\`,`);
        lines.push(`cena: \`${productResult.priceColumn}\`) -- bez něj nejde odvodit hloubku slevy per značka.`);
    } else {
        lines.push(
            `Sloupce: značka=\`${productResult.brandColumn}\`, cena=\`${productResult.priceColumn}\`, ` +
                `akční cena=\`${productResult.actionColumn}\` (z ${productResult.totalRows} produktů)`
        );
        lines.push('');
        lines.push('| Značka | Produktů | S akční cenou | Pokrytí | Průměrná sleva | Odchylka | Konzistentní vzor? |');
        lines.push('|---|---|---|---|---|---|---|');
        for (const c of productResult.candidates) {
            lines.push(
                `| ${c.brand} | ${c.productCount} | ${c.productsWithDiscount} | ${c.coveragePct}% | ` +
                    `${c.avgDiscountPct}% | ±${c.stddevDiscountPct}% | ${c.consistent ? '✅ ano' : '— ne'} |`
            );
        }
        lines.push('');
        lines.push('"Konzistentní vzor" = sleva pokrývá aspoň 50 % produktů značky s odchylkou');
        lines.push('do 3 procentních bodů a značka má aspoň 3 produkty v exportu -- kandidát na');
        lines.push('skutečný, záměrný strop, ne jen náhodný výprodej pár kusů. **I tak zkontroluj**');
        lines.push('**ručně** -- statistika nepozná záměr klienta.');
    }
    lines.push('');

    return lines.join('\n');
}

function buildDraftPolicy(customerResult: CustomerAnalysis, productResult: ProductAnalysis): object {
    const loyaltyTiersDraft: Record<string, null> = {};
    for (const t of customerResult.tiers) {
        loyaltyTiersDraft[t.value] = null; // % musí doplnit člověk, export ho neobsahuje
    }

    const brandLimitsDraft: Record<string, number> = {};
    for (const c of productResult.candidates) {
        if (c.consistent) {
            brandLimitsDraft[c.brand] = Math.round(c.avgDiscountPct) / 100;
        }
    }

    return {
        version: 'DRAFT -- zkontroluj před nasazením, nekopírovat rovnou do src/config/policies/',
        generatedAt: new Date().toISOString(),
        loyaltyTiers_DRAFT_percentChybi: loyaltyTiersDraft,
        brandLimits_DRAFT: brandLimitsDraft,
        categoryLimits: {},
        brandSaleDiscounts: {},
        _note:
            'loyaltyTiers % nejde odvodit ze zákaznického exportu (neobsahuje ceny) -- ' +
            'doplň ručně. brandLimits jsou jen konzistentní vzory nalezené v datech, ' +
            'ověř záměr s klientem před nasazením.'
    };
}

function findFirstCsv(dir: string): string | undefined {
    if (!fs.existsSync(dir)) return undefined;
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv'));
    if (!files.length) return undefined;
    return path.join(dir, files[0]);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    let customersPath = args.customersPath;
    let productsPath = args.productsPath;
    let outDir = args.outDir;
    const clientName = args.client ?? 'unknown';

    if (args.client) {
        const base = path.join('clients', args.client);
        customersPath = customersPath ?? findFirstCsv(path.join(base, '02-exporty', 'zakaznici'));
        productsPath = productsPath ?? findFirstCsv(path.join(base, '02-exporty', 'produkty'));
        outDir = outDir ?? path.join(base, '03-analyza');
    }

    if (!customersPath && !productsPath) {
        console.error('Použití: tsx scripts/analyze-client-exports.ts --client <jméno> [--customers <path>] [--products <path>] [--out <dir>]');
        console.error('Nebo zadej --customers/--products přímo.');
        process.exit(1);
    }

    outDir = outDir ?? 'clients/_template/03-analyza';
    fs.mkdirSync(outDir, { recursive: true });

    if (customersPath && !fs.existsSync(customersPath)) {
        console.warn(`Zákaznický export nenalezen: ${customersPath}`);
        customersPath = undefined;
    }
    if (productsPath && !fs.existsSync(productsPath)) {
        console.warn(`Produktový export nenalezen: ${productsPath}`);
        productsPath = undefined;
    }

    const customerResult = customersPath ? analyzeCustomers(readCsvGeneric(customersPath)) : { tiers: [], totalRows: 0 };
    const productResult = productsPath ? analyzeProducts(readCsvGeneric(productsPath)) : { candidates: [], totalRows: 0 };

    const report = buildMarkdownReport(clientName, customerResult, productResult);
    const draft = buildDraftPolicy(customerResult, productResult);

    const reportPath = path.join(outDir, 'analyza-report.md');
    const draftPath = path.join(outDir, 'policy-v1.draft.json');

    fs.writeFileSync(reportPath, report, 'utf-8');
    fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2), 'utf-8');

    console.log(`Report:     ${reportPath}`);
    console.log(`Draft JSON: ${draftPath}`);
    console.log('');
    console.log('NÁVRH k lidské kontrole -- nic z tohohle není automaticky nasazené.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
