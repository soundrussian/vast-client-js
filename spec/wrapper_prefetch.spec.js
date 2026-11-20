import { VASTClient } from '../src/vast_client';
import { urlHandler } from '../src/fetcher/url_handler';

function vast(body) {
  return new DOMParser().parseFromString(
    `<VAST version="4.0">${body}</VAST>`,
    'text/xml'
  );
}

function inline(id) {
  return vast(`
    <Ad id="${id}"><InLine>
      <AdSystem>Test</AdSystem><AdTitle>${id}</AdTitle>
      <Creatives><Creative><Linear><Duration>00:00:03</Duration><MediaFiles>
        <MediaFile type="video/mp4">https://example.com/${id}.mp4</MediaFile>
      </MediaFiles></Linear></Creative></Creatives>
    </InLine></Ad>`);
}

function fixture() {
  const client = new VASTClient();
  const pending = {};
  const requested = {};
  const ids = ['a', 'b', 'c', 'd'];
  const urls = ids.map((id) => `https://example.com/${id}`);
  const root = 'https://example.com/root';
  const xml = vast(urls.map((url) => `
    <Ad><Wrapper><AdSystem>Test</AdSystem>
      <VASTAdTagURI>${url}</VASTAdTagURI>
    </Wrapper></Ad>`).join(''));
  for (const id of ids) {
    requested[id] = new Promise((resolve) => {
      pending[id] = { requested: resolve };
    });
    pending[id].response = new Promise((resolve) => {
      pending[id].release = resolve;
    });
  }
  const get = jest.fn((url) => {
    if (url === root) {
      return { xml };
    }
    const id = url.slice(-1);
    pending[id].requested();
    return pending[id].response;
  });

  return {
    client,
    result: client.get(root, { urlHandler: { get } }),
    requested,
    get,
    release: (id, response = { xml: inline(id) }) => pending[id].release(response),
  };
}

describe('ordered wrapper prefetch', () => {
  it('returns A while B is pending and reuses B without waiting for C', async () => {
    const { client, result, requested, release, get } = fixture();
    await requested.b;
    release('a');
    expect((await result).ads[0].id).toBe('a');
    expect(get).toHaveBeenCalledTimes(3);

    const next = client.getNextAds();
    await requested.c;
    release('b');
    expect((await next).ads[0].id).toBe('b');
    expect(get.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/root', '/a', '/b', '/c',
    ]);
    release('c');
  });

  it('does not return a fast B ahead of A and reuses it in a batch', async () => {
    const { client, result, requested, release, get } = fixture();
    await requested.b;
    release('b');
    let returned = false;
    result.then(() => { returned = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(returned).toBe(false);
    expect(get).toHaveBeenCalledTimes(3);

    release('a');
    expect((await result).ads[0].id).toBe('a');
    const batch = client.getNextAds(true);
    release('d');
    release('c');
    expect((await batch).ads.map((ad) => ad.id)).toEqual(['b', 'c', 'd']);
    expect(get).toHaveBeenCalledTimes(5);
    expect(client.hasRemainingAds()).toBe(false);
  });

  it.each([
    [{ xml: vast('<Error>https://example.com/b-error</Error>') }, 303],
    [{ error: new Error('timeout'), statusCode: 408 }, 301],
  ])('prepares C after B fails and reports B only when consumed', async (failure, code) => {
    const { client, result, requested, release } = fixture();
    const report = jest.fn();
    client.getParser().on('VAST-error', report);
    await requested.b;
    release('b', failure);
    await requested.c;
    release('a');
    const first = await result;
    expect(first.errorURLTemplates).toEqual([]);
    expect(report).not.toHaveBeenCalled();

    expect((await client.getNextAds()).ads).toEqual([]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0].ERRORCODE).toBe(code);
    release('c');
    expect((await client.getNextAds()).ads[0].id).toBe('c');
    release('d');
  });

  it('retires a pending prefetch when the client starts another root', async () => {
    const { client, result, requested, release, get } = fixture();
    await requested.b;
    release('a');
    await result;
    const report = jest.fn();
    client.getParser().on('VAST-error', report);

    const next = await client.parseVAST(inline('new'));
    release('b', { xml: vast('<Error>https://example.com/retired</Error>') });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(next.ads[0].id).toBe('new');
    expect(client.hasRemainingAds()).toBe(false);
    expect(client.getParser().getErrorURLTemplates()).toEqual([]);
    expect(get).toHaveBeenCalledTimes(3);
    expect(report).not.toHaveBeenCalled();
  });
});

it('reports a fetch timeout through the request result', async () => {
  const originalFetch = global.fetch;
  global.fetch = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    });
  }));

  try {
    const result = await urlHandler.get('https://example.com/stalled', { timeout: 5 });
    expect(result.statusCode).toBe(408);
    expect(result.error.message).toContain('timed out after 5 ms');
  } finally {
    global.fetch = originalFetch;
  }
});
