/**
 * Minimal fixture for the Medusa spike, matching the Shopify/BigCommerce
 * spikes' "same numbers" discipline for direct comparability: base price
 * 1000.00, test tier 20% discount -> expected final 800.00.
 */
import { MedusaProduct, MedusaCustomer } from "./normalizer.js";

export const TEST_PRODUCT: MedusaProduct = {
    id: "prod_spike_01",
    title: "Spike Test Product",
    variant: {
        id: "variant_spike_01",
        sku: "MEDUSA-SPIKE-1",
        defaultPriceAmount: "1000.00",
        currencyCode: "czk",
    },
};

// ZR20 tier requires totalOrderValue >= 7000 per determineTier() (src/core/customer-tier.ts).
// TEST_POLICY below re-expresses this spike's "20%" test tier on the existing ZR20
// identifier with a local loyaltyTiers override, exactly like the Shopify spike did
// (spikes/shopify-adapter-spike/test-products.ts TIER_C) — no core change.
export const TEST_CUSTOMER: MedusaCustomer = {
    id: "cus_spike_01",
    totalOrderValue: 7500, // -> determineTier() = "ZR20"
};

export const TEST_POLICY = {
    loyaltyTiers: { ZR20: 0.2 } as Record<string, number>,
};

export const TEST_CUSTOMER_GROUP_ID = "cusgroup_spike_zr20";
