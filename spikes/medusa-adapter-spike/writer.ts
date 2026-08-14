/**
 * Medusa Adapter Spike — Writer
 *
 * PricingResult -> Medusa PriceList (type "override") write, scoped to a
 * CustomerGroup via the price's `rules` map (attribute `customer.groups.id`,
 * per MEDUSA-DISCOVERY.md section 5). No pricing logic here, only a thin
 * write through the official @medusajs/js-sdk Admin client.
 *
 * Verified against real, installed package types (not guessed):
 *  - @medusajs/js-sdk 2.19.0  -> dist/esm/admin/price-list.d.ts
 *    exposes sdk.admin.priceList.create() and .batchPrices()
 *  - @medusajs/types 2.19.0  -> dist/http/price-list/admin/payloads.d.ts
 *    AdminCreatePriceList { title, description, type, prices?: AdminCreatePriceListPrice[] }
 *    AdminCreatePriceListPrice { currency_code, amount, variant_id, rules?: Record<string,string> }
 *
 * This confirms MEDUSA-DISCOVERY.md's "path A" assumption (write an
 * `override`-type PriceList entry) is not just theoretically correct but
 * matches the real, current SDK surface -- no invented endpoints.
 */
import { MedusaAdminClient } from "./client-types.js";
import { PricingResult, CustomerTier } from "../../src/core/interfaces.js";

export interface WriteOutcome {
    sku: string;
    written: boolean;
    priceListId?: string;
    priceId?: string;
    error?: string;
}

/**
 * Creates (or reuses, if priceListId given) a tier-scoped override PriceList
 * and writes result.finalPrice into it for the given variant, ruled to the
 * customer group tied to `tier`.
 *
 * Idempotency note (per CLAUDE.md dry-run-first discipline): this spike
 * function does NOT itself dedupe -- a real adapter must check for an
 * existing Price for (priceListId, variantId, currency) before create vs.
 * update via batchPrices({update:[...]}) instead of always create. Left
 * unimplemented here since this spike's scope is "prove the mechanism
 * works," not "build the idempotent production adapter."
 */
export async function writeOverridePrice(
    sdk: MedusaAdminClient,
    result: PricingResult,
    variantId: string,
    currencyCode: string,
    customerGroupId: string,
    tier: CustomerTier,
    opts: { dryRun: boolean; existingPriceListId?: string }
): Promise<WriteOutcome> {
    const amount = Number(result.finalPrice.toFixed(2));

    if (opts.dryRun) {
        return {
            sku: result.sku,
            written: false,
            error: `DRY_RUN: would write override price ${amount} ${currencyCode} for variant ${variantId}, ` +
                `scoped to customer_group ${customerGroupId} (tier ${tier}), price list ${opts.existingPriceListId ?? "(new)"}`,
        };
    }

    if (opts.existingPriceListId) {
        const res = await sdk.admin.priceList.batchPrices(opts.existingPriceListId, {
            create: [
                {
                    variant_id: variantId,
                    currency_code: currencyCode,
                    amount,
                    rules: { "customer.groups.id": customerGroupId },
                },
            ],
        });
        const created = res.created?.[0];
        return { sku: result.sku, written: !!created, priceListId: opts.existingPriceListId, priceId: created?.id };
    }

    const res = await sdk.admin.priceList.create({
        title: `okfish-pricing-engine spike override — ${tier}`,
        description: `Spike-written override price list for tier ${tier} (medusa-adapter-spike)`,
        type: "override",
        prices: [
            {
                variant_id: variantId,
                currency_code: currencyCode,
                amount,
                rules: { "customer.groups.id": customerGroupId },
            },
        ],
    });
    const priceList = res.price_list;
    const price = priceList.prices?.[0];
    return { sku: result.sku, written: !!priceList?.id, priceListId: priceList?.id, priceId: price?.id };
}
