/**
 * Stage-5 reconciliation with self-check, ported conceptually (not code —
 * this is a new, platform-agnostic implementation, okfish-pricing-engine
 * itself was only read, never modified) from
 * okfish-pricing-engine's reconcile-pricelist-drift.ts / reconcile-coupon-drift.ts.
 *
 * The lesson this exists to apply, from that project's incident log:
 * "the write API call succeeded" and "the platform actually shows the
 * correct price" are different claims (INC-010: a wrong response-field
 * assumption silently broke pricing writes for 12 days while every sync run
 * reported success — 812/16705 products, ~4.9% of the catalog, ended up
 * wrong before anyone noticed). Only an independent re-derivation-and-diff
 * against live platform state — via verifyPrice(), never trusting the write
 * response — can catch that class of drift.
 *
 * The self-check half exists because okfish's own Stage-5 build needed two
 * iterations to get right: its first live run reported a falsely high
 * mismatch count from over-strict comparison, and the team explicitly
 * guarded against "0 alerts" being confused with "reconciliation checked
 * almost nothing" (a self-check bug is just as capable of hiding drift as
 * the original write bug). minExpectedChecks below is that same guard:
 * reconcilePrices() throws rather than returning a clean report if it
 * checked fewer entries than the caller says should have been checked.
 *
 * Platform-agnostic — works against any EcommercePlatformAdapter. Not part
 * of src/core: this is adapter-orchestration/verification, not pricing
 * logic, and it never writes — strictly read-only, matching okfish's own
 * discipline that reconciliation detects drift but does not auto-correct it.
 */
import Decimal from "decimal.js";
import { CustomerTier } from "../core/interfaces.js";
import { EcommercePlatformAdapter, VerifyOutcome } from "./types.js";

export interface ReconcilePriceEntry {
    sku: string;
    expected: Decimal;
    tier: CustomerTier;
}

export interface ReconciliationReport {
    checked: number;
    matches: VerifyOutcome[];
    mismatches: VerifyOutcome[];
    unavailable: VerifyOutcome[];
}

export class ReconciliationSelfCheckError extends Error {
    constructor(checked: number, minExpectedChecks: number) {
        super(
            `reconcilePrices: only checked ${checked} entries, expected at least ${minExpectedChecks}. ` +
                `Refusing to report a clean/summarized result — this is indistinguishable from the ` +
                `reconciliation itself being broken (e.g. an empty entry list, a misconfigured adapter ` +
                `that reports everything "unavailable") and silently checking nothing. If ` +
                `${checked} is genuinely the expected volume, lower minExpectedChecks explicitly ` +
                `rather than letting this pass by accident.`
        );
        this.name = "ReconciliationSelfCheckError";
    }
}

/**
 * Runs adapter.verifyPrice() for every entry and classifies the results.
 * Never writes anything — mismatches are reported, not corrected;
 * remediation is a separate, explicit decision by whoever calls this, same
 * as okfish's own reconcile-*-drift.ts discipline.
 *
 * Throws ReconciliationSelfCheckError if fewer than minExpectedChecks
 * entries were actually checked (i.e. entries.length < minExpectedChecks) —
 * this must be passed explicitly by the caller, who is the only one who
 * knows what volume is plausible for a given run.
 */
export async function reconcilePrices(
    adapter: EcommercePlatformAdapter,
    entries: ReconcilePriceEntry[],
    opts: { minExpectedChecks: number }
): Promise<ReconciliationReport> {
    if (entries.length < opts.minExpectedChecks) {
        throw new ReconciliationSelfCheckError(entries.length, opts.minExpectedChecks);
    }

    const outcomes = await Promise.all(entries.map((e) => adapter.verifyPrice(e.sku, e.expected, e.tier)));

    const matches = outcomes.filter((o) => o.matchesExpected);
    const unavailable = outcomes.filter((o) => o.method === "unavailable");
    const mismatches = outcomes.filter((o) => !o.matchesExpected && o.method !== "unavailable");

    return { checked: entries.length, matches, mismatches, unavailable };
}
