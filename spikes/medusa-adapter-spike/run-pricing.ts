/**
 * Medusa Adapter Spike — step 1 (Core check) + step 2 (adapter demo, dry-run).
 *
 * Runs the REAL, unmodified core PricingEngine against the Medusa-normalized
 * fixture (base 1000.00, ZR20/20% tier) and prints the exact PricingResult.
 * Then demonstrates the dry-run path of writeOverridePrice() -- no network
 * call is made in dry-run mode, so this script runs standalone without a
 * live Medusa backend (see MEDUSA-SPIKE-RESULTS.md "Environment" section for
 * why a live backend could not be brought up in this sandbox).
 *
 * Usage: npx tsx spikes/medusa-adapter-spike/run-pricing.ts
 */
import { PricingEngine } from "../../src/core/PricingEngine.js";
import { BasePricePolicy } from "../../src/policies/BasePricePolicy.js";
import { HighestDiscountPolicy } from "../../src/policies/HighestDiscountPolicy.js";
import { DiscountLimitPolicy } from "../../src/policies/DiscountLimitPolicy.js";
import { RoundingPolicy } from "../../src/policies/RoundingPolicy.js";
import { TEST_PRODUCT, TEST_CUSTOMER, TEST_CUSTOMER_GROUP_ID } from "./test-fixture.js";
import { normalizeToInput, resolveCustomerTier } from "./normalizer.js";
import { writeOverridePrice } from "./writer.js";
import { CustomerTier } from "../../src/core/interfaces.js";
import Decimal from "decimal.js";

function buildTestEngine(): PricingEngine {
    const engine = new PricingEngine();
    engine.use(new BasePricePolicy());
    engine.use(new HighestDiscountPolicy({ ZR20: new Decimal("0.2") }));
    engine.use(new DiscountLimitPolicy({}, {}));
    engine.use(new RoundingPolicy());
    engine.freeze();
    return engine;
}

async function main() {
    const engine = buildTestEngine();

    const tier = resolveCustomerTier(TEST_CUSTOMER);
    console.log(`resolveCustomerTier(totalOrderValue=${TEST_CUSTOMER.totalOrderValue}) -> ${tier}`);

    const input = normalizeToInput(TEST_PRODUCT, tier as CustomerTier);
    input.allowLoyaltyDiscount = true;
    console.log("PricingInput:", JSON.stringify({ ...input, basePrice: input.basePrice.toString() }, null, 2));

    const result = engine.calculatePrice(input);
    console.log("PricingResult:", JSON.stringify({
        sku: result.sku,
        originalPrice: result.originalPrice.toString(),
        finalPrice: result.finalPrice.toString(),
        appliedRules: result.appliedRules,
        warnings: result.warnings,
        rejected: result.rejected,
    }, null, 2));

    // Dry-run write demo (no network call performed).
    const outcome = await writeOverridePrice(
        undefined as any, // sdk not needed in dry-run branch
        result,
        TEST_PRODUCT.variant.id,
        TEST_PRODUCT.variant.currencyCode,
        TEST_CUSTOMER_GROUP_ID,
        tier as CustomerTier,
        { dryRun: true }
    );
    console.log("Dry-run write outcome:", outcome);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
