/**
 * EcommercePlatformAdapter — the one interface every platform adapter
 * (Shopify, Medusa, and eventually Shoptet's existing cloudflare-worker
 * integration wired into this shape) implements.
 *
 * Design rule, non-negotiable per AUDIT-PLATFORM-INDEPENDENCE.md: an adapter
 * NEVER computes a discount, tier, or final price. It only translates
 * platform data into core.PricingInput, and translates core.PricingResult
 * into a platform write. All arithmetic lives in src/core.
 *
 * This shape is derived from what already worked twice, live, not designed
 * up front: spikes/shopify-adapter-spike (Shopify Plus, 4/4 checkout-verified)
 * and spikes/medusa-adapter-spike (self-hosted, 5/5 order-verified).
 */
import Decimal from "decimal.js";
import { CustomerTier, PricingInput, PricingResult } from "../core/interfaces.js";

/** Raw platform product/variant data, already fetched — adapter shapes it, doesn't fetch it. */
export interface PlatformProduct {
    platformProductId: string;
    platformVariantId: string;
    sku: string | null;
    basePrice: Decimal;
    currency: string;
    manufacturer?: string;
    category?: string;
    productMaxDiscountOverride?: Decimal;
    salePrice?: Decimal;
}

/** Raw platform customer data — adapter resolves tier via core.determineTier(), never invents its own. */
export interface PlatformCustomer {
    platformCustomerId: string;
    /** Total spend as the platform reports/aggregates it. Adapter's job to get this number right per-platform. */
    totalSpend: number;
}

export interface WriteOutcome {
    sku: string;
    written: boolean;
    /** Platform-specific reference to what was written (price list id, price id, etc). */
    platformRef?: string;
    error?: string;
}

export interface VerifyOutcome {
    sku: string;
    /** The price the adapter could independently confirm is what a customer actually sees/pays. */
    verifiedPrice?: Decimal;
    matchesExpected: boolean;
    method: "api-contextual" | "cart" | "order" | "unavailable";
    note?: string;
}

export interface EcommercePlatformAdapter {
    readonly platformName: "shopify" | "medusa" | "shoptet";

    /** Platform product/customer -> core.PricingInput. No discount/tier math here. */
    toPricingInput(product: PlatformProduct, customer: PlatformCustomer | undefined): PricingInput;

    /** Platform customer -> core.CustomerTier, via core.determineTier() only — never a local reimplementation. */
    resolveTier(customer: PlatformCustomer): CustomerTier | undefined;

    /**
     * core.PricingResult -> platform write, as a LOCKED price (see docs/DISCOUNT-LOCK-PATTERN.md).
     * A write that can silently be overridden by a later promotion/coupon is not
     * a compliant implementation of this method — that's the #1 failure mode
     * found on every platform tested (Shopify combinesWith, Medusa promotions).
     */
    writeLockedPrice(result: PricingResult, product: PlatformProduct, tier: CustomerTier): Promise<WriteOutcome>;

    /**
     * Independently confirm what a customer actually sees/pays — not just that
     * the write API call succeeded. Per SHOPIFY-SPIKE-2 / MEDUSA-SPIKE-RESULTS:
     * "API accepted it" and "customer will pay it" are different claims.
     */
    verifyPrice(sku: string, expected: Decimal, tier: CustomerTier): Promise<VerifyOutcome>;
}
