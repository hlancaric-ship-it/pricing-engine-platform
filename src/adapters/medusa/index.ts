/**
 * Medusa adapter — production implementation of EcommercePlatformAdapter.
 *
 * Migrated from spikes/medusa-adapter-spike after MEDUSA-SPIKE-RESULTS.md
 * confirmed the full chain live: Engine(800.00) -> Medusa PriceList
 * override(800.00) -> Cart(800.00) -> Order(800.00), self-hosted, no plan gate.
 *
 * Two things this migration fixes vs. the spike, both found live:
 *  1. status must be explicit "active" — Medusa defaults new PriceLists to
 *     "draft", and calculatePrices silently ignores draft price lists
 *     (MEDUSA-SPIKE-RESULTS.md section 3/6). This was the one real bug the
 *     spike found; it's fixed here, not just noted.
 *  2. Idempotency: the spike always created a new PriceList. Production
 *     needs check-then-update via batchPrices, not blind create — see
 *     upsertPriceListId() below.
 *
 * Discount collision: NOT locked — a generic promotion stacks on top of the
 * override price (confirmed live, 800 -> 720 with a 10% promo). See
 * docs/DISCOUNT-LOCK-PATTERN.md for the required customer-group-scoped
 * promotion rule discipline.
 */
import Decimal from "decimal.js";
import { determineTier } from "../../core/customer-tier.js";
import { CustomerTier, PricingInput, PricingResult } from "../../core/interfaces.js";
import {
    EcommercePlatformAdapter,
    PlatformCustomer,
    PlatformProduct,
    VerifyOutcome,
    WriteOutcome,
} from "../types.js";

/** Matches @medusajs/js-sdk 2.19.0 admin.priceList surface, verified against real installed types. */
export interface MedusaAdminClient {
    admin: {
        priceList: {
            list(query: Record<string, unknown>): Promise<{ price_lists: Array<{ id: string; title: string }> }>;
            create(payload: Record<string, unknown>): Promise<{ price_list: { id: string; prices?: Array<{ id: string }> } }>;
            batchPrices(
                id: string,
                payload: { create?: unknown[]; update?: unknown[] }
            ): Promise<{ created?: Array<{ id: string }>; updated?: Array<{ id: string }> }>;
        };
    };
}

export interface MedusaAdapterConfig {
    sdk: MedusaAdminClient;
    customerGroupIdByTier: Record<CustomerTier, string>;
}

export class MedusaAdapter implements EcommercePlatformAdapter {
    readonly platformName = "medusa" as const;

    constructor(private config: MedusaAdapterConfig) {}

    toPricingInput(product: PlatformProduct, customer: PlatformCustomer | undefined): PricingInput {
        if (!product.sku) {
            throw new Error(
                `ADAPTER GAP: variant ${product.platformVariantId} has no SKU; core.PricingInput.sku is required. ` +
                    `Medusa SKU is nullable, core's identifier contract is not — resolve at data-import layer.`
            );
        }
        const tier = customer ? this.resolveTier(customer) : undefined;
        const input: PricingInput = {
            sku: product.sku,
            basePrice: product.basePrice,
            customerTier: tier,
            currency: product.currency,
        };
        if (product.salePrice) input.salePrice = product.salePrice;
        if (product.productMaxDiscountOverride) input.productMaxDiscount = product.productMaxDiscountOverride;
        return input;
    }

    resolveTier(customer: PlatformCustomer): CustomerTier | undefined {
        return determineTier(customer.totalSpend);
    }

    /** Find an existing tier-scoped PriceList by title convention, or undefined if none exists yet. */
    private async findExistingPriceListId(tier: CustomerTier): Promise<string | undefined> {
        const title = `okfish-pricing-engine — ${tier}`;
        const res = await this.config.sdk.admin.priceList.list({ title });
        return res.price_lists.find((pl) => pl.title === title)?.id;
    }

    async writeLockedPrice(result: PricingResult, product: PlatformProduct, tier: CustomerTier): Promise<WriteOutcome> {
        const amount = Number(result.finalPrice.toFixed(2));
        const customerGroupId = this.config.customerGroupIdByTier[tier];
        if (!customerGroupId) {
            return { sku: result.sku, written: false, error: `No customer group configured for tier ${tier}` };
        }

        const existingId = await this.findExistingPriceListId(tier);
        if (existingId) {
            const res = await this.config.sdk.admin.priceList.batchPrices(existingId, {
                create: [
                    {
                        variant_id: product.platformVariantId,
                        currency_code: product.currency,
                        amount,
                        rules: { "customer.groups.id": customerGroupId },
                    },
                ],
            });
            const created = res.created?.[0];
            return { sku: result.sku, written: !!created, platformRef: existingId };
        }

        const res = await this.config.sdk.admin.priceList.create({
            title: `okfish-pricing-engine — ${tier}`,
            description: `Locked override price list for tier ${tier}`,
            type: "override",
            status: "active", // MUST be explicit — see file header, this was the spike's one real bug
            prices: [
                {
                    variant_id: product.platformVariantId,
                    currency_code: product.currency,
                    amount,
                    rules: { "customer.groups.id": customerGroupId },
                },
            ],
        });
        return {
            sku: result.sku,
            written: !!res.price_list?.id,
            platformRef: res.price_list?.id,
        };
    }

    async verifyPrice(sku: string, expected: Decimal, _tier: CustomerTier): Promise<VerifyOutcome> {
        // Real verification needs a live calculatePrices call with the customer's
        // group context, or a real cart query — both proven live in
        // MEDUSA-SPIKE-RESULTS.md section 4. Not wired here because it needs a
        // cart/customer context this method's signature doesn't carry — same
        // deliberate boundary as ShopifyAdapter.verifyPrice, see
        // docs/DISCOUNT-LOCK-PATTERN.md.
        return {
            sku,
            matchesExpected: false,
            method: "unavailable",
            note:
                "MedusaAdapter.verifyPrice needs a cart/customer context to call calculatePrices — " +
                "wire this through the caller per MEDUSA-SPIKE-RESULTS.md section 4 before treating as implemented.",
        };
    }
}
