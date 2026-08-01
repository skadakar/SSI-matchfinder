// Small helper for stubbing global fetch() in tests, so no test ever makes a
// real network call to the SSI API, Nominatim, or Discord.

let originalFetch;

/**
 * Replace globalThis.fetch with a stub for the duration of a test.
 * `responder` is called with (url, options) and must return either:
 *   - a plain object describing the response: { status, body, ok }
 *     (ok defaults to status >= 200 && status < 300; body is JSON-stringified
 *     unless it's already a string)
 *   - or a Response-like object with json()/text()/ok/status directly.
 * Call `restoreFetch()` in the test's `finally` / after-hook to undo this.
 */
export function stubFetch(responder) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const result = await responder(url, options);
    if (result && typeof result.json === 'function') return result;

    const status = result?.status ?? 200;
    const ok = result?.ok ?? (status >= 200 && status < 300);
    const bodyValue = result?.body ?? {};
    const bodyText = typeof bodyValue === 'string' ? bodyValue : JSON.stringify(bodyValue);
    return {
      ok,
      status,
      statusText: result?.statusText ?? '',
      json: async () => JSON.parse(bodyText),
      text: async () => bodyText,
    };
  };
}

export function restoreFetch() {
  globalThis.fetch = originalFetch;
}
