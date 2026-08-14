import { CustomerTier } from "./interfaces.js";

/**
 * Platform-independent business rule: total customer spend -> loyalty (ZR) tier.
 * Moved here from cloudflare-worker/src/shoptet-api/customer-adapter.ts, where it
 * was previously tangled inside the Shoptet-specific adapter class alongside
 * ShoptetApiClient/ShoptetOrder parsing. Owning it here means any future
 * platform adapter (Shopify, etc.) can reuse the exact same rule by feeding it
 * normalized spend data, without re-deriving or duplicating the thresholds.
 *
 * NOTE: values/thresholds are byte-for-byte identical to the original
 * determineTier() — this is a pure code-motion, not a logic change.
 */
export function determineTier(totalOrderValue: number): CustomerTier | undefined {
    if (totalOrderValue >= 10000) return "ZR25";
    if (totalOrderValue >= 7000) return "ZR20";
    if (totalOrderValue >= 5000) return "ZR18";
    if (totalOrderValue >= 2000) return "ZR16";
    if (totalOrderValue >= 1000) return "ZR14";
    if (totalOrderValue >= 700) return "ZR12";
    if (totalOrderValue >= 500) return "ZR10";
    if (totalOrderValue >= 300) return "ZR8";
    if (totalOrderValue >= 100) return "ZR6";
    return "ZR4"; // 0 - 99.99
}

/** All generic ZR tier identifiers, platform-independent (no Shoptet pricelist IDs). */
export const ALL_CUSTOMER_TIERS: CustomerTier[] = [
    "ZR4", "ZR6", "ZR8", "ZR10", "ZR12", "ZR14", "ZR16", "ZR18", "ZR20", "ZR25"
];
