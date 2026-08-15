import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import Decimal from "decimal.js";
import { ShopifyAdapter } from "../src/adapters/shopify/index.js";
import type { PlatformProduct } from "../src/adapters/types.js";
import type { PricingResult } from "../src/core/interfaces.js";

const product: PlatformProduct = {
    platformProductId: "gid://shopify/Product/1",
    platformVariantId: "gid://shopify/ProductVariant/1",
    sku: "SKU-1",
    basePrice: new Decimal(1000),
    currency: "CZK",
};

const result: PricingResult = {
    sku: "SKU-1",
    finalPrice: new Decimal(800),
} as PricingResult;

/** Minimal real-fetch-shaped mock response — the adapter checks res.ok before res.json(). */
function ok(body: unknown) {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function adapter() {
    return new ShopifyAdapter({
        store: "test.myshopify.com",
        adminToken: "shpat_test",
        priceListId: "gid://shopify/PriceList/1",
        companyLocationIdByTier: { ZR20: "gid://shopify/CompanyLocation/1" } as any,
    });
}

describe("ShopifyAdapter.writeLockedPrice — discount-lock metafield", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("writes the fixed price then sets the pricing_engine.locked metafield", async () => {
        fetchMock
            .mockResolvedValueOnce(ok(({ data: { priceListFixedPricesAdd: { prices: [{}], userErrors: [] } } })))
            .mockResolvedValueOnce(ok(({ data: { metafieldsSet: { metafields: [{ id: "1" }], userErrors: [] } } })));

        const outcome = await adapter().writeLockedPrice(result, product, "ZR20" as any);

        expect(outcome.written).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [, metafieldCall] = fetchMock.mock.calls;
        const body = JSON.parse(metafieldCall[1].body);
        expect(body.query).toContain("metafieldsSet");
        expect(body.variables.metafields[0]).toMatchObject({
            ownerId: product.platformVariantId,
            namespace: "pricing_engine",
            key: "locked",
            value: "true",
        });
    });

    it("rolls back the fixed price if the lock metafield write fails", async () => {
        fetchMock
            .mockResolvedValueOnce(ok(({ data: { priceListFixedPricesAdd: { prices: [{}], userErrors: [] } } })))
            .mockResolvedValueOnce(ok(({
                    data: { metafieldsSet: { metafields: [], userErrors: [{ field: ["value"], message: "boom" }] } },
                })))
            .mockResolvedValueOnce(ok(({
                    data: { priceListFixedPricesDelete: { deletedFixedPriceVariantIds: [product.platformVariantId], userErrors: [] } },
                })));

        const outcome = await adapter().writeLockedPrice(result, product, "ZR20" as any);

        expect(outcome.written).toBe(false);
        expect(outcome.error).toContain("rolled back");
        expect(fetchMock).toHaveBeenCalledTimes(3);
        const rollbackCall = fetchMock.mock.calls[2];
        const rollbackBody = JSON.parse(rollbackCall[1].body);
        expect(rollbackBody.query).toContain("priceListFixedPricesDelete");
    });

    it("does not attempt the metafield write if the price write itself fails", async () => {
        fetchMock.mockResolvedValueOnce(ok(({ data: { priceListFixedPricesAdd: { prices: [], userErrors: [{ field: ["price"], message: "bad" }] } } })));

        const outcome = await adapter().writeLockedPrice(result, product, "ZR20" as any);

        expect(outcome.written).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe("ShopifyAdapter.verifyPrice — Stage-5 reconciliation", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("matches when contextualPricing returns the expected amount", async () => {
        fetchMock.mockResolvedValueOnce(ok(({
                data: { productVariants: { nodes: [{ contextualPricing: { price: { amount: "800.0", currencyCode: "CZK" } } }] } },
            })));

        const outcome = await adapter().verifyPrice("SKU-1", new Decimal(800), "ZR20" as any);

        expect(outcome.matchesExpected).toBe(true);
        expect(outcome.method).toBe("api-contextual");
        expect(outcome.verifiedPrice?.toString()).toBe("800");
    });

    it("flags a mismatch when contextualPricing returns a different (discounted) amount", async () => {
        fetchMock.mockResolvedValueOnce(ok(({
                data: { productVariants: { nodes: [{ contextualPricing: { price: { amount: "720.0", currencyCode: "CZK" } } }] } },
            })));

        const outcome = await adapter().verifyPrice("SKU-1", new Decimal(800), "ZR20" as any);

        expect(outcome.matchesExpected).toBe(false);
        expect(outcome.verifiedPrice?.toString()).toBe("720");
    });

    it("reports unavailable when no companyLocationId is configured for the tier", async () => {
        const outcome = await adapter().verifyPrice("SKU-1", new Decimal(800), "ZR4" as any);

        expect(outcome.method).toBe("unavailable");
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
