/**
 * Medusa Adapter Spike — LIVE write against a running local Medusa instance.
 * Reuses the already-confirmed core PricingResult (1000 -> 800.00, ZR20/20%)
 * from run-pricing.ts and writes it for real via writeOverridePrice(),
 * against a raw fetch-based Admin client (structurally matching the
 * MedusaAdminClient interface in client-types.ts, since @medusajs/js-sdk
 * is not a repo dependency -- see MEDUSA-SPIKE-RESULTS.md environment note).
 *
 * Usage: MEDUSA_ADMIN_TOKEN=... npx tsx spikes/medusa-adapter-spike/run-live-write.ts
 */
import { PricingEngine } from "../../src/core/PricingEngine.js";
import { BasePricePolicy } from "../../src/policies/BasePricePolicy.js";
import { HighestDiscountPolicy } from "../../src/policies/HighestDiscountPolicy.js";
import { DiscountLimitPolicy } from "../../src/policies/DiscountLimitPolicy.js";
import { RoundingPolicy } from "../../src/policies/RoundingPolicy.js";
import { TEST_PRODUCT, TEST_CUSTOMER } from "./test-fixture.js";
import { normalizeToInput, resolveCustomerTier } from "./normalizer.js";
import { writeOverridePrice } from "./writer.js";
import { CustomerTier } from "../../src/core/interfaces.js";
import Decimal from "decimal.js";
import { MedusaAdminClient } from "./client-types.js";

const BASE_URL = "http://localhost:9000";
const VARIANT_ID = "variant_01M01TZT0EHMPEREBQA4VT746D";
const CUSTOMER_GROUP_ID = "cusgroup_01M01V05V6S8JCFY53M350CX5J";
const CURRENCY = "czk";

function buildTestEngine(): PricingEngine {
    const engine = new PricingEngine();
    engine.use(new BasePricePolicy());
    engine.use(new HighestDiscountPolicy({ ZR20: new Decimal("0.2") }));
    engine.use(new DiscountLimitPolicy({}, {}));
    engine.use(new RoundingPolicy());
    engine.freeze();
    return engine;
}

// Minimal fetch-based implementation of the MedusaAdminClient interface
// used by writer.ts -- calls the real Admin REST routes documented by the
// real SDK's price-list.d.ts (create -> POST /admin/price-lists,
// batchPrices -> POST /admin/price-lists/:id/prices/batch).
function makeAdminClient(token: string): MedusaAdminClient {
    async function post(path: string, body: unknown) {
        const res = await fetch(`${BASE_URL}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(json)}`);
        return json;
    }
    async function get(path: string) {
        const res = await fetch(`${BASE_URL}${path}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json();
        if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(json)}`);
        return json;
    }
    return {
        admin: {
            priceList: {
                create: (body) => post("/admin/price-lists", body) as any,
                batchPrices: (id, body) => post(`/admin/price-lists/${id}/prices/batch`, body) as any,
                retrieve: (id) => get(`/admin/price-lists/${id}?fields=id,*prices`) as any,
            },
        },
    };
}

async function main() {
    const token = process.env.MEDUSA_ADMIN_TOKEN;
    if (!token) throw new Error("MEDUSA_ADMIN_TOKEN env var required");

    const engine = buildTestEngine();
    const tier = resolveCustomerTier(TEST_CUSTOMER) as CustomerTier;
    const input = normalizeToInput(TEST_PRODUCT, tier);
    input.allowLoyaltyDiscount = true;
    const result = engine.calculatePrice(input);
    console.log("Reused core PricingResult:", JSON.stringify({
        finalPrice: result.finalPrice.toString(),
        appliedRules: result.appliedRules,
    }));

    const sdk = makeAdminClient(token);
    const outcome = await writeOverridePrice(
        sdk,
        result,
        VARIANT_ID,
        CURRENCY,
        CUSTOMER_GROUP_ID,
        tier,
        { dryRun: false }
    );
    console.log("LIVE write outcome:", JSON.stringify(outcome, null, 2));
}

main().catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
});
