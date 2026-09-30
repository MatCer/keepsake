export class KarakeepError extends Error {
  constructor(message: string, public status: number | null, public retryable: boolean) { super(message); this.name = 'KarakeepError'; }
}
export interface ClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}
export function normalizeAddress(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new KarakeepError('Invalid server address', null, false); }
  const host = url.hostname;
  const octets = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split('.').map(Number) : [];
  const [first, second = -1] = octets;
  const privateIp = octets.length === 4 && (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(host) || privateIp || ['.local', '.lan', '.home.arpa'].some(suffix => host.endsWith(suffix));
  if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) throw new KarakeepError('Use HTTPS or a local HTTP server', null, false);
  return url.origin;
}
export function originPattern(address: string): string { return `${normalizeAddress(address)}/*`; }

export async function request(origin: string, path: string, template: string, method: string, body: BodyInit | undefined, apiKey: string | null, opts: ClientOptions): Promise<Response> {
  const fetcher = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const headers = new Headers();
  if (apiKey !== null) headers.set('Authorization', `Bearer ${apiKey}`);
  if (typeof body === 'string') headers.set('Content-Type', 'application/json');
  for (let attempt = 0; attempt < 3; attempt++) {
    let failure: KarakeepError;
    try {
      const response = await fetcher(`${origin}${path}`, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 15000), redirect: 'error' });
      if (response.ok) {
        // Read under the same timeout/retry scope; a connection can fail after headers.
        const data = response.body === null ? null : await response.arrayBuffer();
        return new Response(data, { status: response.status, headers: response.headers });
      }
      failure = new KarakeepError(`${method} ${template} failed: ${response.status}`, response.status, response.status === 429 || response.status >= 500);
      // Discard error bodies: they may contain credentials or request text.
      if (response.body) await response.body.cancel().catch(() => undefined);
    } catch (error) {
      const retryable = error instanceof TypeError || ((error instanceof Error || error instanceof DOMException) && ['AbortError', 'TimeoutError'].includes(error.name));
      failure = new KarakeepError(`${method} ${template} failed: network error`, null, retryable);
    }
    if (!failure.retryable || attempt === 2) throw failure;
    await sleep(attempt === 0 ? 500 : 1500);
  }
  throw new KarakeepError('Request failed', null, true);
}
export async function json(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new KarakeepError('Unexpected server response', response.status, false); }
}
export function invalid(): never { throw new KarakeepError('Unexpected server response', null, false); }
