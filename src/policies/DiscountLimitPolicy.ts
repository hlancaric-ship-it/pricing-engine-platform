import Decimal from "decimal.js";
import { PricingPolicy, PricingCommand, RuleType, ReadonlyPricingContext } from '../core/interfaces.js';

export class DiscountLimitPolicy implements PricingPolicy {
    name = 'DiscountLimit';
    priority = 30;

    private brandLimits: Record<string, Decimal>;
    private categoryLimits: Record<string, Decimal>;

    constructor(
        brandLimits: Record<string, Decimal> = {},
        categoryLimits: Record<string, Decimal> = {}
    ) {
        this.brandLimits = brandLimits;
        this.categoryLimits = categoryLimits;
    }

    apply(context: ReadonlyPricingContext): PricingCommand | void {
        let activeLimit: Decimal | undefined;
        let activeRuleType: RuleType | undefined;

        // Hierarchical fallback: Product -> Brand -> Category -> None
        if (context.input.productMaxDiscount !== undefined) {
            activeLimit = context.input.productMaxDiscount;
            activeRuleType = RuleType.PRODUCT_LIMIT;
        } else if (context.input.manufacturer && this.brandLimits[context.input.manufacturer] !== undefined) {
            activeLimit = this.brandLimits[context.input.manufacturer];
            activeRuleType = RuleType.BRAND_LIMIT;
        } else if (context.input.category && this.categoryLimits[context.input.category] !== undefined) {
            activeLimit = this.categoryLimits[context.input.category];
            activeRuleType = RuleType.CATEGORY_LIMIT;
        }

        if (activeLimit === undefined || activeRuleType === undefined) {
            return;
        }

        const one = new Decimal("1");
        const minAllowedPrice = context.input.basePrice.mul(one.minus(activeLimit));

        // Cap-clamp whatever HighestDiscountPolicy picked (sale or loyalty) up to
        // what the cap allows, if it went deeper than the cap permits. This is the
        // "max possible allowed discount" — a loyalty tier deeper than the cap gets
        // limited to it; a tier already shallower than the cap is left untouched
        // (never raised up to the cap).
        const cappedCurrentPrice = context.currentPrice.lessThan(minAllowedPrice) ? minAllowedPrice : context.currentPrice;

        // An active sale/clearance price is still compared against that capped
        // price and wins outright if it is deeper — it must never be watered down
        // to the cap-clamped value. This is what protects a genuinely deep sale
        // price (VAGNER incident, INCIDENTS.md 2026-08-04: an 18%-off action price
        // must never be raised to a 4%-cap floor, even though the customer's own
        // loyalty tier was nominally deeper than 18% before capping — see
        // tests/pricing-parity.test.ts's 'action-price-steeper-than-cap' regression
        // profile). It also correctly lets a genuinely shallow sale price lose to a
        // deeper cap-limited loyalty price instead of always winning by default —
        // the customer must never end up worse off than the cap already entitles
        // them to, just because some sale price happens to exist on the product.
        const salePrice = context.input.salePrice;
        const saleWins = salePrice !== undefined && salePrice.lessThan(cappedCurrentPrice);
        const finalPrice = saleWins ? (salePrice as Decimal) : cappedCurrentPrice;
        const finalRule = saleWins ? RuleType.SALE : activeRuleType;

        if (!finalPrice.equals(context.currentPrice)) {
            return { type: "SET_PRICE", price: finalPrice, rule: finalRule };
        }
    }
}
