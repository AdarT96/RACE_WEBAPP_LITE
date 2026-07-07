// =====================================================
//  ESP32 Client — talks to per-station Gibush controllers
//  Each station has its own ESP32 reachable at its address
//  (mDNS hostname "gibush-stXX.local" or explicit IP).
// =====================================================

(function () {
  const LS_ADDRS   = 'demo_esp32_addrs';      // { "01": "http://gibush-st01.local", ... }
  const LS_ENABLED = 'demo_esp32_enabled';    // "1" = on, anything else = off
  const FETCH_TIMEOUT_MS = 4000;

  function pad2(n) { return String(n).padStart(2, '0'); }

  function defaultAddrFor(stationId) {
    return 'http://gibush-st' + pad2(stationId) + '.local';
  }

  function normalizeAddr(addr) {
    addr = (addr || '').trim().replace(/\/+$/, '');
    if (!addr) return '';
    if (!/^https?:\/\//i.test(addr)) addr = 'http://' + addr;
    return addr;
  }

  function loadAddrs() {
    try { return JSON.parse(localStorage.getItem(LS_ADDRS) || '{}') || {}; }
    catch (_) { return {}; }
  }

  function saveAddrs(map) {
    localStorage.setItem(LS_ADDRS, JSON.stringify(map || {}));
  }

  function getAddr(stationId) {
    const map = loadAddrs();
    return normalizeAddr(map[stationId] || defaultAddrFor(stationId));
  }

  function setAddr(stationId, addr) {
    const map = loadAddrs();
    const clean = normalizeAddr(addr);
    if (clean) map[stationId] = clean;
    else delete map[stationId];
    saveAddrs(map);
  }

  function isEnabled() {
    return localStorage.getItem(LS_ENABLED) === '1';
  }
  function setEnabled(on) {
    localStorage.setItem(LS_ENABLED, on ? '1' : '0');
  }

  // Wrap fetch with a timeout
  async function fetchTimeout(url, opts) {
    const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, Object.assign({}, opts, ctl ? { signal: ctl.signal } : {}));
      return res;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function callJson(stationId, path, method, body) {
    const base = getAddr(stationId);
    const url = base + path;
    const opts = { method: method || 'GET' };
    if (body !== undefined) {
      // Plain text body keeps it a "simple" request (no CORS preflight)
      opts.body = JSON.stringify(body);
    }
    const res = await fetchTimeout(url, opts);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ct = res.headers.get('content-type') || '';
    if (ct.indexOf('application/json') < 0) {
      const txt = await res.text();
      try { return JSON.parse(txt); } catch (_) { return { ok: true, raw: txt }; }
    }
    return await res.json();
  }

  window.ESP32 = {
    pad2: pad2,
    defaultAddrFor: defaultAddrFor,
    getAddr: getAddr,
    setAddr: setAddr,
    loadAddrs: loadAddrs,
    saveAddrs: saveAddrs,
    isEnabled: isEnabled,
    setEnabled: setEnabled,

    info:  (stationId) => callJson(stationId, '/info',  'GET'),
    // participants: optional string[] of EPC values — if provided the ESP32 uses
    // exactly those EPCs as its mock pool instead of the hardcoded fallback.
    start: (stationId, round, mode, participants) => {
      const body = { round: round, mode: mode };
      if (Array.isArray(participants) && participants.length) body.participants = participants;
      return callJson(stationId, '/start', 'POST', body);
    },
    stop:  (stationId) => callJson(stationId, '/stop',  'POST', {}),
    clear: (stationId) => callJson(stationId, '/clear', 'POST', {}),
    reset: (stationId) => callJson(stationId, '/reset', 'POST', {}),
    tags:  (stationId) => callJson(stationId, '/tags',  'GET')
  };
})();
