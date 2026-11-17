import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpotifyClient, SpotifyError, pickLargestImage } from '../src/core/spotify';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
    headers: { get: () => 'application/json' },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SpotifyClient', () => {
  it('is not configured without credentials', async () => {
    const client = new SpotifyClient('', '');
    expect(client.isConfigured).toBe(false);
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(SpotifyError);
  });

  it('requests a token with the client credentials flow', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: 'token123', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new SpotifyClient('id', 'secret');
    const token = await client.getAccessToken();
    expect(token).toBe('token123');

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const url = call[0];
    const init = call[1];
    expect(url).toBe('https://accounts.spotify.com/api/token');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const body = String(init.body);
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=id');
    expect(body).toContain('client_secret=secret');
  });

  it('uses the token for the search request and caches it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token123', expires_in: 3600 }))
      .mockResolvedValueOnce(
        jsonResponse({
          tracks: {
            items: [
              {
                id: 'abc',
                name: 'Voices of Spring',
                artists: [{ name: 'André Rieu' }],
                album: {
                  name: 'Album',
                  images: [
                    { url: 'small', height: 64, width: 64 },
                    { url: 'large', height: 640, width: 640 },
                  ],
                },
              },
            ],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new SpotifyClient('id', 'secret');
    const track = await client.searchTrack('Voices of Spring', 'André Rieu');
    expect(track?.name).toBe('Voices of Spring');
    expect(track?.artists).toEqual(['André Rieu']);
    // the biggest cover is used, like in the python tool
    expect(track?.image?.url).toBe('large');

    const call = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const url = call[0];
    const init = call[1];
    expect(url).toContain('https://api.spotify.com/v1/search?');
    expect(url).toContain('type=track');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token123');

    // a second search must not request a new token
    fetchMock.mockResolvedValueOnce(jsonResponse({ tracks: { items: [] } }));
    await client.searchTrack('nothing', 'nobody');
    const tokenCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('accounts.spotify.com'),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it('passes the job signal to every request', async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token123', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ tracks: { items: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new SpotifyClient('id', 'secret');
    client.signal = controller.signal;
    await client.searchTrack('T', 'A');

    expect(fetchMock.mock.calls).toHaveLength(2);
    for (const call of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[1].signal).toBe(controller.signal);
    }
  });

  it('rethrows an abort instead of turning it into a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was cancelled.', 'AbortError');
      }),
    );
    const client = new SpotifyClient('id', 'secret');
    await expect(client.getAccessToken()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('explains invalid credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: 'invalid_client', error_description: 'Invalid client' }, 400),
      ),
    );
    const client = new SpotifyClient('id', 'wrong');
    await expect(client.getAccessToken()).rejects.toThrow(/client id \/ client secret/);
  });

  it('reports rate limits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'rate_limit' }, 429)),
    );
    const client = new SpotifyClient('id', 'secret');
    await expect(client.getAccessToken()).rejects.toThrow(/rate limit/i);
  });

  it('downloads the cover art', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token123', expires_in: 3600 }))
      .mockResolvedValueOnce(
        jsonResponse({
          tracks: {
            items: [
              {
                id: 'abc',
                name: 'T',
                artists: [{ name: 'A' }],
                album: { name: 'Al', images: [{ url: 'https://i.scdn.co/image/x', height: 640 }] },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        headers: { get: () => 'image/jpeg' },
      } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const client = new SpotifyClient('id', 'secret');
    const cover = await client.findCover('T', 'A');
    expect(cover?.mime).toBe('image/jpeg');
    expect([...(cover?.data ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it('returns null when nothing is found', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token123', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ tracks: { items: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new SpotifyClient('id', 'secret');
    expect(await client.findCover('T', 'A')).toBeNull();
  });
});

describe('pickLargestImage', () => {
  it('sorts by height', () => {
    const image = pickLargestImage([
      { url: 'a', height: 100, width: 100 },
      { url: 'b', height: 640, width: 640 },
      { url: 'c', height: 300, width: 300 },
    ]);
    expect(image?.url).toBe('b');
  });

  it('returns null for an empty list', () => {
    expect(pickLargestImage([])).toBeNull();
  });
});
