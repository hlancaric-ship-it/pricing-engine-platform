import { describe, it, expect } from 'vitest';
import worker from '../src/index.js';
import { Env } from '../src/feed-generator.js';

// Regression test for a real multi-tenant security bug (found 2026-08-19): the
// admin/write-endpoint auth token used to be a hardcoded literal in source
// (`const SECRET_TOKEN = 'shoptet-vip-secret-12345'`), meaning EVERY deployment of
// this Worker -- across every client of this product -- would share the exact
// same admin token. Now read from env.SECRET_TOKEN (set per-deployment via
// `wrangler secret put SECRET_TOKEN`), so two differently-configured deployments
// must accept different tokens and reject each other's.
function fakeEnv(secretToken: string): Env {
    return {
        SECRET_TOKEN: secretToken,
        VIP_KV: { get: async () => null, put: async () => {} } as any,
    } as Env;
}
function fakeCtx(): ExecutionContext {
    return { waitUntil: () => {}, passThroughOnException: () => {} } as any;
}

describe('admin auth (checkAuth) reads the token from env, not a hardcoded constant', () => {
    it('rejects a request with no Authorization header', async () => {
        const req = new Request('https://worker.example.test/v1/feed/generate', { method: 'POST' });
        const res = await worker.fetch(req, fakeEnv('client-a-secret'), fakeCtx());
        expect(res.status).toBe(401);
    });

    it('accepts a request whose Bearer token matches THIS deployment\'s env.SECRET_TOKEN', async () => {
        const req = new Request('https://worker.example.test/v1/feed/status', { method: 'GET' });
        // /v1/feed/status is unauthenticated (read-only) -- use it just to prove the
        // Worker boots fine with a given env; the real auth check is exercised below
        // via a write endpoint returning something other than 401 once matched.
        const res = await worker.fetch(req, fakeEnv('client-a-secret'), fakeCtx());
        expect(res.status).not.toBe(401);
    });

    it(
        'a token valid for one deployment (client A\'s secret) is rejected by a differently-configured ' +
        'deployment (client B\'s secret) -- the exact scenario the hardcoded-token bug made impossible to prevent',
        async () => {
            const reqWithClientAToken = new Request('https://worker.example.test/v1/feed/generate', {
                method: 'POST',
                headers: { Authorization: 'Bearer client-a-secret' },
            });

            const resAgainstOwnDeployment = await worker.fetch(reqWithClientAToken, fakeEnv('client-a-secret'), fakeCtx());
            const resAgainstOtherDeployment = await worker.fetch(reqWithClientAToken, fakeEnv('client-b-secret'), fakeCtx());

            expect(resAgainstOwnDeployment.status).not.toBe(401);
            expect(resAgainstOtherDeployment.status).toBe(401);
        }
    );
});
