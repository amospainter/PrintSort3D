import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from './api';

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const { ok = true, status = 200 } = init;
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('api.listFiles', () => {
  it('requests /api/files with no query string when no params are given', async () => {
    const fetchMock = mockFetchOnce([]);
    await api.listFiles();
    expect(fetchMock).toHaveBeenCalledWith('/api/files', expect.anything());
  });

  it('builds a query string from provided params and omits empty ones', async () => {
    const fetchMock = mockFetchOnce([]);
    await api.listFiles({ query: 'cube', tags: [], ext: '.stl' });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/files?');
    expect(calledUrl).toContain('query=cube');
    expect(calledUrl).toContain('ext=.stl');
    expect(calledUrl).not.toContain('tags=');
  });

  it('joins multiple tags with a comma', async () => {
    const fetchMock = mockFetchOnce([]);
    await api.listFiles({ tags: ['red', 'vase'] });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain(`tags=${encodeURIComponent('red,vase')}`);
  });

  it('includes page and pageSize as numeric query params', async () => {
    const fetchMock = mockFetchOnce({ items: [], total: 0, page: 2, pageSize: 60, totalPages: 1 });
    await api.listFiles({ page: 2, pageSize: 60 });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('page=2');
    expect(calledUrl).toContain('pageSize=60');
  });

  it('resolves the paginated envelope shape', async () => {
    mockFetchOnce({ items: [{ id: 1 }], total: 1, page: 1, pageSize: 60, totalPages: 1 });
    const result = await api.listFiles();
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
  });
});

describe('api error handling', () => {
  it('throws an error including status and body text on a non-ok response', async () => {
    mockFetchOnce('file not found', { ok: false, status: 404 });
    await expect(api.getFile(999)).rejects.toThrow(/404/);
  });
});

describe('api.updateFile', () => {
  it('PATCHes the given file id with a JSON body', async () => {
    const fetchMock = mockFetchOnce({ id: 1, notes: 'hi', tags: [] });
    await api.updateFile(1, { notes: 'hi' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/files/1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ notes: 'hi' }) })
    );
  });
});

describe('api.rawFileUrl', () => {
  it('builds the raw file URL for a given id', () => {
    expect(api.rawFileUrl(42)).toBe('/api/raw/42');
  });
});
