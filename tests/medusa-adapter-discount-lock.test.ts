import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import Decimal from "decimal.js";
import { MedusaAdapter, type MedusaAdminClient, type MedusaPromotion } from "../src/adapters/medusa/index.js";
import type { CustomerTier } from "../src/core/interfaces.js";

function ok(body: unknown) {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

const customerGroupIdByTier = {
    ZR4: "cg_zr4",
    ZR6: "cg_zr6",
    ZR8: "cg_zr8",
    ZR10: "cg_zr10",
    ZR12: "cg_zr12",
    ZR14: "cg_zr14",
    ZR16: "cg_zr16",
    ZR18: "cg_zr18",
    ZR20: "cg_zr20",
    ZR25: "cg_zr25",
} as Record<CustomerTier, string>;

function mockSdk(opts: { activeTiers: CustomerTier[]; promotions?: MedusaPromotion[] }): MedusaAdminClient {
    return {
        admin: {
            priceList: {
                list: vi.fn(async ({ title }: { title: string }) => {
                    const tier = opts.activeTiers.find((t) => title === `okfish-pricing-engine — ${t}`);
                    return { price_lists: tier ? [{ id: `pl_${tier}`, title }] : [] };
                }),
                create: vi.fn(),
                batchPrices: vi.fn(),
            },
            promotion: {
                list: vi.fn(async () => ({ promotions: opts.promotions ?? [] })),
                create: vi.fn(async (payload: Record<string, unknown>) => ({
                    promotion: { id: "promo_1", code: payload.code as string, status: "active", rules: payload.rules as any },
                })),
            },
            product: {
                list: vi.fn(async () => ({ products: [{ variants: [{ id: "variant_1", sku: "SKU-1" }] }] })),
            },
        },
    };
}

describe("MedusaAdapter.createLockedPromotion", () => {
    it("excludes customer groups of every tier with an active override PriceList", async () => {
        const sdk = mockSdk({ activeTiers: ["ZR20", "ZR25"] });
        const adapter = new MedusaAdapter({ sdk, customerGroupIdByTier });

        const { promotionId, excludedGroupIds } = await adapter.createLockedPromotion({
            code: "SPRING10",
            type: "percentage",
            value: 10,
            targetType: "order",
        });

        expect(promotionId).toBe("promo_1");
        expect(excludedGroupIds.sort()).toEqual(["cg_zr20", "cg_zr25"].sort());
        expect(sdk.admin.promotion.create).toHaveBeenCalledWith(
            expect.objectContaining({
                rules: [{ attribute: "customer.groups.id", operator: "ne", values: expect.arrayContaining(["cg_zr20", "cg_zr25"]) }],
            })
        );
    });

    it("creates an unscoped promotion (no rules) when no tier is currently locked", async () => {
        const sdk = mockSdk({ activeTiers: [] });
        const adapter = new MedusaAdapter({ sdk, customerGroupIdByTier });

        const { excludedGroupIds } = await adapter.createLockedPromotion({
            code: "SPRING10",
            type: "percentage",
            value: 10,
            targetType: "order",
        });

        expect(excludedGroupIds).toEqual([]);
        expect(sdk.admin.promotion.create).toHaveBeenCalledWith(expect.objectContaining({ rules: [] }));
    });
});

describe("MedusaAdapter.auditPromotionCollisions", () => {
    it("flags a global promotion (no customer.groups.id rule) when a tier is locked", async () => {
        const sdk = mockSdk({
            activeTiers: ["ZR20"],
            promotions: [{ id: "promo_bad", code: "GENERIC10", status: "active", rules: [] }],
        });
        const adapter = new MedusaAdapter({ sdk, customerGroupIdByTier });

        const collisions = await adapter.auditPromotionCollisions();

        expect(collisions).toEqual([{ promotionId: "promo_bad", code: "GENERIC10", collidesWithGroupIds: ["cg_zr20"] }]);
    });

    it("does not flag a promotion that already excludes the locked tier's group", async () => {
        const sdk = mockSdk({
            activeTiers: ["ZR20"],
            promotions: [
                {
                    id: "promo_ok",
                    code: "SAFE10",
                    status: "active",
                    rules: [{ attribute: "customer.groups.id", operator: "ne", values: ["cg_zr20"] }],
                },
            ],
        });
        const adapter = new MedusaAdapter({ sdk, customerGroupIdByTier });

        const collisions = await adapter.auditPromotionCollisions();

        expect(collisions).toEqual([]);
    });

    it("returns no collisions when no tier is currently locked", async () => {
        const sdk = mockSdk({
            activeTiers: [],
            promotions: [{ id: "promo_x", code: "ANY", status: "active", rules: [] }],
        });
        const adapter = new MedusaAdapter({ sdk, customerGroupIdByTier });

        expect(await adapter.auditPromotionCollisions()).toEqual([]);
    });
});

describe("MedusaAdapter.verifyPrice — Stage-5 reconciliation", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function adapterWithStoreApi() {
        const sdk = mockSdk({ activeTiers: ["ZR20"] });
        return new MedusaAdapter({
            sdk,
            customerGroupIdByTier,
            storeApi: {
                storeUrl: "https://test.medusajs.app",
                publishableApiKey: "pk_test",
                regionId: "reg_1",
                verificationCustomerIdByTier: { ZR20: "cus_1" },
            },
        });
    }

    it("builds a cart, adds the line item, reads unit_price, and cleans up", async () => {
        fetchMock
            .mockResolvedValueOnce(ok(({ cart: { id: "cart_1" } })))
            .mockResolvedValueOnce(ok(({ cart: { items: [{ variant_id: "variant_1", unit_price: 800 }] } })))
            .mockResolvedValueOnce(ok(({})));

        const outcome = await adapterWithStoreApi().verifyPrice("SKU-1", new Decimal(800), "ZR20" as any);

        expect(outcome.matchesExpected).toBe(true);
        expect(outcome.method).toBe("cart");
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls[2][0]).toBe("https://test.medusajs.app/store/carts/cart_1");
        expect(fetchMock.mock.calls[2][1].method).toBe("DELETE");
    });

    it("flags a mismatch when the cart's resolved unit_price differs (a promotion stacked)", async () => {
        fetchMock
            .mockResolvedValueOnce(ok(({ cart: { id: "cart_1" } })))
            .mockResolvedValueOnce(ok(({ cart: { items: [{ variant_id: "variant_1", unit_price: 720 }] } })))
            .mockResolvedValueOnce(ok(({})));

        const outcome = await adapterWithStoreApi().verifyPrice("SKU-1", new Decimal(800), "ZR20" as any);

        expect(outcome.matchesExpected).toBe(false);
        expect(outcome.verifiedPrice?.toString()).toBe("720");
    });

    it("reports unavailable when storeApi isn't configured", async () => {
        const sdk = mockSdk({ activeTiers: [] });
        const adapter = new MedusaAdapter({ sdk, customerGroupIdByTier });

        const outcome = await adapter.verifyPrice("SKU-1", new Decimal(800), "ZR20" as any);

        expect(outcome.method).toBe("unavailable");
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
