/**
 * Shopify Adapter Spike — Writer
 * PricingResult -> Shopify PriceList fixed-price write. No pricing logic here,
 * only a thin GraphQL call. Token is read from env, never hardcoded/logged.
 */
import { PricingResult } from "../../src/core/interfaces.js";

const API_VERSION = "2026-07";

export interface WriteOutcome {
    sku: string;
    written: boolean;
    platformRef?: string;
    error?: string;
}

export async function writeFixedPrice(
    result: PricingResult,
    variantGid: string,
    priceListId: string,
    currencyCode: string,
    store: string,
    token: string
): Promise<WriteOutcome> {
    const api = `https://${store}/admin/api/${API_VERSION}/graphql.json`;
    const mutation = `mutation($priceListId: ID!, $variantId: ID!, $amount: Decimal!, $currency: CurrencyCode!) {
        priceListFixedPricesAdd(priceListId: $priceListId, prices: [{variantId: $variantId, price: {amount: $amount, currencyCode: $currency}}]) {
            prices { price { amount currencyCode } variant { id } }
            userErrors { field message }
        }
    }`;
    const res = await fetch(api, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({
            query: mutation,
            variables: {
                priceListId,
                variantId: variantGid,
                amount: result.finalPrice.toFixed(2),
                currency: currencyCode,
            },
        }),
    });
    const json: any = await res.json();
    const errors = json?.data?.priceListFixedPricesAdd?.userErrors ?? [];
    if (errors.length > 0) {
        return { sku: result.sku, written: false, error: JSON.stringify(errors) };
    }
    return { sku: result.sku, written: true, platformRef: priceListId };
}
