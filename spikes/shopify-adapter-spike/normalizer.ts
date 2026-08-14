/**
 * Shopify Adapter Spike — Normalizer
 *
 * SCOPE: this is a throwaway spike, NOT the production adapter. It exists to answer
 * one question: can Shopify Product/Customer data be normalized into the EXISTING
 * core PricingInput without reimplementing any pricing/discount/tier logic here.
 *
 * No discount math, no tier-threshold logic, no rounding lives in this file.
 * determineTier() and PricingEngine are imported unchanged from src/core/.
 */
import Decimal from "decimal.js";
import { PricingInput, CustomerTier } from "../../src/core/interfaces.js";
import { determineTier } from "../../src/core/customer-tier.js";

export interface ShopifyVariant {
    id: string; // gid://shopify/ProductVariant/...
    sku: string | null;
    price: string; // decimal string, e.g. "1000.00"
    compareAtPrice: string | null;
}

export interface ShopifyProduct {
    id: string;
    vendor: string | null;
    productType: string | null;
    variant: ShopifyVariant;
    // adapter-only, not core: our own override data source (metafield or local
    // policy file lookup) — kept OUTSIDE the core policy config on purpose per
    // SHOPIFY-DISCOVERY.md point 9 ("metafields for operational metadata, not
    // duplicated policy data"). For this spike, product-level override values
    // are attached directly to the test fixture, not read from a real metafield.
    productMaxDiscountOverride?: number;
}

export interface ShopifyCustomer {
    id: string;
    amountSpent: { amount: string; currencyCode: string };
}

/** Shopify Customer -> total spend number -> core determineTier(), unchanged. */
export function resolveCustomerTier(customer: ShopifyCustomer): CustomerTier | undefined {
    const totalSpend = Number(customer.amountSpent.amount);
    return determineTier(totalSpend);
}

/**
 * Shopify Product/Variant (+ resolved tier) -> core PricingInput.
 * Mapping decisions follow SHOPIFY-DISCOVERY.md section 2 exactly:
 *  - basePrice <- ProductVariant.price
 *  - salePrice <- ProductVariant.compareAtPrice is NOT used here (semantic mismatch,
 *    documented in discovery doc row for salePrice: compareAtPrice is the
 *    "was" price, not an active sale price) — left undefined unless a scenario
 *    fixture explicitly overrides it.
 *  - manufacturer <- Product.vendor
 *  - category <- Product.productType (single-value fallback per discovery doc)
 */
export function normalizeToInput(
    product: ShopifyProduct,
    tier: CustomerTier | undefined,
    opts?: { salePrice?: Decimal }
): PricingInput {
    if (!product.variant.sku) {
        throw new Error(
            `ADAPTER GAP: variant ${product.variant.id} has no SKU; core PricingInput.sku is required. ` +
            `Not a core problem — Shopify SKU is optional, core's identifier contract is not. ` +
            `Adapter-side decision needed (fallback key or skip), not attempted in this spike.`
        );
    }
    const input: PricingInput = {
        sku: product.variant.sku,
        basePrice: new Decimal(product.variant.price),
        customerTier: tier,
        manufacturer: product.vendor ?? undefined,
        category: product.productType || undefined,
    };
    if (opts?.salePrice) input.salePrice = opts.salePrice;
    if (product.productMaxDiscountOverride !== undefined) {
        input.productMaxDiscount = new Decimal(product.productMaxDiscountOverride);
    }
    return input;
}
