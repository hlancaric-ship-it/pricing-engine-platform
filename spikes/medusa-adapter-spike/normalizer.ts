/**
 * Medusa Adapter Spike — Normalizer
 *
 * SCOPE: throwaway spike, NOT the production adapter. Mirrors
 * spikes/shopify-adapter-spike/normalizer.ts exactly in intent: prove that
 * Medusa ProductVariant/CustomerGroup data can be normalized into the
 * EXISTING core PricingInput without reimplementing any pricing/discount/
 * tier logic here. determineTier() and PricingEngine are imported unchanged
 * from src/core/.
 *
 * Per MEDUSA-DISCOVERY.md section 2: Medusa has NO `price` field on
 * ProductVariant at all (unlike Shopify/BigCommerce) -- base price lives in
 * the Pricing Module as a Price inside a PriceSet linked to the variant via
 * a module link. For this spike the "raw" base price is supplied directly
 * by the test fixture (see test-products.ts), standing in for what a real
 * adapter would get back from a `calculatePrices` call with no PriceRule
 * context (i.e. the true Medusa default price) -- normalizeToInput() itself
 * does no pricing math, it only shapes data into PricingInput.
 */
import Decimal from "decimal.js";
import { PricingInput, CustomerTier } from "../../src/core/interfaces.js";
import { determineTier } from "../../src/core/customer-tier.js";

export interface MedusaVariant {
    id: string; // variant_...
    sku: string | null;
    // Default (no PriceRule matched) amount for the given currency, as
    // returned by Pricing Module calculatePrices with an empty context.
    defaultPriceAmount: string; // decimal string, e.g. "1000.00"
    currencyCode: string;
}

export interface MedusaProduct {
    id: string;
    title: string;
    variant: MedusaVariant;
    // Medusa core has no native manufacturer/brand field (MEDUSA-DISCOVERY.md
    // #2) -- metadata stand-in only, not used by core.
    metadata?: Record<string, unknown>;
}

export interface MedusaCustomer {
    id: string; // cus_...
    // Adapter-level total spend, aggregated externally from the Order
    // Module (MEDUSA-DISCOVERY.md #4) -- Medusa has no ready-made spend
    // field on Customer, unlike Shopify amountSpent. This spike does not
    // implement that aggregation; it is supplied directly by the fixture.
    totalOrderValue: number;
}

/** Medusa Customer (+ externally aggregated spend) -> core determineTier(), unchanged. */
export function resolveCustomerTier(customer: MedusaCustomer): CustomerTier | undefined {
    return determineTier(customer.totalOrderValue);
}

/**
 * Medusa Product/Variant (+ resolved tier) -> core PricingInput.
 * Mapping decisions follow MEDUSA-DISCOVERY.md section 2 exactly:
 *  - basePrice <- default Price.amount from Pricing Module (no PriceRule match)
 *  - salePrice <- would come from a `sale`-type PriceList, not used in this spike
 *  - manufacturer/category <- not present in core Medusa product model; left undefined
 */
export function normalizeToInput(
    product: MedusaProduct,
    tier: CustomerTier | undefined,
    opts?: { salePrice?: Decimal; productMaxDiscount?: Decimal }
): PricingInput {
    if (!product.variant.sku) {
        throw new Error(
            `ADAPTER GAP: variant ${product.variant.id} has no SKU; core PricingInput.sku is required. ` +
            `Same class of gap as Shopify -- Medusa SKU is optional (nullable field), core's identifier ` +
            `contract is not. Adapter-side decision needed (fallback to variant.id), not attempted in this spike.`
        );
    }
    const input: PricingInput = {
        sku: product.variant.sku,
        basePrice: new Decimal(product.variant.defaultPriceAmount),
        customerTier: tier,
        currency: product.variant.currencyCode,
    };
    if (opts?.salePrice) input.salePrice = opts.salePrice;
    if (opts?.productMaxDiscount) input.productMaxDiscount = opts.productMaxDiscount;
    return input;
}
