/**
 * Creates the automatic discount using the discount-lock Function directly via
 * GraphQL Admin API — bypasses the embedded app UI entirely (app.application_url
 * is a placeholder, so the admin's Function-configuration page can't load).
 * Sets the pricing_engine.discount_config metafield in the same mutation.
 *
 * Usage: SHOPIFY_TOKEN=... FUNCTION_ID=... npx tsx spikes/shopify-adapter-spike/create-discount-via-api.ts
 * FUNCTION_ID: the discount-lock Function's id, find via:
 *   query { shopifyFunctions(first: 10) { nodes { id apiType title } } }
 */
const token = process.env.SHOPIFY_TOKEN;
const functionId = process.env.FUNCTION_ID;
if (!token) throw new Error("SHOPIFY_TOKEN env var required");
if (!functionId) throw new Error("FUNCTION_ID env var required (see script header for the query to find it)");

const store = "l-code-laboratory-tarif-plus.myshopify.com";

async function graphql(query: string, variables: Record<string, unknown>) {
    const res = await fetch(`https://${store}/admin/api/2026-07/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": token!, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
    });
    return res.json();
}

async function main() {
    const mutation = `mutation($discount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $discount) {
            automaticAppDiscount { discountId title }
            userErrors { field message }
        }
    }`;

    const result = await graphql(mutation, {
        discount: {
            title: "discount-lock test 10%",
            functionId,
            startsAt: new Date().toISOString(),
            discountClasses: ["ORDER"],
            combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
            metafields: [
                {
                    namespace: "pricing_engine",
                    key: "discount_config",
                    type: "json",
                    value: JSON.stringify({ type: "percentage", value: "10.0" }),
                },
            ],
        },
    });

    console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
    console.error("CHYBA:", e);
    process.exit(1);
});
