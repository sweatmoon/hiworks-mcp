// 현황판 실행기. app.js 가 쓰는 dash API(loader, calc, data, params, onData …)를 브라우저에서 구현한다.
// 시트는 사용자의 Google 로그인 토큰(읽기 전용 범위)으로 Sheets API 에서 직접 읽고, 서버로 보내지 않는다.
(() => {
  const cfg = window.DASHBOARD_CONFIG || { clientId: '', sources: {}, errors: ['설정을 불러오지 못했습니다.'] };
  const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const TOKEN_KEY = 'dashboard.token';
  const loaders = {};
  const calcs = {};
  const listeners = [];
  const state = {};
  let computed = {};
  let params = {};
  let token = null;
  let tokenClient = null;
  let loading = false;
  let queued = false;
  let lastLoad = 0;

  const $ = (id) => document.getElementById(id);

  function emit() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      listeners.forEach((fn) => {
        try { fn(); } catch (e) { console.error(e); }
      });
    });
  }

  // 계산 데이터셋은 입력이 모두 준비되면 다시 계산한다. 원본 시트 하나가 실패하면 빈 시트로 보고 계속한다(화면 상단에 실패 표시).
  function recompute() {
    const memo = {};
    const get = (id) => {
      if (memo[id]) return memo[id];
      if (loaders[id]) return (memo[id] = state[id] || { status: 'loading', data: [] });
      const c = calcs[id];
      if (!c) return (memo[id] = { status: 'missing', data: [] });
      memo[id] = { status: 'loading', data: [] };
      const ins = c.inputs.map((i) => ({ id: i, s: get(i) }));
      if (ins.some(({ s }) => s.status === 'loading' || s.status === 'connect')) return (memo[id] = { status: ins.some(({ s }) => s.status === 'connect') ? 'connect' : 'loading', data: [] });
      const broken = ins.find(({ id: i, s }) => s.status !== 'ok' && !loaders[i]);
      if (broken) return (memo[id] = { status: 'error', data: [], error: `${broken.id}: ${broken.s.error || broken.s.status}` });
      try {
        return (memo[id] = { status: 'ok', data: c.fn(...ins.map(({ s }) => (s.status === 'ok' ? s.data : []))) });
      } catch (e) {
        console.error(id, e);
        return (memo[id] = { status: 'error', data: [], error: e.message });
      }
    };
    Object.keys(calcs).forEach(get);
    computed = memo;
  }

  window.dash = {
    loader(id, opts) { loaders[id] = opts; },
    calc(id, opts) { calcs[id] = opts; },
    data(id) { return computed[id] || state[id] || { status: 'loading', data: [] }; },
    params() { return params; },
    setParams(p) { params = { ...params, ...p }; emit(); },
    setLink(id) { history.replaceState(null, '', '#' + id); },
    onData(fn) { listeners.push(fn); },
    colors: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `var(--chart-${i})`),
  };

  // ---------- Google 로그인 ----------
  function saveToken(t) {
    token = t;
    try {
      if (t) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t)); else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* 저장 불가(사파리 개인정보 보호 모드 등)면 메모리에만 둔다 */ }
  }
  function restoreToken() {
    try {
      const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
      if (t && t.access_token && t.expires_at > Date.now() + 60_000) return t;
    } catch (e) { /* 무시 */ }
    return null;
  }
  const tokenValid = () => token && token.expires_at > Date.now() + 30_000;

  function showGate(message) {
    $('gate').hidden = false;
    $('team-board').hidden = true;
    $('app-bar').hidden = true;
    $('gate-msg').textContent = message || '';
  }
  function showBoard() {
    $('gate').hidden = true;
    $('team-board').hidden = false;
    $('app-bar').hidden = false;
  }

  function requestToken(prompt) {
    if (!tokenClient) { showGate('Google 로그인 모듈을 불러오는 중입니다. 잠시 후 다시 눌러 주세요.'); return; }
    tokenClient.requestAccessToken({ prompt });
  }

  function initGoogle() {
    if (!window.google || !google.accounts || !google.accounts.oauth2) return false;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) { showGate('로그인하지 못했습니다: ' + (resp.error_description || resp.error)); return; }
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) { showGate('시트 읽기 권한을 허용해야 현황판을 볼 수 있습니다.'); return; }
        saveToken({ access_token: resp.access_token, expires_at: Date.now() + Number(resp.expires_in || 3600) * 1000 });
        showBoard();
        loadAll();
      },
      error_callback: (err) => showGate(err && err.type === 'popup_closed' ? '로그인 창이 닫혔습니다.' : '로그인 창을 열지 못했습니다. 팝업 차단을 확인해 주세요.'),
    });
    return true;
  }

  // ---------- 시트 읽기 ----------
  async function fetchSource(id, src) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(src.spreadsheetId)}/values/${encodeURIComponent(src.range)}`;
    const r = await fetch(url, { headers: { authorization: 'Bearer ' + token.access_token } });
    if (r.status === 401) return { status: 'connect', data: [], error: '로그인이 만료됐습니다.' };
    if (r.status === 403) return { status: 'declined', data: [], error: '이 계정에 시트 열람 권한이 없습니다.' };
    if (r.status === 404) return { status: 'missing', data: [], error: '시트나 범위를 찾을 수 없습니다.' };
    if (!r.ok) return { status: 'error', data: [], error: 'HTTP ' + r.status };
    const answer = await r.json();
    try {
      return { status: 'ok', data: loaders[id].fn({ answer }).rows };
    } catch (e) {
      return { status: 'error', data: [], error: e.message };
    }
  }

  async function loadAll() {
    if (loading) return;
    if (!tokenValid()) { requestToken(''); return; }
    loading = true;
    const ids = Object.keys(loaders);
    ids.forEach((id) => { if (!state[id] || state[id].status !== 'ok') state[id] = { status: 'loading', data: [] }; });
    let done = 0;
    $('app-status').textContent = `불러오는 중 0/${ids.length}`;
    await Promise.all(ids.map(async (id) => {
      const src = cfg.sources[id];
      let result;
      if (!src) result = { status: 'missing', data: [], error: 'DASHBOARD_SOURCES 에 ' + id + ' 항목이 없습니다.' };
      else {
        try { result = await fetchSource(id, src); } catch (e) { result = { status: 'error', data: [], error: e.message }; }
      }
      state[id] = result;
      done += 1;
      $('app-status').textContent = `불러오는 중 ${done}/${ids.length}`;
    }));
    loading = false;
    lastLoad = Date.now();
    if (ids.some((id) => state[id].status === 'connect')) { saveToken(null); showGate('로그인이 만료됐습니다. 다시 로그인해 주세요.'); return; }
    const failed = ids.filter((id) => state[id].status !== 'ok');
    failed.forEach((id) => console.warn('불러오지 못함', id, state[id].error));
    const t = new Date();
    $('app-status').textContent = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} 불러옴` + (failed.length ? ` · 실패 ${failed.length}개` : '');
    recompute();
    emit();
  }

  function signOut() {
    if (token && window.google && google.accounts) google.accounts.oauth2.revoke(token.access_token, () => {});
    saveToken(null);
    Object.keys(state).forEach((id) => delete state[id]);
    computed = {};
    showGate('로그아웃했습니다.');
  }

  function start() {
    $('gate-login').addEventListener('click', () => requestToken(token ? '' : 'select_account'));
    $('app-refresh').addEventListener('click', () => loadAll());
    $('app-signout').addEventListener('click', signOut);
    // 화면을 다시 보면 30분 넘은 데이터는 새로 읽는다
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !$('team-board').hidden && Date.now() - lastLoad > 30 * 60_000) loadAll();
    });

    if (cfg.errors && cfg.errors.length) { showGate('서버 설정이 끝나지 않았습니다: ' + cfg.errors.join(' ')); $('gate-login').disabled = true; return; }
    const waitGoogle = setInterval(() => { if (initGoogle()) clearInterval(waitGoogle); }, 100);
    setTimeout(() => clearInterval(waitGoogle), 15_000);
    const saved = restoreToken();
    if (saved) { token = saved; showBoard(); loadAll(); } else showGate('');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
