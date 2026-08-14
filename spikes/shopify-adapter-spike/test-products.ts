/**
 * 10 minimal, hand-verifiable test products (Shopify Adapter Spike, step 2 of brief).
 * Round base price 1000 everywhere so results are easy to check by hand.
 * These are normalized via normalizeToInput() the same way real Shopify data would be —
 * only the source values are made up, the code path is identical.
 */
import { ShopifyProduct } from "./normalizer.js";

export const TEST_PRODUCTS: Record<string, ShopifyProduct> = {
    // A: base price only, no sale, no limits
    A: {
        id: "gid://shopify/Product/A",
        vendor: "SpikeVendorPlain",
        productType: "SpikeCatPlain",
        variant: { id: "gid://shopify/ProductVariant/A", sku: "SPIKE-A", price: "1000.00", compareAtPrice: null },
    },
    // B: sale price with discount SMALLER than customer tier discount (tier should win)
    B: {
        id: "gid://shopify/Product/B",
        vendor: "SpikeVendorPlain",
        productType: "SpikeCatPlain",
        variant: { id: "gid://shopify/ProductVariant/B", sku: "SPIKE-B", price: "1000.00", compareAtPrice: null },
    },
    // C: sale price with discount LARGER than customer tier discount (sale should win)
    C: {
        id: "gid://shopify/Product/C",
        vendor: "SpikeVendorPlain",
        productType: "SpikeCatPlain",
        variant: { id: "gid://shopify/ProductVariant/C", sku: "SPIKE-C", price: "1000.00", compareAtPrice: null },
    },
    // D: productMaxDiscount override (5%, tighter than the 20% tier discount)
    D: {
        id: "gid://shopify/Product/D",
        vendor: "SpikeVendorPlain",
        productType: "SpikeCatPlain",
        variant: { id: "gid://shopify/ProductVariant/D", sku: "SPIKE-D", price: "1000.00", compareAtPrice: null },
        productMaxDiscountOverride: 0.05,
    },
    // E: brand (vendor) limit (10%, from test policy config)
    E: {
        id: "gid://shopify/Product/E",
        vendor: "SpikeBrandCapped",
        productType: "SpikeCatPlain",
        variant: { id: "gid://shopify/ProductVariant/E", sku: "SPIKE-E", price: "1000.00", compareAtPrice: null },
    },
    // F: category (collection/productType) limit (8%, from test policy config)
    F: {
        id: "gid://shopify/Product/F",
        vendor: "SpikeVendorPlain",
        productType: "SpikeCatCapped",
        variant: { id: "gid://shopify/ProductVariant/F", sku: "SPIKE-F", price: "1000.00", compareAtPrice: null },
    },
    // G: combination brand + category + product limit -> product limit wins (hierarchy: Product > Brand > Category)
    G: {
        id: "gid://shopify/Product/G",
        vendor: "SpikeBrandCapped",
        productType: "SpikeCatCapped",
        variant: { id: "gid://shopify/ProductVariant/G", sku: "SPIKE-G", price: "1000.00", compareAtPrice: null },
        productMaxDiscountOverride: 0.03,
    },
    // H: coupon-relevant scenario -- core has no coupon policy in src/ (coupon logic
    // lives only in cloudflare-worker/src/coupon/, Shoptet-specific write layer).
    // For this spike H exercises the same product-limit + sale-price-is-authoritative
    // rule that INCIDENTS.md documents as the coupon-adjacent guard (DiscountLimitPolicy
    // line 44: sale price wins over cap-floor even when a cap is active).
    H: {
        id: "gid://shopify/Product/H",
        vendor: "SpikeVendorPlain",
        productType: "SpikeCatPlain",
        variant: { id: "gid://shopify/ProductVariant/H", sku: "SPIKE-H", price: "1000.00", compareAtPrice: null },
        productMaxDiscountOverride: 0.05,
    },
    // I: conflict between sale price and customer discount, sale ends up HIGHER
    // than tier price (tier discount is deeper) -> HighestDiscountPolicy must
    // pick the lower (tier) price, not the sale price.
    I: {
        id: "gid://shopify/Product/I",
        vendor: "SpikeVendorPlain",
        productType: "SpikeCatPlain",
        variant: { id: "gid://shopify/ProductVariant/I", sku: "SPIKE-I", price: "1000.00", compareAtPrice: null },
    },
    // J: final price must land exactly on the original sale price (sale price
    // deeper than tier, must survive unrounded/exact through RoundingPolicy).
    J: {
        id: "gid://shopify/Product/J",
        vendor: "SpikeVendorPlain",
        productType: "SpikeCatPlain",
        variant: { id: "gid://shopify/ProductVariant/J", sku: "SPIKE-J", price: "1000.00", compareAtPrice: null },
    },
};

// Per-scenario extra input (salePrice, allowLoyaltyDiscount) that doesn't come from
// the Shopify Product object itself (compareAtPrice semantics were rejected as a
// direct salePrice source per SHOPIFY-DISCOVERY.md #2 -- these are fixture-supplied
// "active sale price" values standing in for whatever real salePrice source Phase 2
// would define).
export const SCENARIO_EXTRAS: Record<string, { salePrice?: string; allowLoyaltyDiscount: boolean }> = {
    A: { allowLoyaltyDiscount: true },
    B: { salePrice: "950.00", allowLoyaltyDiscount: true }, // 5% sale < 20% tier
    C: { salePrice: "700.00", allowLoyaltyDiscount: true }, // 30% sale > 20% tier
    D: { allowLoyaltyDiscount: true },
    E: { allowLoyaltyDiscount: true },
    F: { allowLoyaltyDiscount: true },
    G: { allowLoyaltyDiscount: true },
    H: { salePrice: "970.00", allowLoyaltyDiscount: true }, // sale price authoritative over product cap floor
    I: { salePrice: "900.00", allowLoyaltyDiscount: true }, // 10% sale, tier 20% deeper -> tier wins
    J: { salePrice: "820.00", allowLoyaltyDiscount: true }, // sale deeper than 20% tier -> final == 820.00 exactly
};

/**
 * Minimal test policy config (brand/category caps), NOT the real okfish policy-v1.json.
 *
 * NOTE on tier naming: core/interfaces.ts CustomerTier is a closed union
 * ("ZR4"|"ZR6"|...|"ZR25") -- it cannot carry arbitrary "TIER_A/B/C" labels
 * without a core change, which is explicitly out of scope for this spike. So the
 * brief's "3 simple test tiers, 0%/10%/20%" are re-expressed on top of 3 EXISTING
 * ZR identifiers, with a spike-local loyaltyTiers override (ZR4=0%, ZR10=10%,
 * ZR20=20%) fed into EngineBuilder -- this does not touch or redefine the real
 * src/config/policies/policy-v1.json (where ZR4=4%, ZR10=10%, ZR20=20%). Only
 * ZR4's percentage is reinterpreted here, purely as a local test-config value.
 */
export const TIER_A = "ZR4";  // 0% for this spike's test policy
export const TIER_B = "ZR10"; // 10%
export const TIER_C = "ZR20"; // 20%

export const TEST_POLICY = {
    loyaltyTiers: { ZR4: 0.0, ZR10: 0.1, ZR20: 0.2 } as Record<string, number>,
    brandLimits: { SpikeBrandCapped: 0.1 } as Record<string, number>,
    categoryLimits: { SpikeCatCapped: 0.08 } as Record<string, number>,
};
