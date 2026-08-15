/**
 * Shoptet adapter — DOCUMENTATION-ONLY wrapper, not a production integration.
 *
 * Shoptet already has a working, live, PRODUCTION integration:
 *   cloudflare-worker/src/shoptet-api/*  (client, customer-adapter, pricelist-writer,
 *   sync-orchestrator, rate-limiter) plus
 *   cloudflare-worker/src/coupon/tier-pricelist-map.ts (TIER_PRICELIST_MAP)
 * running hourly against okfish.sk via a Cloudflare Worker. That integration is
 * NOT modified, wrapped, called, or in any way touched by this file.
 *
 * This class exists ONLY so that Shoptet can be described in the same
 * EcommercePlatformAdapter shape as ShopifyAdapter/MedusaAdapter, for
 * architectural comparison across all three platforms (see
 * AUDIT-PLATFORM-INDEPENDENCE.md). It is intentionally unimplemented —
 * every method throws — because writing real logic here would either
 * duplicate the production adapter (forbidden — one source of truth) or
 * require importing/calling the production Cloudflare Worker code, which
 * would create exactly the coupling AUDIT-PLATFORM-INDEPENDENCE.md warns
 * against: "cannot touch or redeploy the real production worker."
 *
 * If Shoptet is ever meant to run for real through this shape, that is a
 * deliberate, separate decision — porting the ALREADY WORKING production
 * logic into this interface, with dry-run + full regression testing before
 * anything touches the live Cloudflare Worker or okfish.sk. Not implied by
 * this file's existence.
 *
 * Reference (read-only, never imported here):
 *   - Tier -> Shoptet pricelist ID mapping: cloudflare-worker/src/coupon/tier-pricelist-map.ts (TIER_PRICELIST_MAP)
 *   - Tier resolution: src/core/customer-tier.ts (determineTier()) — same core function every adapter uses
 *   - Price write: cloudflare-worker/src/shoptet-api/pricelist-writer.ts
 *   - Discount lock: cloudflare-worker/src/coupon/tier-pricelist-map.ts (LOCKED_COUPON_TIERS) — Shoptet is
 *     actually the one platform of the three where a form of lock already exists in production
 *     (ZR20/ZR25 coupon-lock rule), which is worth mining for docs/DISCOUNT-LOCK-PATTERN.md
 *     when that gets implemented for Shopify/Medusa.
 */
import Decimal from "decimal.js";
import { CustomerTier, PricingInput, PricingResult } from "../../core/interfaces.js";
import {
    EcommercePlatformAdapter,
    PlatformCustomer,
    PlatformProduct,
    VerifyOutcome,
    WriteOutcome,
} from "../types.js";

const NOT_IMPLEMENTED =
    "ShoptetAdapter is documentation-only (see file header). The real, working Shoptet " +
    "integration lives in cloudflare-worker/src/shoptet-api/* and cloudflare-worker/src/coupon/" +
    "tier-pricelist-map.ts, running in production for okfish.sk. This class deliberately does " +
    "not call it, to avoid coupling this experimental interface to the production Cloudflare Worker.";

export class ShoptetAdapter implements EcommercePlatformAdapter {
    readonly platformName = "shoptet" as const;

    toPricingInput(_product: PlatformProduct, _customer: PlatformCustomer | undefined): PricingInput {
        throw new Error(NOT_IMPLEMENTED);
    }

    resolveTier(_customer: PlatformCustomer): CustomerTier | undefined {
        throw new Error(NOT_IMPLEMENTED);
    }

    async writeLockedPrice(_result: PricingResult, _product: PlatformProduct, _tier: CustomerTier): Promise<WriteOutcome> {
        throw new Error(NOT_IMPLEMENTED);
    }

    async verifyPrice(_sku: string, _expected: Decimal, _tier: CustomerTier): Promise<VerifyOutcome> {
        throw new Error(NOT_IMPLEMENTED);
    }
}
