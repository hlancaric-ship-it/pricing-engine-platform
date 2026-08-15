import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { PricingEngine } from "../src/core/PricingEngine.js";
import { BasePricePolicy } from "../src/policies/BasePricePolicy.js";
import { HighestDiscountPolicy } from "../src/policies/HighestDiscountPolicy.js";
import { DiscountLimitPolicy } from "../src/policies/DiscountLimitPolicy.js";
import { RoundingPolicy } from "../src/policies/RoundingPolicy.js";
import { PricingInput } from "../src/core/interfaces.js";

/**
 * Combined brand cap + category limit + clearance/sale price + loyalty tier,
 * per Jan's explicit spec (chat, 2026-08-15):
 *  - A cap (brand/category/product) limits how deep a LOYALTY-tier discount
 *    may go — it's a ceiling on tier-driven discount depth, never a floor
 *    that raises a shallower tier discount up to the cap.
 *  - An active sale/clearance price deep enough to beat the customer's tier
 *    (i.e. HighestDiscountPolicy already picked SALE) is untouchable by any
 *    cap — "the engine goes blind" and uses that sale price for every tier
 *    alike (VAGNER incident, INCIDENTS.md 2026-08-04).
 *  - If the sale/clearance price is SHALLOWER than what the customer's own
 *    tier (capped) would give them, the customer must get the deeper
 *    tier-derived price instead — a sale price must never make a customer
 *    worse off than their tier already entitles them to.
 *
 * Fixed in src/policies/DiscountLimitPolicy.ts: the cap-skip check now looks
 * at which rule HighestDiscountPolicy actually selected (context.appliedRules)
 * instead of unconditionally trusting that input.salePrice is merely present.
 */
function ruleNames(result: ReturnType<PricingEngine["calculatePrice"]>): string[] {
    return result.appliedRules.map((r) => r.rule);
}

function buildEngine(brandLimits: Record<string, Decimal>, categoryLimits: Record<string, Decimal>) {
    const tiers: Record<string, Decimal> = { ZR4: new Decimal("0.04"), ZR20: new Decimal("0.20"), ZR25: new Decimal("0.25") };
    const engine = new PricingEngine();
    engine.use(new BasePricePolicy());
    engine.use(new HighestDiscountPolicy(tiers));
    engine.use(new DiscountLimitPolicy(brandLimits, categoryLimits));
    engine.use(new RoundingPolicy());
    engine.freeze();
    return engine;
}

describe("Combined brand cap + category limit + clearance/sale price + loyalty tier", () => {
    it("cap present, no sale price: cap limits tier depth by hierarchy (brand over category), never raises a shallower tier", () => {
        const engine = buildEngine({ Shimano: new Decimal("0.10") }, { Navijaky: new Decimal("0.30") });

        const deepTier = engine.calculatePrice({
            sku: "COMBO-1A",
            basePrice: new Decimal(1000),
            customerTier: "ZR25" as any, // 25% tier, deeper than the 10% brand cap
            allowLoyaltyDiscount: true,
            manufacturer: "Shimano",
            category: "Navijaky",
        });
        expect(deepTier.finalPrice.toString()).toBe("900"); // capped down to 10%
        expect(ruleNames(deepTier)).toContain("BRAND_LIMIT");
        expect(ruleNames(deepTier)).not.toContain("CATEGORY_LIMIT"); // hierarchy: brand wins, category never considered

        const shallowTier = engine.calculatePrice({
            sku: "COMBO-1B",
            basePrice: new Decimal(1000),
            customerTier: "ZR4" as any, // 4% tier, shallower than the 10% cap
            allowLoyaltyDiscount: true,
            manufacturer: "Shimano",
            category: "Navijaky",
        });
        expect(shallowTier.finalPrice.toString()).toBe("960"); // left at their own 4%, NOT raised to the 10% cap
        expect(ruleNames(shallowTier)).toContain("LOYALTY");
    });

    it("clearance price deeper than every tier (30% off): engine goes blind, same price for a high-tier and a low-tier customer alike, cap never touches it", () => {
        const engine = buildEngine({ Shimano: new Decimal("0.10") }, {});
        const clearanceInput = (tier: string) => ({
            sku: `COMBO-2-${tier}`,
            basePrice: new Decimal(1000),
            salePrice: new Decimal(700), // 30% off — deeper than the 25% max tier and the 10% brand cap
            customerTier: tier as any,
            allowLoyaltyDiscount: true,
            manufacturer: "Shimano",
        });

        const forZr25 = engine.calculatePrice(clearanceInput("ZR25"));
        const forZr4 = engine.calculatePrice(clearanceInput("ZR4"));

        expect(forZr25.finalPrice.toString()).toBe("700");
        expect(forZr4.finalPrice.toString()).toBe("700"); // same price regardless of tier — "engine slepý"
        expect(ruleNames(forZr25)).toContain("SALE");
        expect(ruleNames(forZr25)).not.toContain("BRAND_LIMIT"); // cap never touches an active sale price
    });

    it("sale price SHALLOWER than the customer's tier, WITH a cap active: customer gets the deeper cap-limited tier price, not the shallow sale price", () => {
        const engine = buildEngine({ Shimano: new Decimal("0.10") }, {});
        const input: PricingInput = {
            sku: "COMBO-3",
            basePrice: new Decimal(1000),
            salePrice: new Decimal(950), // only 5% off
            customerTier: "ZR25" as any, // 25% tier, capped to 10% = 900, still deeper than the 5% sale
            allowLoyaltyDiscount: true,
            manufacturer: "Shimano",
        };
        const result = engine.calculatePrice(input);
        // HighestDiscountPolicy picks LOYALTY (750, deeper than the 950 sale) first. DiscountLimitPolicy
        // sees the last-applied rule was LOYALTY (not SALE), so the cap applies normally: 750 is deeper
        // than the 10% cap allows, so it gets raised to the cap floor, 900 — never all the way back down
        // to the shallow 950 sale price. The customer ends up better off (900) than either the raw sale
        // price (950) or the fully uncapped tier price (750) would each give alone.
        expect(result.finalPrice.toString()).toBe("900");
        expect(ruleNames(result)).toContain("BRAND_LIMIT");
        expect(ruleNames(result)).not.toContain("SALE");
    });

    it("sale price shallower than a LOW tier too (tier itself shallower than the sale): sale still wins, cap irrelevant since it was never the deepest option", () => {
        const engine = buildEngine({ Shimano: new Decimal("0.10") }, {});
        const input: PricingInput = {
            sku: "COMBO-4",
            basePrice: new Decimal(1000),
            salePrice: new Decimal(950), // 5% off
            customerTier: "ZR4" as any, // 4% tier — shallower than the 5% sale
            allowLoyaltyDiscount: true,
            manufacturer: "Shimano",
        };
        const result = engine.calculatePrice(input);
        // HighestDiscountPolicy picks SALE (950 < 960) since it's deeper than the tiny 4% tier here.
        // DiscountLimitPolicy sees SALE was selected and leaves it untouched — correct, since 950 is
        // already the best price available to this specific customer.
        expect(result.finalPrice.toString()).toBe("950");
        expect(ruleNames(result)).toContain("SALE");
    });

    it("no cap configured anywhere: HighestDiscountPolicy alone already picks the deeper of sale vs loyalty (baseline, unaffected by this fix)", () => {
        const engine = buildEngine({}, {});
        const result = engine.calculatePrice({
            sku: "COMBO-5",
            basePrice: new Decimal(1000),
            salePrice: new Decimal(950),
            customerTier: "ZR25" as any,
            allowLoyaltyDiscount: true,
        });
        expect(result.finalPrice.toString()).toBe("750");
        expect(ruleNames(result)).toContain("LOYALTY");
    });
});
