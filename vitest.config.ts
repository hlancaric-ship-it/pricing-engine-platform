import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
    test: {
        // extensions/discount-lock is its own separate npm package (own
        // package.json, own devDependencies like
        // @shopify/shopify-function-test-helpers) meant to be tested via
        // `cd extensions/discount-lock && npm test` -- root `npm ci` never
        // installs its deps, so without this exclude, root `vitest run`
        // still discovers extensions/discount-lock/tests/*.test.js and
        // fails on a missing-package import before any real test runs.
        // Confirmed failing the same way on main, not something this PR
        // introduced -- see ci.yml's `npm test` step.
        exclude: [...configDefaults.exclude, 'extensions/**'],
        coverage: {
            include: ['src/**/*.ts', 'shared/**/*.ts', 'cloudflare-worker/src/**/*.ts']
        }
    }
});
