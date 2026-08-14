/**
 * Minimal structural type for the pieces of @medusajs/js-sdk's Admin client
 * this spike touches. Not the real SDK (not added as a repo dependency —
 * see MEDUSA-SPIKE-RESULTS.md environment section for why), but the shapes
 * here are copied verbatim from the installed, real package
 * (@medusajs/js-sdk 2.19.0 dist/esm/admin/price-list.d.ts and
 * @medusajs/types 2.19.0 dist/http/price-list/admin/payloads.d.ts) so this
 * compiles against the real contract, not an invented one.
 */
export interface AdminCreatePriceListPrice {
    currency_code: string;
    amount: number;
    variant_id: string;
    min_quantity?: number | null;
    max_quantity?: number | null;
    rules?: Record<string, string>;
}

export interface AdminCreatePriceList {
    title: string;
    description: string;
    starts_at?: string | null;
    ends_at?: string | null;
    status?: "draft" | "active";
    type?: "sale" | "override";
    rules?: Record<string, string[]>;
    prices?: AdminCreatePriceListPrice[];
    metadata?: Record<string, unknown> | null;
}

export interface AdminUpdatePriceListPrice {
    id: string;
    currency_code?: string;
    amount?: number;
    variant_id: string;
    rules?: Record<string, string>;
}

export interface AdminBatchPriceListPrice {
    create?: AdminCreatePriceListPrice[];
    update?: AdminUpdatePriceListPrice[];
    delete?: string[];
}

export interface MedusaAdminClient {
    admin: {
        priceList: {
            create(body: AdminCreatePriceList): Promise<{ price_list: { id: string; prices?: { id: string; amount: number }[] } }>;
            batchPrices(id: string, body: AdminBatchPriceListPrice): Promise<{ created: { id: string; amount: number }[]; updated: unknown[]; deleted: string[] }>;
            retrieve(id: string): Promise<{ price_list: { id: string; prices?: { id: string; amount: number; rules_count?: number }[] } }>;
        };
    };
}
