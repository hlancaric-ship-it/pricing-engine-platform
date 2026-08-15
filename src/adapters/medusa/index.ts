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
 * Discount collision: locked by scoping every promotion this adapter
 * creates away from customer groups that currently hold an active override
 * PriceList (createLockedPromotion), plus an audit method
 * (auditPromotionCollisions) to catch promotions created outside this
 * adapter that were never scoped this way. Confirmed live that an
 * unscoped promotion stacks on top of the override price (800 -> 720 with
 * a 10% promo, MEDUSA-SPIKE-RESULTS.md test 5) — see
 * docs/DISCOUNT-LOCK-PATTERN.md.
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

/** A Medusa Promotion's `rules` shape — same attribute-matching contract as PriceRule (MEDUSA-DISCOVERY.md §5/§7). */
export interface MedusaPromotionRule {
    attribute: string;
    operator: "eq" | "ne" | "in" | "gte" | "lte" | "gt" | "lt";
    values: string[];
}

export interface MedusaPromotion {
    id: string;
    code?: string;
    status: string;
    application_method?: { type: string; value: number; target_type: string };
    rules?: MedusaPromotionRule[];
}

/** Matches @medusajs/js-sdk 2.19.0 admin.priceList/promotion surface, verified against real installed types. */
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
        promotion: {
            list(query: Record<string, unknown>): Promise<{ promotions: MedusaPromotion[] }>;
            create(payload: Record<string, unknown>): Promise<{ promotion: MedusaPromotion }>;
        };
        product: {
            list(query: Record<string, unknown>): Promise<{
                products: Array<{ variants: Array<{ id: string; sku: string | null }> }>;
            }>;
        };
    };
}

/** Discount shape for a promotion created through createLockedPromotion — no pricing math, just what to hand Medusa. */
export interface LockedPromotionInput {
    code: string;
    type: "percentage" | "fixed";
    value: number;
    targetType: "order" | "items" | "shipping_methods";
}

export interface MedusaAdapterConfig {
    sdk: MedusaAdminClient;
    customerGroupIdByTier: Record<CustomerTier, string>;
    /**
     * Store API context needed for verifyPrice() to build a real ephemeral
     * cart and read back the resolved unit_price — the only mechanism
     * confirmed live to reflect what a customer actually pays
     * (MEDUSA-SPIKE-RESULTS.md section 4: cart pricing context derives
     * customer.groups.id automatically from the cart's attached customer,
     * no manual context injection needed). Optional so existing configs
     * that only write prices keep working; verifyPrice reports
     * "unavailable" when this or a tier's representative customer id is
     * missing, rather than throwing.
     */
    storeApi?: {
        storeUrl: string; // "https://xxx.medusajs.app" — no trailing slash
        publishableApiKey: string;
        regionId: string;
        /** A real customer id known to belong to each tier's CustomerGroup, used only to attach to the verification cart. */
        verificationCustomerIdByTier?: Partial<Record<CustomerTier, string>>;
    };
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

    /** Customer-group ids for every tier that currently has an active override PriceList — i.e. tiers a promotion must never touch. */
    private async getLockedTierGroupIds(): Promise<string[]> {
        const tiers = Object.keys(this.config.customerGroupIdByTier) as CustomerTier[];
        const checks = await Promise.all(
            tiers.map(async (tier) => ({ tier, existingId: await this.findExistingPriceListId(tier) }))
        );
        return checks.filter((c) => c.existingId).map((c) => this.config.customerGroupIdByTier[c.tier]);
    }

    /**
     * Creates a promotion with a `customer.groups.id` `ne` rule automatically
     * appended, excluding every customer group that has an active override
     * PriceList. This is the enforcement side of the discount-lock pattern
     * for Medusa: a promotion created through this method structurally
     * cannot collide with an engine-locked tier, unlike a promotion created
     * directly via the SDK/admin UI with no rule scoping at all (the
     * default that produced the 800 -> 720 stacking in
     * MEDUSA-SPIKE-RESULTS.md test 5).
     */
    async createLockedPromotion(input: LockedPromotionInput): Promise<{ promotionId: string; excludedGroupIds: string[] }> {
        const excludedGroupIds = await this.getLockedTierGroupIds();
        const rules: MedusaPromotionRule[] =
            excludedGroupIds.length > 0
                ? [{ attribute: "customer.groups.id", operator: "ne", values: excludedGroupIds }]
                : [];

        const res = await this.config.sdk.admin.promotion.create({
            code: input.code,
            status: "active",
            type: "standard",
            application_method: {
                type: input.type,
                value: input.value,
                target_type: input.targetType,
                allocation: "across",
            },
            rules,
        });
        return { promotionId: res.promotion.id, excludedGroupIds };
    }

    /**
     * Lists every active promotion and flags ones that could apply to a
     * currently-locked tier without excluding it — catches promotions
     * created outside createLockedPromotion (admin UI, direct SDK call,
     * a promotion that predates a tier's PriceList going active). This is
     * the audit half of the pattern: enforcement at write time
     * (createLockedPromotion) plus detection for everything that bypassed it.
     */
    async auditPromotionCollisions(): Promise<
        Array<{ promotionId: string; code?: string; collidesWithGroupIds: string[] }>
    > {
        const lockedGroupIds = await this.getLockedTierGroupIds();
        if (lockedGroupIds.length === 0) return [];

        const res = await this.config.sdk.admin.promotion.list({ status: ["active"] });
        const collisions: Array<{ promotionId: string; code?: string; collidesWithGroupIds: string[] }> = [];

        for (const promotion of res.promotions) {
            const excludedGroupIds = new Set(
                (promotion.rules ?? [])
                    .filter((r) => r.attribute === "customer.groups.id" && r.operator === "ne")
                    .flatMap((r) => r.values)
            );
            const included = (promotion.rules ?? []).some(
                (r) => r.attribute === "customer.groups.id" && (r.operator === "eq" || r.operator === "in")
            );
            // Scoped-in to specific groups (eq/in) is fine only if none of those groups are locked;
            // no customer.groups.id rule at all means it applies globally, including locked tiers.
            const collidesWithGroupIds = lockedGroupIds.filter((id) => !excludedGroupIds.has(id));
            const appliesGlobally = !included && (promotion.rules ?? []).every((r) => r.attribute !== "customer.groups.id");
            if (appliesGlobally && collidesWithGroupIds.length > 0) {
                collisions.push({ promotionId: promotion.id, code: promotion.code, collidesWithGroupIds });
            }
        }
        return collisions;
    }

    /**
     * Stage-5 reconciliation per docs/DISCOUNT-LOCK-PATTERN.md and the okfish
     * incident log (INC-010: a wrong response-field assumption silently
     * broke pricing writes for 12 days while every sync run reported
     * success). "The batchPrices call returned 2xx" is not the same claim
     * as "a customer in this tier's cart sees this price" — only building
     * a real cart and reading back its resolved unit_price proves the
     * second one, per MEDUSA-SPIKE-RESULTS.md section 4 (customer.groups.id
     * pricing context is derived automatically from the cart's attached
     * customer, no manual context injection required).
     */
    async verifyPrice(sku: string, expected: Decimal, tier: CustomerTier): Promise<VerifyOutcome> {
        const storeApi = this.config.storeApi;
        const customerId = storeApi?.verificationCustomerIdByTier?.[tier];
        if (!storeApi || !customerId) {
            return {
                sku,
                matchesExpected: false,
                method: "unavailable",
                note: `No storeApi.verificationCustomerIdByTier entry configured for tier ${tier} — cannot build a verification cart.`,
            };
        }

        const productsRes = await this.config.sdk.admin.product.list({ sku: [sku] });
        const variantId = productsRes.products[0]?.variants.find((v) => v.sku === sku)?.id;
        if (!variantId) {
            return { sku, matchesExpected: false, method: "cart", note: `No variant found for sku ${sku}.` };
        }

        const headers = {
            "Content-Type": "application/json",
            "x-publishable-api-key": storeApi.publishableApiKey,
        };
        /**
         * Fails loud on HTTP-level errors instead of letting a 4xx/5xx body
         * that still happens to parse as JSON be read as if it were a
         * successful response — the same class of silent-success bug as
         * okfish-pricing-engine's INC-010 (a response-shape assumption that
         * was wrong for every call, but nothing checked status, so nothing
         * ever noticed).
         */
        const storeFetch = async (path: string, init: { method: string; body?: string; headers?: Record<string, string> }) => {
            const res = await fetch(`${storeApi.storeUrl}${path}`, { ...init, headers: { ...headers, ...init.headers } });
            const json = await res.json().catch(() => undefined);
            if (!res.ok) {
                throw new Error(`Medusa Store API HTTP ${res.status} on ${path}: ${JSON.stringify(json)}`);
            }
            return json as any;
        };

        let cartId: string | undefined;
        let cleanupError: string | undefined;
        let outcome: VerifyOutcome | undefined;
        try {
            const cartJson = await storeFetch("/store/carts", {
                method: "POST",
                body: JSON.stringify({ region_id: storeApi.regionId, customer_id: customerId }),
            });
            cartId = cartJson?.cart?.id;
            if (!cartId) {
                outcome = { sku, matchesExpected: false, method: "cart", note: `Cart creation failed: ${JSON.stringify(cartJson)}` };
                return outcome;
            }

            const lineItemJson = await storeFetch(`/store/carts/${cartId}/line-items`, {
                method: "POST",
                body: JSON.stringify({ variant_id: variantId, quantity: 1 }),
            });
            const item = lineItemJson?.cart?.items?.find((i: any) => i.variant_id === variantId);
            if (!item) {
                outcome = { sku, matchesExpected: false, method: "cart", note: `No line item resolved for variant ${variantId}.` };
                return outcome;
            }

            const verifiedPrice = new Decimal(item.unit_price);
            outcome = { sku, verifiedPrice, matchesExpected: verifiedPrice.equals(expected), method: "cart" };
            return outcome;
        } finally {
            // Ephemeral verification cart, not a real order — clean up, but
            // record failure rather than swallowing it (a leaked cart is a
            // minor operational leak, not a correctness issue for this
            // result, so it must not make verifyPrice itself fail — but it
            // also must not vanish silently). Must mutate the already-built
            // outcome object here, since a `finally` block runs after the
            // `return` expression above is evaluated, not before — a plain
            // local variable read at return time would miss this.
            if (cartId) {
                try {
                    await storeFetch(`/store/carts/${cartId}`, { method: "DELETE" });
                } catch (e) {
                    cleanupError = e instanceof Error ? e.message : String(e);
                    if (outcome) {
                        outcome.note = `verification cart ${cartId} cleanup failed, left behind: ${cleanupError}`;
                    }
                }
            }
        }
    }
}
