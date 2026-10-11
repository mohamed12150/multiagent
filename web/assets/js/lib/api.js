// API client: unwraps the {ok, data, meta, error} envelope, sends the CSRF header, and offers a data hook.
import { useState, useEffect, useRef, useCallback } from './h.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let unauthorized = null;
export function onUnauthorized(fn) { unauthorized = fn; }

const TIMEOUT_MS = 90000;

const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000; // a large video on a slow line

async function request(method, path, body, { raw = false, signal, timeoutMs } = {}) {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-QSM-Request'] = '1';
  const opts = { method, headers, credentials: 'same-origin' };
  const ms = timeoutMs || (body instanceof FormData ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS);
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  opts.signal = signal && timeout && AbortSignal.any ? AbortSignal.any([signal, timeout]) : (signal || timeout);
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    if (e.name === 'TimeoutError') throw new ApiError(0, 'timeout', 'انتهت مهلة الطلب — حاول مرة أخرى');
    throw new ApiError(0, 'network', 'تعذر الاتصال بالخادم');
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || (json && json.ok === false)) {
    const err = json?.error || {};
    if (res.status === 401 && unauthorized && !url.startsWith('/api/auth/')) unauthorized();
    throw new ApiError(res.status, err.code || `http_${res.status}`, err.message || 'حدث خطأ غير متوقع');
  }
  return raw ? json : json?.data;
}

export const api = {
  get: (p, o) => request('GET', p, undefined, o),
  raw: (p, o) => request('GET', p, undefined, { ...o, raw: true }),
  post: (p, b, o) => request('POST', p, b ?? {}, o),
  put: (p, b, o) => request('PUT', p, b ?? {}, o),
  patch: (p, b, o) => request('PATCH', p, b ?? {}, o),
  del: (p, o) => request('DELETE', p, undefined, o),
};

/** Fetch `path` (null = skip). Returns {data, meta, error, loading, reload, setData}. */
export function useApi(path, deps = []) {
  const [state, setState] = useState({ data: null, meta: null, error: null, loading: !!path });
  const seq = useRef(0);
  const load = useCallback(async (quiet = false) => {
    if (!path) return;
    const n = ++seq.current;
    if (!quiet) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const json = await api.raw(path);
      if (n === seq.current) setState({ data: json.data, meta: json.meta || null, error: null, loading: false });
    } catch (e) {
      if (n === seq.current && e.name !== 'AbortError') setState((s) => ({ ...s, error: e, loading: false }));
    }
  }, [path, ...deps]);
  useEffect(() => { load(); }, [load]);
  const setData = useCallback((fn) => setState((s) => ({ ...s, data: typeof fn === 'function' ? fn(s.data) : fn })), []);
  return { ...state, reload: load, setData };
}
