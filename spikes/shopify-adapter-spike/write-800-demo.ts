/**
 * One-off demo of writer.ts: writes the engine-computed 800.00 CZK (SPIKE-A, TIER_C)
 * into the standalone (catalog-less) PriceList created during the spike, to prove
 * the write mechanism itself works end-to-end from core PricingResult.
 * Token read from env SHOPIFY_TOKEN, never printed/logged.
 * Usage: SHOPIFY_TOKEN=... npx tsx spikes/shopify-adapter-spike/write-800-demo.ts
 */
import { PricingEngine } from "../../src/core/PricingEngine.js";
import { BasePricePolicy } from "../../src/policies/BasePricePolicy.js";
import { HighestDiscountPolicy } from "../../src/policies/HighestDiscountPolicy.js";
import { DiscountLimitPolicy } from "../../src/policies/DiscountLimitPolicy.js";
import { RoundingPolicy } from "../../src/policies/RoundingPolicy.js";
import Decimal from "decimal.js";
import { writeFixedPrice } from "./writer.js";

const engine = new PricingEngine();
engine.use(new BasePricePolicy());
engine.use(new HighestDiscountPolicy({ ZR20: new Decimal("0.20") }));
engine.use(new DiscountLimitPolicy());
engine.use(new RoundingPolicy());
engine.freeze();

const result = engine.calculatePrice({
    sku: "SPIKE-A",
    basePrice: new Decimal("1000.00"),
    customerTier: "ZR20",
    allowLoyaltyDiscount: true,
});

console.log("Engine result:", result.sku, result.finalPrice.toFixed(2), result.appliedRules.map(r => r.rule));

const token = process.env.SHOPIFY_TOKEN;
if (!token) throw new Error("SHOPIFY_TOKEN env var required");

const outcome = await writeFixedPrice(
    result,
    "gid://shopify/ProductVariant/54340572217687", // SPIKE-A variant
    "gid://shopify/PriceList/31579537751",          // standalone, catalog-less PriceList from Section A
    "EUR",
    "l-code-laborator.myshopify.com",
    token
);
console.log("Write outcome:", JSON.stringify(outcome));
