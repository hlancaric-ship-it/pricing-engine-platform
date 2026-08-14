/**
 * Runs the 10 test products through the REAL core PricingEngine (via EngineBuilder),
 * for each of the 3 spike tiers (TIER_A/B/C = ZR4/ZR10/ZR20, see test-products.ts).
 * Prints PricingResult for hand-verification. Also demonstrates writeFixedPrice()
 * for the step-6 800 CZK case (base 1000, TIER_C 20% off).
 *
 * Usage: npx tsx spikes/shopify-adapter-spike/run-pricing.ts
 */
import { PricingEngine } from "../../src/core/PricingEngine.js";
import { BasePricePolicy } from "../../src/policies/BasePricePolicy.js";
import { HighestDiscountPolicy } from "../../src/policies/HighestDiscountPolicy.js";
import { DiscountLimitPolicy } from "../../src/policies/DiscountLimitPolicy.js";
import { RoundingPolicy } from "../../src/policies/RoundingPolicy.js";
import Decimal from "decimal.js";
import { TEST_PRODUCTS, SCENARIO_EXTRAS, TEST_POLICY, TIER_A, TIER_B, TIER_C } from "./test-products.js";
import { normalizeToInput } from "./normalizer.js";
import { CustomerTier } from "../../src/core/interfaces.js";

function buildTestEngine(): PricingEngine {
    const engine = new PricingEngine();
    engine.use(new BasePricePolicy());
    const tiers: Record<string, Decimal> = {};
    for (const [k, v] of Object.entries(TEST_POLICY.loyaltyTiers)) tiers[k] = new Decimal(v);
    engine.use(new HighestDiscountPolicy(tiers));
    const brands: Record<string, Decimal> = {};
    for (const [k, v] of Object.entries(TEST_POLICY.brandLimits)) brands[k] = new Decimal(v);
    const cats: Record<string, Decimal> = {};
    for (const [k, v] of Object.entries(TEST_POLICY.categoryLimits)) cats[k] = new Decimal(v);
    engine.use(new DiscountLimitPolicy(brands, cats));
    engine.use(new RoundingPolicy());
    engine.freeze();
    return engine;
}

const engine = buildTestEngine();
const tiers: CustomerTier[] = [TIER_A as CustomerTier, TIER_B as CustomerTier, TIER_C as CustomerTier];

console.log("sku,tier,basePrice,finalPrice,rules");
for (const [key, product] of Object.entries(TEST_PRODUCTS)) {
    const extra = SCENARIO_EXTRAS[key];
    for (const tier of tiers) {
        const input = normalizeToInput(product, tier, {
            salePrice: extra.salePrice ? new Decimal(extra.salePrice) : undefined,
        });
        input.allowLoyaltyDiscount = extra.allowLoyaltyDiscount;
        const result = engine.calculatePrice(input);
        console.log(
            `${result.sku},${tier},${input.basePrice.toFixed(2)},${result.finalPrice.toFixed(2)},"${result.appliedRules.map(r => r.rule).join("|")}"`
        );
    }
}
