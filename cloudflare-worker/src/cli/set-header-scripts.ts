// Automates the last manual step of client onboarding -- instead of the client
// pasting <script src="..."> tags into Shoptet's header snippet by hand, this writes
// them directly via the Shoptet API (POST /template-include, location
// "common-header"). One CLI run = the client's whole storefront is wired up, zero
// manual editing.
//
// Uses the addon's own isolated snippet layer (Shoptet: "it does not see the code
// inserted within the administration" -- separate from what a human manually typed
// in the admin, and separate from other addons). Safe to call repeatedly: it always
// REPLACES this addon's own snippet wholesale, so re-running after adding/removing a
// script from STATIC_JS_FILES just updates it, no manual cleanup needed.
//
// Usage:
//   npx tsx src/cli/set-header-scripts.ts                 (dry run, prints the HTML)
//   npx tsx src/cli/set-header-scripts.ts --live            (live write)
//   npx tsx src/cli/set-header-scripts.ts --worker-url=https://<worker>  (override)
import * as fs from 'fs';
import * as path from 'path';
import { ShoptetApiClient } from '../shoptet-api/client';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

const isLive = process.argv.includes('--live');
const workerUrlArg = process.argv.find((a) => a.startsWith('--worker-url='));
const WORKER_BASE = workerUrlArg
    ? workerUrlArg.split('=')[1].replace(/\/$/, '')
    : (process.env.STATIC_ASSETS_WORKER_URL || '');

// Must match cloudflare-worker/src/static-assets.ts's STATIC_JS_FILES keys exactly.
// vip_registration_hide_types.js is deliberately NOT included here -- it's an
// optional, separately-opted-in script, not part of the standard onboarding set.
const CORE_SCRIPTS = ['vip_prices.js', 'vip_detail.js', 'vip_cart.js', 'vip_catalog.js', 'vip_cart_coupon_lock.js'];

function buildHeaderHtml(): string {
    return CORE_SCRIPTS.map((f) => `<script src="${WORKER_BASE}/static/${f}"></script>`).join('\n');
}

async function main() {
    if (!WORKER_BASE) {
        throw new Error(
            'Chybí adresa Workeru -- nastav STATIC_ASSETS_WORKER_URL v .env, nebo spusť s --worker-url=https://<klientuv-worker>'
        );
    }
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');

    const html = buildHeaderHtml();
    console.log(`Cílový common-header HTML snippet (${html.length}/8192 znaků):\n`);
    console.log(html);
    console.log();

    if (!isLive) {
        console.log('[DRY RUN] Nic se nezapsalo. Spusť s --live pro ostrý zápis.');
        return;
    }

    const client = new ShoptetApiClient(token);
    const existing = await client.getTemplateIncludes();
    const existingHeader = existing.find((s) => s.location === 'common-header');
    if (existingHeader) {
        console.log('Stávající common-header snippet tohoto addonu (bude přepsán):');
        console.log(existingHeader.html);
        console.log();
    }

    await client.setTemplateInclude('common-header', html);
    console.log('[LIVE] common-header snippet zapsán.');
}

main().catch((err) => {
    console.error('CHYBA:', err.message);
    process.exit(1);
});
