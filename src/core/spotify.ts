import type { CoverArt } from './types';

/**
 * Minimal Spotify Web API client for the client credentials flow.
 *
 * The app is client only, so the user has to bring their own client id and
 * secret. Both the token endpoint (`accounts.spotify.com`) and the Web API
 * (`api.spotify.com`) send CORS headers, and the image CDN sends
 * `access-control-allow-origin: *`, so everything works straight from the
 * browser without a proxy.
 */

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1';

export class SpotifyError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 0, code = 'spotify_error') {
    super(message);
    this.name = 'SpotifyError';
    this.status = status;
    this.code = code;
  }
}

export interface SpotifyImage {
  readonly url: string;
  readonly height: number | null;
  readonly width: number | null;
}

export interface SpotifyTrack {
  readonly id: string;
  readonly name: string;
  readonly artists: readonly string[];
  readonly album: string;
  readonly image: SpotifyImage | null;
}

/** Picks the largest image of a list (the original tool sorts by height). */
export function pickLargestImage(images: readonly SpotifyImage[]): SpotifyImage | null {
  if (images.length === 0) return null;
  return [...images].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0] ?? null;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface SearchResponse {
  tracks?: {
    items?: {
      id?: string;
      name?: string;
      artists?: { name?: string }[];
      album?: { name?: string; images?: SpotifyImage[] };
    }[];
  };
}

export class SpotifyClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  #token: string | null = null;
  #tokenExpiresAt = 0;

  constructor(clientId: string, clientSecret: string) {
    this.#clientId = clientId.trim();
    this.#clientSecret = clientSecret.trim();
  }

  /** `true` when both credentials are present. */
  get isConfigured(): boolean {
    return this.#clientId.length > 0 && this.#clientSecret.length > 0;
  }

  /** Requests (or reuses) an access token via the client credentials flow. */
  async getAccessToken(): Promise<string> {
    if (!this.isConfigured) {
      throw new SpotifyError(
        'No Spotify client id / client secret configured.',
        0,
        'missing_credentials',
      );
    }
    if (this.#token && Date.now() < this.#tokenExpiresAt) {
      return this.#token;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
    });

    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      throw new SpotifyError(
        `Could not reach Spotify (${(error as Error).message}). Check your network connection.`,
        0,
        'network_error',
      );
    }

    let payload: TokenResponse = {};
    try {
      payload = (await response.json()) as TokenResponse;
    } catch {
      payload = {};
    }

    if (!response.ok) {
      const description = payload.error_description ?? payload.error ?? response.statusText;
      let message = `Spotify rejected the credentials: ${description}`;
      if (payload.error === 'invalid_client') {
        message =
          'Spotify rejected the client id / client secret. Please create your own app in the Spotify developer dashboard and copy both values.';
      } else if (response.status === 429) {
        message = 'Spotify rate limit reached, please try again later.';
      }
      throw new SpotifyError(message, response.status, payload.error ?? 'token_error');
    }

    if (!payload.access_token) {
      throw new SpotifyError('Spotify did not return an access token.', response.status, 'no_token');
    }

    this.#token = payload.access_token;
    this.#tokenExpiresAt = Date.now() + Math.max(60, (payload.expires_in ?? 3600) - 60) * 1000;
    return this.#token;
  }

  /** Searches for a track and returns the best match. */
  async searchTrack(title: string, artist: string): Promise<SpotifyTrack | null> {
    const token = await this.getAccessToken();
    const query = `${title} ${artist}`.trim();
    const url = `${API_URL}/search?${new URLSearchParams({
      q: query,
      type: 'track',
      limit: '1',
    }).toString()}`;

    let response: Response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (error) {
      throw new SpotifyError(
        `Could not reach the Spotify Web API (${(error as Error).message}).`,
        0,
        'network_error',
      );
    }

    if (response.status === 401) {
      this.#token = null;
      throw new SpotifyError('The Spotify access token was rejected.', 401, 'unauthorized');
    }
    if (response.status === 429) {
      throw new SpotifyError('Spotify rate limit reached, please try again later.', 429, 'rate_limit');
    }
    if (!response.ok) {
      throw new SpotifyError(
        `Spotify search failed (${response.status} ${response.statusText}).`,
        response.status,
        'search_failed',
      );
    }

    const payload = (await response.json()) as SearchResponse;
    const item = payload.tracks?.items?.[0];
    if (!item) return null;

    return {
      id: item.id ?? '',
      name: item.name ?? title,
      artists: (item.artists ?? []).map((entry) => entry.name ?? '').filter((name) => name.length > 0),
      album: item.album?.name ?? '',
      image: pickLargestImage(item.album?.images ?? []),
    };
  }

  /** Downloads the cover art of a track. */
  async fetchCover(track: SpotifyTrack): Promise<CoverArt | null> {
    if (!track.image) return null;
    let response: Response;
    try {
      response = await fetch(track.image.url);
    } catch (error) {
      throw new SpotifyError(
        `Could not download the cover art (${(error as Error).message}).`,
        0,
        'network_error',
      );
    }
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? 'image/jpeg';
    const mime = contentType.split(';')[0]?.trim() || 'image/jpeg';
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) return null;
    return { mime, data: new Uint8Array(buffer) };
  }

  /** Searches for a track and downloads its cover art in one go. */
  async findCover(title: string, artist: string): Promise<CoverArt | null> {
    const track = await this.searchTrack(title, artist);
    if (!track) return null;
    return this.fetchCover(track);
  }
}
