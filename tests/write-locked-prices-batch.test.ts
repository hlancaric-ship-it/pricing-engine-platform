import { describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";
import {
    writeLockedPricesBatch,
    BatchWriteFailedError,
    EmptyBatchError,
    type WriteLockedPriceEntry,
} from "../src/adapters/write-locked-prices-batch.js";
import type { EcommercePlatformAdapter, PlatformProduct } from "../src/adapters/types.js";
import type { PricingResult } from "../src/core/interfaces.js";

function product(sku: string): PlatformProduct {
    return { platformProductId: `p_${sku}`, platformVariantId: `v_${sku}`, sku, basePrice: new Decimal(1000), currency: "CZK" };
}

function entry(sku: string): WriteLockedPriceEntry {
    return { result: { sku, finalPrice: new Decimal(800) } as PricingResult, product: product(sku), tier: "ZR20" as any };
}

function fakeAdapter(writeLockedPrice: EcommercePlatformAdapter["writeLockedPrice"]): EcommercePlatformAdapter {
    return {
        platformName: "shopify",
        toPricingInput: vi.fn() as any,
        resolveTier: vi.fn() as any,
        writeLockedPrice,
        verifyPrice: vi.fn() as any,
    };
}

describe("writeLockedPricesBatch", () => {
    it("returns a report when every write succeeds", async () => {
        const adapter = fakeAdapter(async (result) => ({ sku: result.sku, written: true, platformRef: "pl_1" }));

        const report = await writeLockedPricesBatch(adapter, [entry("A"), entry("B")]);

        expect(report.total).toBe(2);
        expect(report.succeeded).toHaveLength(2);
        expect(report.failed).toHaveLength(0);
    });

    it("throws BatchWriteFailedError if even one write fails, listing all failures", async () => {
        const adapter = fakeAdapter(async (result) => ({
            sku: result.sku,
            written: result.sku !== "B",
            error: result.sku === "B" ? "boom" : undefined,
        }));

        await expect(writeLockedPricesBatch(adapter, [entry("A"), entry("B"), entry("C")])).rejects.toThrow(BatchWriteFailedError);

        try {
            await writeLockedPricesBatch(adapter, [entry("A"), entry("B")]);
            expect.unreachable();
        } catch (e) {
            expect(e).toBeInstanceOf(BatchWriteFailedError);
            const err = e as BatchWriteFailedError;
            expect(err.report.failed.map((f) => f.sku)).toEqual(["B"]);
            expect(err.message).toContain("B: boom");
        }
    });

    it("throws EmptyBatchError instead of silently succeeding on a zero-entry batch", async () => {
        const adapter = fakeAdapter(async () => ({ sku: "unused", written: true }));

        await expect(writeLockedPricesBatch(adapter, [])).rejects.toThrow(EmptyBatchError);
    });
});
