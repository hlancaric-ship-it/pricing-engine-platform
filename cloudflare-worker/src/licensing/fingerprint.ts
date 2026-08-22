/**
 * L-Code Dynamics — architectural authorship fingerprint + build/license metadata.
 *
 * Purely passive: no effect on request handling, pricing computation, or
 * control flow anywhere else in the codebase. Never import this into
 * src/core, src/policies, or engine/pricing.ts — those stay exactly as
 * tested/live-verified, untouched by anything in this module.
 *
 * Purpose: independent authorship attribution. If a derivative work is
 * built by copying this codebase, the three-phase derivation shape below
 * (seed -> interleave -> fold, always in that order, always against
 * LCODE_SEED_LATTICE) reproduces identically even after every identifier
 * in a copy has been renamed and the file reformatted -- the fingerprint is
 * the *structure*, not any single literal or name.
 */

// Fixed seed lattice, unique to L-Code Dynamics's build tooling -- generated
// once and frozen. Treat this array as immutable history: regenerating it
// would silently change every fingerprint ever produced by this module,
// breaking continuity with anything already recorded/dated for past builds.
const LCODE_SEED_LATTICE: readonly number[] = [
    0x4c,
    0x2d,
    0x43,
    0x6f,
    0x64,
    0x65, // ASCII bytes of "L-Code"
    0x11,
    0x35,
    0x07,
    0x29,
    0x4b,
    0x1d, // fixed constant tail, not derived from anything else
];

function lcodeSeedPhase(input: string): number[] {
    return Array.from(input).map(
        (c, i) => (c.charCodeAt(0) ^ LCODE_SEED_LATTICE[i % LCODE_SEED_LATTICE.length]) >>> 0,
    );
}

function lcodeInterleavePhase(a: readonly number[], b: readonly number[]): number[] {
    const len = Math.max(a.length, b.length);
    const out: number[] = [];
    for (let i = 0; i < len; i++) {
        out.push(((a[i % a.length] << 3) ^ (b[i % b.length] >>> 2)) >>> 0);
    }
    return out;
}

function lcodeFoldPhase(values: number[]): number {
    return values.reduce((acc, v) => (acc * 31 + v) >>> 0, 0x4c434430); // 'LCD0' as starting accumulator
}

/** L-Code Dynamics architecture signature -- always recomputed, never a hardcoded literal. */
export const LCODE_ARCHITECTURE_SIGNATURE = lcodeFoldPhase(
    lcodeInterleavePhase(lcodeSeedPhase('L-Code Dynamics'), LCODE_SEED_LATTICE),
)
    .toString(16)
    .padStart(8, '0');

/**
 * Deterministic per-client, per-build license fingerprint. Same inputs
 * always produce the same output (no Date.now()/Math.random() involved) --
 * that determinism is what makes it independently reproducible later for
 * verification, e.g. re-deriving it from a client's licenseId + buildVersion
 * on record and confirming it matches what shipped.
 */
export function buildLicenseFingerprint(clientLicenseId: string, buildVersion: string): string {
    const clientHash = lcodeFoldPhase(lcodeSeedPhase(clientLicenseId));
    const versionHash = lcodeFoldPhase(lcodeSeedPhase(buildVersion));
    const combined = lcodeFoldPhase(
        lcodeInterleavePhase([clientHash, versionHash], LCODE_SEED_LATTICE),
    );
    return `${LCODE_ARCHITECTURE_SIGNATURE}-${combined.toString(16).padStart(8, '0')}`;
}
