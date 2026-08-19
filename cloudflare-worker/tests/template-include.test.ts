import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShoptetApiClient } from '../src/shoptet-api/client.js';

function jsonResponse(status: number, body: any): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        url: 'https://api.myshoptet.com/api/template-include',
        headers: new Headers(),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

describe('ShoptetApiClient template-include (header script automation)', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('getTemplateIncludes returns the addon-owned snippets array', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, {
            data: { snippets: [{ location: 'common-header', html: '<script src="x.js"></script>' }] },
        }));
        const client = new ShoptetApiClient('fake-token');

        const result = await client.getTemplateIncludes();

        expect(result).toEqual([{ location: 'common-header', html: '<script src="x.js"></script>' }]);
    });

    it('setTemplateInclude POSTs the snippet payload to /template-include', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { snippets: [] } }));
        const client = new ShoptetApiClient('fake-token');

        await client.setTemplateInclude('common-header', '<script src="x.js"></script>');

        const [url, requestInit] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.myshoptet.com/api/template-include');
        expect(requestInit.method).toBe('POST');
        expect(JSON.parse(requestInit.body)).toEqual({
            data: { snippets: [{ location: 'common-header', html: '<script src="x.js"></script>' }] },
        });
    });

    it('setTemplateInclude refuses to send a snippet over the 8192-char Shoptet limit', async () => {
        const client = new ShoptetApiClient('fake-token');
        const tooLong = 'x'.repeat(8193);

        await expect(client.setTemplateInclude('common-header', tooLong)).rejects.toThrow(/8192/);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
