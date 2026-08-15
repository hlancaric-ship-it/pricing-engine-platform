import { describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";
import { reconcilePrices, ReconciliationSelfCheckError, type ReconcilePriceEntry } from "../src/adapters/reconcile-prices.js";
import type { EcommercePlatformAdapter, VerifyOutcome } from "../src/adapters/types.js";

function fakeAdapter(verifyPrice: EcommercePlatformAdapter["verifyPrice"]): EcommercePlatformAdapter {
    return {
        platformName: "medusa",
        toPricingInput: vi.fn() as any,
        resolveTier: vi.fn() as any,
        writeLockedPrice: vi.fn() as any,
        verifyPrice,
    };
}

function entry(sku: string): ReconcilePriceEntry {
    return { sku, expected: new Decimal(800), tier: "ZR20" as any };
}

describe("reconcilePrices", () => {
    it("classifies matches, mismatches, and unavailable results", async () => {
        const outcomes: Record<string, VerifyOutcome> = {
            A: { sku: "A", verifiedPrice: new Decimal(800), matchesExpected: true, method: "cart" },
            B: { sku: "B", verifiedPrice: new Decimal(720), matchesExpected: false, method: "cart" },
            C: { sku: "C", matchesExpected: false, method: "unavailable" },
        };
        const adapter = fakeAdapter(async (sku) => outcomes[sku]);

        const report = await reconcilePrices(adapter, [entry("A"), entry("B"), entry("C")], { minExpectedChecks: 3 });

        expect(report.checked).toBe(3);
        expect(report.matches.map((o) => o.sku)).toEqual(["A"]);
        expect(report.mismatches.map((o) => o.sku)).toEqual(["B"]);
        expect(report.unavailable.map((o) => o.sku)).toEqual(["C"]);
    });

    it("throws ReconciliationSelfCheckError instead of reporting a clean result on too few checks", async () => {
        const adapter = fakeAdapter(async (sku) => ({ sku, verifiedPrice: new Decimal(800), matchesExpected: true, method: "cart" }));

        await expect(reconcilePrices(adapter, [entry("A")], { minExpectedChecks: 1000 })).rejects.toThrow(ReconciliationSelfCheckError);
    });

    it("does not throw the self-check error when the entry count meets the threshold, even if it's zero by design", async () => {
        const adapter = fakeAdapter(async (sku) => ({ sku, matchesExpected: true, method: "cart" }));

        const report = await reconcilePrices(adapter, [], { minExpectedChecks: 0 });

        expect(report.checked).toBe(0);
    });
});
