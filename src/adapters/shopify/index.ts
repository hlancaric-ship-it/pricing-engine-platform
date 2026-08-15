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
 * Discount collision: NOT locked by combinesWith alone — see
 * docs/DISCOUNT-LOCK-PATTERN.md for the required Shopify Function.
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

export interface ShopifyAdapterConfig {
    store: string; // "xxx.myshopify.com"
    adminToken: string; // shpat_... — read from env by the caller, never hardcoded
    priceListId: string; // active PriceList bound to a CompanyLocationCatalog, per tier
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

    async writeLockedPrice(result: PricingResult, product: PlatformProduct, _tier: CustomerTier): Promise<WriteOutcome> {
        const api = `https://${this.config.store}/admin/api/${API_VERSION}/graphql.json`;
        const mutation = `mutation($priceListId: ID!, $variantId: ID!, $amount: Decimal!, $currency: CurrencyCode!) {
            priceListFixedPricesAdd(priceListId: $priceListId, prices: [{variantId: $variantId, price: {amount: $amount, currencyCode: $currency}}]) {
                prices { price { amount currencyCode } variant { id } }
                userErrors { field message }
            }
        }`;
        const res = await fetch(api, {
            method: "POST",
            headers: { "X-Shopify-Access-Token": this.config.adminToken, "Content-Type": "application/json" },
            body: JSON.stringify({
                query: mutation,
                variables: {
                    priceListId: this.config.priceListId,
                    variantId: product.platformVariantId,
                    amount: result.finalPrice.toFixed(2),
                    currency: product.currency,
                },
            }),
        });
        const json: any = await res.json();
        const errors = json?.data?.priceListFixedPricesAdd?.userErrors ?? [];
        if (errors.length > 0) {
            return { sku: result.sku, written: false, error: JSON.stringify(errors) };
        }
        return { sku: result.sku, written: true, platformRef: this.config.priceListId };
    }

    async verifyPrice(sku: string, expected: Decimal, _tier: CustomerTier): Promise<VerifyOutcome> {
        // contextualPricing requires a companyLocationId, not a customerId directly
        // (SHOPIFY-DISCOVERY.md Spike 2 finding) — caller must resolve that first.
        // This is a placeholder signature; a real call needs the companyLocationId
        // threaded through, which the interface deliberately doesn't smuggle in
        // via a generic "context" bag — see note in docs/DISCOUNT-LOCK-PATTERN.md
        // about why platform-specific verification detail stays platform-specific.
        return {
            sku,
            matchesExpected: false,
            method: "unavailable",
            note:
                "ShopifyAdapter.verifyPrice needs a companyLocationId to call contextualPricing — " +
                "wire this through the caller (see SHOPIFY-SPIKE-2-PLUS-RESULTS.md section C for the verified query shape) " +
                "before treating this as implemented.",
        };
    }
}
