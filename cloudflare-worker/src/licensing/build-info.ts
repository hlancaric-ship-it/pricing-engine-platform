import { buildLicenseFingerprint } from './fingerprint';

// Per-deployment values -- set these BEFORE `wrangler deploy` for a specific
// client, and never reuse the same CLIENT_LICENSE_ID across two different
// clients' deployments (that would collapse two clients onto one
// fingerprint, defeating the point). Bump BUILD_VERSION on each release so
// the fingerprint also pins which build a client is running.
export const CLIENT_LICENSE_ID = 'REPLACE_WITH_CLIENT_LICENSE_ID';
export const BUILD_VERSION = '1.0.0';

/** Exposed transparently (e.g. response header) -- see cloudflare-worker/src/index.ts. */
export const LICENSE_FINGERPRINT = buildLicenseFingerprint(CLIENT_LICENSE_ID, BUILD_VERSION);
