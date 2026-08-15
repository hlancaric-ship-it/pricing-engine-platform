/**
 * Shopify Plus adapter — production implementation of EcommercePlatformAdapter.
 *
 * Migrated from spikes/shopify-adapter-spike after that spike proved the
 * mechanism live: SHOPIFY-SPIKE-2-PLUS-RESULTS.md confirmed the full chain
 * Engine(800.00) -> Shopify contextualPricing(800.0) -> Storefront cart(800.0)
 * -> real completed checkout(800.0), on Shopify Plus specifically (Basic
 * blocks CompanyLocationCatalog activation — SHOPIFY-SPIKE-1-RESULTS.md).
 *
 * Requires: Shopify Plus (B2B Company/CompanyLocation/Catalog/PriceList).
 * Discount collision: locked via the `extensions/discount-lock` Shopify
 * Function (cart.lines.discounts.generate.run) — see
 * docs/DISCOUNT-LOCK-PATTERN.md. The Function runs in a Wasm sandbox with
 * no API access, so it can only see what's in its GraphQL input; the lock
 * signal it reads is the `pricing_engine.locked` variant metafield, which
 * writeLockedPrice() below sets in the same operation as the fixed price.
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

const API_VERSION = "2026-07";

/** Namespace/key the discount-lock Shopify Function reads off the variant. Must match extensions/discount-lock. */
const LOCK_METAFIELD_NAMESPACE = "pricing_engine";
const LOCK_METAFIELD_KEY = "locked";

export interface ShopifyAdapterConfig {
    store: string; // "xxx.myshopify.com"
    adminToken: string; // shpat_... — read from env by the caller, never hardcoded
    priceListId: string; // active PriceList bound to a CompanyLocationCatalog, per tier
    /**
     * CompanyLocation gid per tier, needed for verifyPrice()'s contextualPricing
     * query — contextualPricing requires a companyLocationId, not a customerId
     * directly (confirmed live, SHOPIFY-SPIKE-2-PLUS-RESULTS.md section C).
     * Optional so existing configs that only write prices keep working; verifyPrice
     * reports "unavailable" for a tier with no entry here rather than throwing.
     */
    companyLocationIdByTier?: Partial<Record<CustomerTier, string>>;
}

export class ShopifyAdapter implements EcommercePlatformAdapter {
    readonly platformName = "shopify" as const;

    constructor(private config: ShopifyAdapterConfig) {}

    toPricingInput(product: PlatformProduct, customer: PlatformCustomer | undefined): PricingInput {
        if (!product.sku) {
            throw new Error(
                `ADAPTER GAP: variant ${product.platformVariantId} has no SKU; core.PricingInput.sku is required. ` +
                    `Shopify SKU is optional, core's identifier contract is not — this must be resolved at the ` +
                    `data-quality layer (require SKU on catalog import), not papered over here.`
            );
        }
        const tier = customer ? this.resolveTier(customer) : undefined;
        const input: PricingInput = {
            sku: product.sku,
            basePrice: product.basePrice,
            customerTier: tier,
            manufacturer: product.manufacturer,
            category: product.category,
        };
        if (product.salePrice) input.salePrice = product.salePrice;
        if (product.productMaxDiscountOverride) input.productMaxDiscount = product.productMaxDiscountOverride;
        return input;
    }

    resolveTier(customer: PlatformCustomer): CustomerTier | undefined {
        return determineTier(customer.totalSpend);
    }

    /**
     * Fails loud on both HTTP-level and GraphQL-protocol-level errors
     * (top-level `errors[]` — auth, throttling, syntax — distinct from a
     * mutation's own `userErrors`). Silently returning `json` here and
     * letting callers read `data?.foo?.userErrors ?? []` would hide a
     * top-level `errors` response as "no errors at all" — the exact
     * failure shape behind okfish-pricing-engine's INC-010 (a wrong
     * response-field assumption made a write pipeline silently no-op for
     * 12 days while every run reported success). One check here closes
     * that class of bug for every call site at once, instead of trusting
     * each call site to remember to check it.
     */
    private async graphql(query: string, variables: Record<string, unknown>): Promise<any> {
        const api = `https://${this.config.store}/admin/api/${API_VERSION}/graphql.json`;
        const res = await fetch(api, {
            method: "POST",
            headers: { "X-Shopify-Access-Token": this.config.adminToken, "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables }),
        });
        if (!res.ok) {
            throw new Error(`Shopify Admin API HTTP ${res.status}: ${await res.text().catch(() => "<unreadable body>")}`);
        }
        const json = await res.json();
        if (Array.isArray(json?.errors) && json.errors.length > 0) {
            throw new Error(`Shopify Admin API GraphQL errors: ${JSON.stringify(json.errors)}`);
        }
        return json;
    }

    /**
     * Removes a fixed price this call just wrote. Used only to undo a
     * half-completed write (price set, lock metafield failed) — per the
     * project's rollback-plan rule, a priced-but-unlocked line is worse
     * than no write at all, so it must not be left in that state.
     *
     * Returns whether the rollback itself actually succeeded — callers
     * must not claim "rolled back" without checking this. Assuming a
     * cleanup/rollback call succeeded just because it didn't throw is the
     * same silent-success-that-wasn't pattern as the primary write path;
     * a rollback that fails needs to be reported as its own, worse,
     * failure state, not swallowed.
     */
    private async rollbackFixedPrice(variantId: string): Promise<{ succeeded: boolean; error?: string }> {
        const mutation = `mutation($priceListId: ID!, $variantIds: [ID!]!) {
            priceListFixedPricesDelete(priceListId: $priceListId, variantIds: $variantIds) {
                deletedFixedPriceVariantIds
                userErrors { field message }
            }
        }`;
        try {
            const json = await this.graphql(mutation, { priceListId: this.config.priceListId, variantIds: [variantId] });
            const errors = json?.data?.priceListFixedPricesDelete?.userErrors ?? [];
            const deleted = json?.data?.priceListFixedPricesDelete?.deletedFixedPriceVariantIds ?? [];
            if (errors.length > 0 || !deleted.includes(variantId)) {
                return { succeeded: false, error: `rollback mutation returned no matching deletion: ${JSON.stringify({ errors, deleted })}` };
            }
            return { succeeded: true };
        } catch (e) {
            return { succeeded: false, error: e instanceof Error ? e.message : String(e) };
        }
    }

    /**
     * Writes the fixed price, then sets the pricing_engine.locked metafield
     * the discount-lock Shopify Function reads to veto further discounting
     * on this line (see extensions/discount-lock and
     * docs/DISCOUNT-LOCK-PATTERN.md). Both steps must succeed together —
     * a price write without the lock flag is exactly the unprotected state
     * SHOPIFY-SPIKE-2-PLUS-RESULTS.md section D found stacks with automatic
     * discounts, so a failed metafield write rolls the price back rather
     * than leaving that gap.
     */
    async writeLockedPrice(result: PricingResult, product: PlatformProduct, _tier: CustomerTier): Promise<WriteOutcome> {
        const priceMutation = `mutation($priceListId: ID!, $variantId: ID!, $amount: Decimal!, $currency: CurrencyCode!) {
            priceListFixedPricesAdd(priceListId: $priceListId, prices: [{variantId: $variantId, price: {amount: $amount, currencyCode: $currency}}]) {
                prices { price { amount currencyCode } variant { id } }
                userErrors { field message }
            }
        }`;
        const priceJson = await this.graphql(priceMutation, {
            priceListId: this.config.priceListId,
            variantId: product.platformVariantId,
            amount: result.finalPrice.toFixed(2),
            currency: product.currency,
        });
        const priceErrors = priceJson?.data?.priceListFixedPricesAdd?.userErrors ?? [];
        if (priceErrors.length > 0) {
            return { sku: result.sku, written: false, error: JSON.stringify(priceErrors) };
        }

        const metafieldMutation = `mutation($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
                metafields { id namespace key }
                userErrors { field message }
            }
        }`;
        const metafieldJson = await this.graphql(metafieldMutation, {
            metafields: [
                {
                    ownerId: product.platformVariantId,
                    namespace: LOCK_METAFIELD_NAMESPACE,
                    key: LOCK_METAFIELD_KEY,
                    type: "boolean",
                    value: "true",
                },
            ],
        });
        const metafieldErrors = metafieldJson?.data?.metafieldsSet?.userErrors ?? [];
        if (metafieldErrors.length > 0) {
            const rollback = await this.rollbackFixedPrice(product.platformVariantId);
            if (!rollback.succeeded) {
                // Worst case: price is live and unprotected, and the automated
                // rollback also failed. Must not be reported as "rolled back" —
                // that would be the exact silent-false-success pattern this
                // whole discount-lock effort exists to eliminate. Surface it
                // as loudly and specifically as possible for manual intervention.
                return {
                    sku: result.sku,
                    written: false,
                    error:
                        `MANUAL INTERVENTION REQUIRED: price ${result.finalPrice.toFixed(2)} is live and UNLOCKED on variant ` +
                        `${product.platformVariantId} (priceList ${this.config.priceListId}) — lock metafield write failed ` +
                        `(${JSON.stringify(metafieldErrors)}) AND the automatic rollback also failed (${rollback.error}).`,
                };
            }
            return {
                sku: result.sku,
                written: false,
                error: `price written but lock metafield failed, rolled back successfully: ${JSON.stringify(metafieldErrors)}`,
            };
        }

        return { sku: result.sku, written: true, platformRef: this.config.priceListId };
    }

    /**
     * Stage-5 reconciliation per docs/DISCOUNT-LOCK-PATTERN.md and the okfish
     * incident log (12-day silent pricing outage, INC-010): "the write API
     * call succeeded" and "the customer actually sees this price" are
     * different claims, and only re-querying the platform's own contextual
     * pricing resolution — not the write response — proves the second one.
     * Query shape confirmed live: SHOPIFY-SPIKE-2-PLUS-RESULTS.md section C,
     * ProductVariant.contextualPricing(companyLocationId).
     */
    async verifyPrice(sku: string, expected: Decimal, tier: CustomerTier): Promise<VerifyOutcome> {
        const companyLocationId = this.config.companyLocationIdByTier?.[tier];
        if (!companyLocationId) {
            return {
                sku,
                matchesExpected: false,
                method: "unavailable",
                note: `No companyLocationIdByTier entry configured for tier ${tier} — cannot resolve contextualPricing.`,
            };
        }

        const query = `query($sku: String!, $companyLocationId: ID!) {
            productVariants(first: 1, query: $sku) {
                nodes {
                    contextualPricing(context: { companyLocationId: $companyLocationId }) {
                        price { amount currencyCode }
                    }
                }
            }
        }`;
        const json = await this.graphql(query, { sku: `sku:${sku}`, companyLocationId });
        const node = json?.data?.productVariants?.nodes?.[0];
        const amount = node?.contextualPricing?.price?.amount;

        if (amount === undefined || amount === null) {
            return {
                sku,
                matchesExpected: false,
                method: "api-contextual",
                note: `No variant/contextualPricing result for sku ${sku} at companyLocationId ${companyLocationId}.`,
            };
        }

        const verifiedPrice = new Decimal(amount);
        return {
            sku,
            verifiedPrice,
            matchesExpected: verifiedPrice.equals(expected),
            method: "api-contextual",
        };
    }
}
