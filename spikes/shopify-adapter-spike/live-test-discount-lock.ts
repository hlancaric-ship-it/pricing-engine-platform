/**
 * Live test of the discount-lock ShopifyAdapter (writeLockedPrice + verifyPrice)
 * against the SAME B2B infrastructure SHOPIFY-SPIKE-2-PLUS-RESULTS.md already
 * proved live: l-code-laboratory-tarif-plus.myshopify.com, SPIKE-A-PLUS variant,
 * CompanyLocation 22265299269, PriceList 32140263749.
 *
 * Proves, for real, not just against mocks:
 *   1. writeLockedPrice() writes the fixed price AND the pricing_engine.locked
 *      metafield in the same call.
 *   2. verifyPrice() independently confirms via contextualPricing that the
 *      customer-facing price actually matches.
 *
 * Token read from env SHOPIFY_TOKEN, never printed/logged.
 * Usage: SHOPIFY_TOKEN=... npx tsx spikes/shopify-adapter-spike/live-test-discount-lock.ts
 */
import Decimal from "decimal.js";
import { ShopifyAdapter } from "../../src/adapters/shopify/index.js";
import { PricingResult } from "../../src/core/interfaces.js";
import { PlatformProduct } from "../../src/adapters/types.js";

const token = process.env.SHOPIFY_TOKEN;
if (!token) throw new Error("SHOPIFY_TOKEN env var required");

const adapter = new ShopifyAdapter({
    store: "l-code-laboratory-tarif-plus.myshopify.com",
    adminToken: token,
    priceListId: "gid://shopify/PriceList/32140263749",
    companyLocationIdByTier: {
        ZR20: "gid://shopify/CompanyLocation/22265299269",
    },
});

const product: PlatformProduct = {
    platformProductId: "gid://shopify/Product/16097545552197",
    platformVariantId: "gid://shopify/ProductVariant/58879482134853",
    sku: "SPIKE-A-PLUS",
    basePrice: new Decimal("1000.00"),
    currency: "CZK",
};

const result: PricingResult = {
    sku: "SPIKE-A-PLUS",
    finalPrice: new Decimal("800.00"),
} as PricingResult;

async function main() {
    console.log("=== 1. writeLockedPrice (price + pricing_engine.locked metafield) ===");
    const writeOutcome = await adapter.writeLockedPrice(result, product, "ZR20" as any);
    console.log("Write outcome:", JSON.stringify(writeOutcome, null, 2));

    if (!writeOutcome.written) {
        console.error("Write FAILED — stopping before verify.");
        process.exit(1);
    }

    console.log("\n=== 2. verifyPrice (contextualPricing) ===");
    const verifyOutcome = await adapter.verifyPrice("SPIKE-A-PLUS", new Decimal("800.00"), "ZR20" as any);
    console.log("Verify outcome:", JSON.stringify(
        { ...verifyOutcome, verifiedPrice: verifyOutcome.verifiedPrice?.toString() },
        null,
        2
    ));

    console.log("\n=== RESULT ===");
    console.log(`written=${writeOutcome.written} matchesExpected=${verifyOutcome.matchesExpected} method=${verifyOutcome.method}`);
}

main().catch((e) => {
    console.error("CHYBA:", e);
    process.exit(1);
});
