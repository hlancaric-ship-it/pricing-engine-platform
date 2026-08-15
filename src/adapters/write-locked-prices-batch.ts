/**
 * Stage-4 fail-closed batch writer, per docs/DISCOUNT-LOCK-PATTERN.md and the
 * okfish-pricing-engine incident log (INC-006, INC-010, INC-011): a batch of
 * writes where some entries silently fail must never be reported the same
 * way as a batch where everything succeeded. This is the class of bug behind
 * every incident in that log except one (INC-004, a pure pricing-logic bug,
 * not this class) — a `catch` that logs and returns instead of throwing, an
 * early `return` that skips a whole branch, a response-shape assumption that
 * was silently wrong for every call — all four produced a "SUCCESS" the
 * calling pipeline believed, while the real-world write didn't happen.
 *
 * This function is the single point where that can't happen for
 * writeLockedPrice(): it always throws on any partial failure, carrying the
 * full list of failures, and it always throws on an empty batch too — a
 * batch that "succeeds" because nothing was in it is the same
 * looks-fine-but-did-nothing shape as the rest of this bug class, not a
 * legitimate success.
 *
 * Platform-agnostic — works against any EcommercePlatformAdapter. Not part
 * of src/core: this is adapter-orchestration, not pricing logic.
 */
import { CustomerTier, PricingResult } from "../core/interfaces.js";
import { EcommercePlatformAdapter, PlatformProduct, WriteOutcome } from "./types.js";

export interface WriteLockedPriceEntry {
    result: PricingResult;
    product: PlatformProduct;
    tier: CustomerTier;
}

export interface BatchWriteReport {
    total: number;
    succeeded: WriteOutcome[];
    failed: WriteOutcome[];
}

export class BatchWriteFailedError extends Error {
    constructor(public readonly report: BatchWriteReport) {
        super(
            `writeLockedPricesBatch: ${report.failed.length}/${report.total} writes failed — ` +
                report.failed.map((f) => `${f.sku}: ${f.error}`).join("; ")
        );
        this.name = "BatchWriteFailedError";
    }
}

export class EmptyBatchError extends Error {
    constructor() {
        super(
            "writeLockedPricesBatch: called with zero entries. A batch that processes nothing " +
                "must not be treated as a successful no-op — that is the same silent-success shape " +
                "as a batch where every write failed but nothing threw. If zero entries is genuinely " +
                "expected (e.g. no products changed this run), the caller must decide that explicitly " +
                "before calling this function, not rely on it accepting an empty list quietly."
        );
        this.name = "EmptyBatchError";
    }
}

/**
 * Writes every entry via adapter.writeLockedPrice(), then throws
 * (fail-closed) if any entry failed or if the batch was empty. On success,
 * returns the full report — callers that need per-entry detail on a
 * successful batch still get it, this isn't a black box.
 */
export async function writeLockedPricesBatch(
    adapter: EcommercePlatformAdapter,
    entries: WriteLockedPriceEntry[]
): Promise<BatchWriteReport> {
    if (entries.length === 0) {
        throw new EmptyBatchError();
    }

    const outcomes = await Promise.all(entries.map((e) => adapter.writeLockedPrice(e.result, e.product, e.tier)));

    const succeeded = outcomes.filter((o) => o.written);
    const failed = outcomes.filter((o) => !o.written);
    const report: BatchWriteReport = { total: entries.length, succeeded, failed };

    if (failed.length > 0) {
        throw new BatchWriteFailedError(report);
    }

    return report;
}
