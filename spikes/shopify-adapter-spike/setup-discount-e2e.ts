/**
 * One-shot: exchange OAuth code -> token, find the discount-lock Function id,
 * create the automatic discount with pricing_engine.discount_config metafield.
 * Usage: CODE=... npx tsx spikes/shopify-adapter-spike/setup-discount-e2e.ts
 */
const store = "l-code-laboratory-tarif-plus.myshopify.com";
const clientId = "750ef67721f14bb578327045e4b6f358";
const clientSecret = "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";
const code = process.env.CODE;
if (!code) throw new Error("CODE env var required (the OAuth code= from the redirect URL)");

async function main() {
    const tokenRes = await fetch(`https://${store}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const tokenJson: any = await tokenRes.json();
    if (!tokenJson.access_token) {
        console.error("Token exchange failed:", JSON.stringify(tokenJson));
        process.exit(1);
    }
    const token = tokenJson.access_token;
    console.log("Got token:", token.slice(0, 8) + "...");

    async function graphql(query: string, variables: Record<string, unknown> = {}) {
        const res = await fetch(`https://${store}/admin/api/2026-07/graphql.json`, {
            method: "POST",
            headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables }),
        });
        return res.json();
    }

    const fnRes: any = await graphql(`{ shopifyFunctions(first: 10) { nodes { id apiType title } } }`);
    console.log("Functions:", JSON.stringify(fnRes.data?.shopifyFunctions?.nodes));
    const fn = fnRes.data?.shopifyFunctions?.nodes?.find((n: any) => n.apiType === "discount");
    if (!fn) {
        console.error("No discount function found:", JSON.stringify(fnRes));
        process.exit(1);
    }
    // UUID-shaped id (not numeric) -- unlike most Admin GraphQL ids, use it raw,
    // not gid://shopify/Function/-wrapped (that wrapping caused "not found" errors).
    const functionId = fn.id;

    const mutation = `mutation($discount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $discount) {
            automaticAppDiscount { discountId title }
            userErrors { field message }
        }
    }`;
    const result: any = await graphql(mutation, {
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
    console.log("Discount create result:", JSON.stringify(result, null, 2));
}

main().catch((e) => {
    console.error("CHYBA:", e);
    process.exit(1);
});
