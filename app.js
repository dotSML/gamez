/* PARTY SUITE — client. Websocket first, long-poll fallback. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const base = location.href.split('?')[0].replace(/[^/]*$/, '');

  let S = null, me = null, gen = 0, since = 0, ws = null;
  let skew = 0, wasMine = false, sound = true, lastTick = -1, lastStopSec = -1;
  let wsFails = 0, holding = false;

  /* ---- bonk: latest server snapshot + input queue ---- */
  let snap = null;                 /* { round, left, state, bodies:[[id,x,y,alive]] } */
  let prevSnap = null, snapAt = 0; /* for interpolation */
  const keys = { l: false, r: false };
  let jumpQueued = false;
  let lastSent = 0, lastJumpSent = 0;

  const store = {
    get() { try { return JSON.parse(sessionStorage.getItem('partysuite') || 'null'); } catch { return null; } },
    set(v) { try { sessionStorage.setItem('partysuite', JSON.stringify(v)); } catch (e) { /* private mode */ } },
    clear() { try { sessionStorage.removeItem('partysuite'); } catch (e) { /* ignore */ } }
  };

  const show = (id, on) => $(id).classList.toggle('hidden', !on);
  const net = (state) => { $('net').className = 'dot ' + state; };

  async function post(path, body) {
    return fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store'
    });
  }

  function flash(msg, ok, which) {
    const el = $(which === 'stop' ? 'stop-flash' : 'flash');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('ok', !!ok);
  }

  /* ----------------------------- join ----------------------------- */

  async function join(code, name, resume) {
    $('join-err').textContent = '';
    $('btn-create').disabled = true;
    $('btn-join').disabled = true;
    try {
      const r = await post('api/hello', {
        code, name,
        pid: resume ? resume.pid : null,
        secret: resume ? resume.secret : null
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.e || 'Could not join.');
      me = { room: j.state.code, pid: j.pid, secret: j.secret, name };
      store.set(me);
      startRealtime();
      apply(j.state);
    } catch (err) {
      $('join-err').textContent = err.message || 'Could not join.';
      show('s-join', true);
      show('s-room', false);
      if (resume) store.clear();
    } finally {
      $('btn-create').disabled = false;
      $('btn-join').disabled = false;
    }
  }

  /* --------------------------- transport --------------------------- */

  function stopRealtime() {
    gen++;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch (e) { /* ignore */ }
      ws = null;
    }
  }

  function startRealtime() {
    stopRealtime();
    const my = gen;
    const url = base.replace(/^http/, 'ws') + 'ws?room=' + encodeURIComponent(me.room) +
      '&pid=' + encodeURIComponent(me.pid) + '&secret=' + encodeURIComponent(me.secret);
    let opened = false, got = false;
    try { ws = new WebSocket(url); } catch (e) { pollRun(my); return; }
    net('');

    const bail = setTimeout(() => {
      if (!opened) { try { ws.close(); } catch (e) { /* ignore */ } pollRun(my); }
    }, 3000);

    ws.onopen = () => { opened = true; clearTimeout(bail); net('ws'); };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m && m.t === 'state') { got = true; wsFails = 0; apply(m); }
        else if (m && m.t === 'bk') { prevSnap = snap; snap = m; snapAt = performance.now(); }
        else if (m && m.t === 'tk') { tkTake(m); }
      } catch (e) { /* ignore */ }
    };
    ws.onerror = () => {
      if (!opened) { clearTimeout(bail); try { ws.close(); } catch (e) { /* ignore */ } pollRun(my); }
    };
    ws.onclose = () => {
      clearTimeout(bail);
      if (my !== gen) return;
      net('down');
      if (!got) wsFails++;
      if (!got && wsFails >= 2) { pollRun(my); return; }
      setTimeout(() => { if (my === gen && me) startRealtime(); }, got ? 600 : 1200);
    };
  }

  async function pollRun(my) {
    net('poll');
    while (my === gen && me) {
      try {
        const q = 'api/events?room=' + encodeURIComponent(me.room) + '&pid=' + encodeURIComponent(me.pid) +
          '&secret=' + encodeURIComponent(me.secret) + '&since=' + since;
        const r = await fetch(base + q, { cache: 'no-store' });
        if (my !== gen) return;
        if (r.status === 403) { store.clear(); location.href = base; return; }
        const j = await r.json();
        if (j && j.t === 'state') apply(j);
        else if (j && j.t === 'tk') tkTake(j);
        else if (j && j.v > since) since = j.v;
      } catch (e) { await sleep(1400); }
    }
  }

  function apply(st) {
    if (!st || st.t !== 'state') return;
    if (S && st.v < S.v) return;
    const prevAt = S && S.feed.length ? S.feed[S.feed.length - 1].at : 0;
    since = Math.max(since, st.v);
    skew = st.now - Date.now();
    S = st;
    const last = st.feed.length ? st.feed[st.feed.length - 1] : null;
    if (last && last.at > prevAt && last.k === 'boom') boomFx();
    else if (last && last.at > prevAt && last.k === 'word') beep(540, 0.05, 'triangle', 0.05);
    else if (last && last.at > prevAt && last.k === 'try') beep(430, 0.09, 'sine', 0.07);
    render();
  }

  /* ----------------------------- actions ----------------------------- */

  async function act(action, extra) {
    const body = Object.assign({ room: me.room, pid: me.pid, secret: me.secret, action }, extra || {});
    try {
      const r = await post('api/act', body);
      const j = await r.json().catch(() => ({}));
      if (j && j.state) apply(j.state);
      if (!r.ok) flash(j.e || 'That failed.', false, action === 'hit' || action === 'go' ? 'stop' : undefined);
      return j;
    } catch (e) {
      flash('Connection trouble. Still trying.');
      return { ok: false };
    }
  }

  async function sendWord(raw) {
    const w = String(raw || '').trim();
    if (!w) return;
    if (!S || S.phase !== 'bomb') return;
    if (S.bomb.turnId !== S.youId) return flash('Not your turn.');
    const j = await act('word', { word: w });
    if (j.ok) {
      $('word').value = '';
      flash('', false);
    } else {
      flash(j.e || 'Rejected.');
      const box = $('word');
      box.classList.remove('shake');
      void box.offsetWidth;
      box.classList.add('shake');
    }
  }

  /* ----------------------------- render ----------------------------- */

  function inviteUrl() {
    return location.origin + location.pathname + '?room=' + (S ? S.code : '');
  }

  function qrSvg(qr) {
    const n = qr.getModuleCount();
    const pad = 4;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += 'M' + (c + pad) + ' ' + (r + pad) + 'h1v1h-1z';
      }
    }
    const dim = n + pad * 2;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim +
      '" shape-rendering="crispEdges" role="img" aria-label="QR code for the join link">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="#ffffff"/>' +
      '<path d="' + d + '" fill="#0b0c10"/></svg>';
  }

  let qrFor = '';
  function renderQr(code) {
    const box = $('qrbox');
    const card = $('qrcard');
    if (!box || !card || !code || code === qrFor) return;
    try {
      if (typeof qrcode !== 'function') throw new Error('no encoder');
      const url = inviteUrl();
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      box.innerHTML = qrSvg(qr);
      $('qrlink').textContent = url.replace(/^https?:\/\//, '');
      card.classList.remove('hidden');
      qrFor = code;
    } catch (e) {
      card.classList.add('hidden');
    }
  }

  function renderLobby(st) {
    $('lobby-code').textContent = st.code;
    renderQr(st.code);
    const isHost = st.hostId === st.youId;
    const n = st.players.length;
    $('pick-bomb').classList.toggle('on', st.game === 'bomb');
    $('pick-stop').classList.toggle('on', st.game === 'stop');
    $('pick-panic').classList.toggle('on', st.game === 'panic');
    $('pick-bonk').classList.toggle('on', st.game === 'bonk');
    $('pick-tanks').classList.toggle('on', st.game === 'tanks');
    $('pick-bomb').disabled = !isHost;
    $('pick-stop').disabled = !isHost;
    $('pick-panic').disabled = !isHost;
    $('pick-bonk').disabled = !isHost;
    $('pick-tanks').disabled = !isHost;
    $('lobby-hint').textContent = n < 2
      ? 'Waiting for at least one more human. Share the link.'
      : n + ' in. Host picks a game and starts.';
    show('btn-start', isHost);
    $('btn-start').disabled = n < 2;
  }

  function renderBomb(st) {
    const b = st.bomb;
    const holder = st.players.find((p) => p.id === b.turnId);
    const myTurn = b.turnId === st.youId;
    $('letter').textContent = b.letter;
    const bomb = $('bomb');
    bomb.classList.toggle('mine', myTurn);
    $('holder').textContent = myTurn ? 'YOU HAVE THE BOMB' : holder ? holder.name + ' has it' : '…';
    $('holder').classList.toggle('mine', myTurn);
    const wi = $('word');
    wi.disabled = !myTurn;
    $('btn-send').disabled = !myTurn;
    wi.placeholder = myTurn ? 'word containing ' + b.letter + '…' : holder ? holder.name + ' is thinking…' : '';
    if (myTurn && !wasMine) { try { wi.focus(); } catch (e) { /* ignore */ } }
    wasMine = myTurn;
  }

  function renderStop(st) {
    const sp = st.stop;
    const shooter = sp.order[sp.idx];
    const isShooter = shooter === st.youId;
    const shooterP = st.players.find((p) => p.id === shooter);

    $('stop-round').textContent = 'Round ' + Math.min(sp.round, sp.rounds) + ' of ' + sp.rounds;
    $('stop-target').textContent = (sp.targetMs / 1000).toFixed(2);
    $('stopcard').classList.toggle('live', !!sp.running);

    const going = sp.running && sp.runningPid === st.youId;
    show('btn-go', isShooter && !sp.running);
    show('btn-hit', going);
    $('btn-go').disabled = !isShooter || !!sp.running;

    if (sp.running) {
      const runner = st.players.find((p) => p.id === sp.runningPid);
      $('stop-role').textContent = going ? 'your shot' : 'live';
      $('stop-who').textContent = going ? 'HOLDING — tap STOP' : (runner ? runner.name : '?') + ' is holding…';
      $('stop-hint').textContent = going
        ? 'Stop it as close to ' + (sp.targetMs / 1000).toFixed(2) + 's as you can. Clock is hidden.'
        : 'Watch, and enjoy their panic.';
    } else if (isShooter) {
      $('stop-role').textContent = 'your shot';
      $('stop-who').textContent = 'Your shot. Tap START when ready.';
      $('stop-hint').textContent = 'The clock is hidden. Feel ' + (sp.targetMs / 1000).toFixed(2) + 's and stop.';
    } else {
      $('stop-role').textContent = 'watching';
      $('stop-who').textContent = shooterP ? shooterP.name + ' is up.' : 'Waiting…';
      $('stop-hint').textContent = 'Clock is hidden from everyone, including ' +
        (shooterP ? shooterP.name : 'them') + '.';
    }

    $('stop-tries').innerHTML = sp.order.map((id, i) => {
      const p = st.players.find((q) => q.id === id);
      if (!p) return '';
      const t = sp.tries.find((q) => q.id === id);
      const cls = 'try' + (t ? ' done' : '') + (i === sp.idx && !sp.running ? ' up' : '');
      const right = t
        ? '<span class="tryms">' + (t.ms / 1000).toFixed(2) + 's</span>' +
          '<span class="trydelta' + (t.delta <= 100 ? ' close' : '') + '">' +
          (t.delta / 1000).toFixed(2) + ' off</span>'
        : '<span class="tryms">—</span><span class="trydelta"></span>';
      return '<li class="' + cls + '"><span class="tryname">' + esc(p.name) + '</span>' + right + '</li>';
    }).join('');

    const pending = sp.order.length - sp.tries.length;
    $('stop-pending').textContent = pending > 0 ? pending + ' to go' : 'round done';
  }

  const COLORS = ['RED', 'BLUE', 'GREEN', 'YELLOW'];
  const INKHEX = { RED: '#ff4d3d', BLUE: '#4f9dff', GREEN: '#3ddc84', YELLOW: '#ffb703' };

  function renderPanic(st) {
    const pn = st.panic;
    const nowMs = Date.now() + skew;
    const isLocked = pn.locked.includes(st.youId);
    const solved = !!pn.solvedBy;
    const winner = solved ? st.players.find((p) => p.id === pn.solvedBy) : null;

    $('panic-round').textContent = 'Round ' + Math.min(pn.round, pn.rounds) + ' of ' + pn.rounds;
    const wordEl = $('bigword');
    wordEl.textContent = COLORS[pn.word] || '';
    wordEl.style.color = INKHEX[COLORS[pn.ink]] || '#fff';

    const waiting = nowMs < pn.goAt;
    const live = !waiting && !solved && !isLocked;
    $('paniccard').classList.toggle('live', live);
    $('paniccard').classList.toggle('go', !waiting && !solved);

    let status = '';
    let hint = '';
    if (waiting) {
      status = 'ready';
      hint = 'Wait for GO…';
    } else if (solved) {
      status = 'taken';
      hint = winner ? winner.name + ' got it first.' : 'Taken.';
    } else if (isLocked) {
      status = 'out';
      hint = 'You tapped wrong. Out of this round — watch.';
    } else {
      status = 'GO';
      hint = 'Tap the INK colour, not the word.';
    }
    $('panic-status').textContent = status;
    $('panic-hint').textContent = hint;

    for (const c of COLORS) {
      const btn = $('pad-' + c.toLowerCase());
      btn.disabled = !live;
      btn.classList.toggle('wrong', isLocked || solved);
    }

    if (pn.lastRound && pn.lastRound.winner) {
      $('panic-flash').textContent = pn.lastRound.winner + ' took round ' + pn.lastRound.round + '.';
    } else if (pn.lastRound) {
      $('panic-flash').textContent = 'Round ' + pn.lastRound.round + ' wasted.';
    }
  }

  /* ----------------------------- bonk ----------------------------- */

  const BONK_W = 800, BONK_H = 600, BONK_FLOOR_Y = 470;
  const BONK_TILES = 16, BONK_TW = BONK_W / BONK_TILES, BONK_R = 20;

  function sendInput(force) {
    if (!ws || ws.readyState !== 1) return;
    const t = performance.now();
    if (!force && t - lastSent < 66) return;
    lastSent = t;
    try {
      ws.send(JSON.stringify({ t: 'in', l: keys.l, r: keys.r, j: jumpQueued ? 1 : 0 }));
      jumpQueued = false;
    } catch (e) { /* socket died; the poll fallback has no input path */ }
  }

  function drawBonk(st) {
    const cv = $('arena');
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const W = BONK_W, H = BONK_H;

    ctx.clearRect(0, 0, W, H);

    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#14161f');
    g.addColorStop(1, '#0a0b10');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    if (!snap) {
      ctx.fillStyle = '#6b7386';
      ctx.font = '20px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('waiting for the arena…', W / 2, H / 2);
      return;
    }

    /* floor: infer live tiles from the snapshot's tile count when present,
       otherwise from the round clock. The server is the truth; this is cosmetic. */
    const gone = snap.gone || 0;
    for (let i = 0; i < BONK_TILES; i++) {
      if (snap.dead && snap.dead.indexOf(i) !== -1) continue;
      const x = i * BONK_TW;
      ctx.fillStyle = '#2a3040';
      ctx.fillRect(x + 1, BONK_FLOOR_Y, BONK_TW - 2, 14);
      ctx.fillStyle = '#3b4457';
      ctx.fillRect(x + 1, BONK_FLOOR_Y, BONK_TW - 2, 4);
    }

    /* interpolate bodies */
    const lerp = Math.min(1, (performance.now() - snapAt) / 66);
    const byId = new Map();
    if (prevSnap && prevSnap.round === snap.round) {
      for (const bd of prevSnap.bodies) byId.set(bd[0], bd);
    }
    const meIdx = st ? st.youId : null;

    for (const bd of snap.bodies) {
      const [id, x, y, alive] = bd;
      if (!alive) continue;
      const prev = byId.get(id);
      const px = prev ? prev[1] + (x - prev[1]) * lerp : x;
      const py = prev ? prev[2] + (y - prev[2]) * lerp : y;
      const isMe = id === meIdx;
      const p = st && st.players.find((q) => q.id === id);
      const col = colourFor(id);

      ctx.beginPath();
      ctx.arc(px, py, BONK_R, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = isMe ? 4 : 2;
      ctx.strokeStyle = isMe ? '#ffffff' : 'rgba(0,0,0,.45)';
      ctx.stroke();

      if (p) {
        ctx.fillStyle = '#dfe5f2';
        ctx.font = 'bold 14px system-ui,sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(p.name, px, py - BONK_R - 8);
      }
    }
  }

  const COLS = ['#ff6440', '#4f9dff', '#3ddc84', '#ffb703', '#c77dff', '#29d3d3', '#ff6fb5', '#9ddf3d'];
  function colourFor(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return COLS[h % COLS.length];
  }

  function renderBonk(st) {
    const bk = st.bonk;
    $('bonk-round').textContent = 'Round ' + Math.min(bk.round, bk.rounds) + ' of ' + bk.rounds;
    const leftMs = Math.max(0, (bk.roundEndsAt || 0) - (Date.now() + skew));
    $('bonk-clock').textContent = bk.state === 'gap' ? 'next…' : (leftMs / 1000).toFixed(1) + 's';

    const body = snap ? snap.bodies.find((x) => x[0] === st.youId) : null;
    const dead = body ? body[3] !== 1 : false;
    const ov = $('bonk-overlay');
    if (bk.state === 'gap') {
      ov.textContent = 'Next round…';
      ov.classList.remove('hidden');
    } else if (dead) {
      ov.textContent = 'You fell. Watch.';
      ov.classList.remove('hidden');
    } else {
      ov.classList.add('hidden');
    }

    for (const id of ['bk-left', 'bk-jump', 'bk-right']) $(id).disabled = dead || bk.state === 'gap';
    drawBonk(st);
  }

  function bonkInputLoop() {
    if (S && S.phase === 'bonk') sendInput(false);
    requestAnimationFrame(bonkInputLoop);
  }

  /* ------------------------------ TANKS ------------------------------ */
  /* Classic top-down tank duel. Holds a direction from the D-pad (or WASD)
     and sends it over the socket; the server moves the tank. Bullets, brick
     and steel are all drawn here from the server's packets. */

  const TK2_COL = {
    '.': null,
    B: ['#7a3b22', '#a1522e'],   /* brick: warm, obviously breakable */
    S: ['#4a5468', '#6b7893']    /* steel: cold, obviously not */
  };
  const TK2_TANK = [
    ['#ff8a76', '#a83a26'],      /* self */
    ['#8fc4ff', '#2c5f9e'],
    ['#84efb7', '#1d7a4d'],
    ['#ffd166', '#a67610'],
    ['#e0b3ff', '#6f3d99'],
    ['#7fe9e9', '#1d7a7a'],
    ['#ffb3c7', '#a63d5c'],
    ['#c9d2e2', '#4a5468']
  ];

  let tkField = null;        /* latest 'tk' packet */
  let tkFieldAt = 0;         /* when it arrived, for interpolating bullets */
  let tkHeld = null;         /* direction being held, or null */
  let tkLastSend = 0;
  let tkSelfId = null;
  const tkPos = new Map();   /* id -> { x, y } smoothed toward the server */

  /* Take a field packet. Positions are eased toward the server's, never
     snapped, or 20 Hz input looks like a slideshow. */
  function tkTake(m) {
    if (!m || !m.map || !m.map.length) return;
    tkField = m;
    tkFieldAt = performance.now();
    for (const u of (m.units || [])) {
      const cur = tkPos.get(u.id);
      if (!cur) tkPos.set(u.id, { x: u.x, y: u.y });
      else if (Math.abs(cur.x - u.x) > 2 || Math.abs(cur.y - u.y) > 2) {
        tkPos.set(u.id, { x: u.x, y: u.y });   /* a teleport, not a slide */
      }
    }
    if (S && S.phase === 'tanks') tkPaint();
  }

  /* One continuous paint loop. Packets set state; the loop draws it. */
  let tkRaf = 0;
  function tkPaint() {
    if (!S || S.phase !== 'tanks') return;
    const f = tkField;
    if (f && f.units) {
      for (const u of f.units) {
        const cur = tkPos.get(u.id);
        if (!cur) continue;
        cur.x += (u.x - cur.x) * 0.34;
        cur.y += (u.y - cur.y) * 0.34;
      }
    }
    tkDrawField(S);
  }

  function tkStartLoop() {
    if (tkRaf) return;
    const beat = () => {
      if (!S || S.phase !== 'tanks') { tkRaf = 0; return; }
      tkRaf = requestAnimationFrame(beat);
      tkPaint();
    };
    tkRaf = requestAnimationFrame(beat);
  }

  function tkColourIndex(st, id) {
    const i = (st.players || []).findIndex((p) => p.id === id);
    return i < 0 ? 7 : i % TK2_TANK.length;
  }

  function tkDrawField(st) {
    const cv = $('tk-canvas');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const f = tkField;
    const W = cv.width, H = cv.height;

    ctx.fillStyle = '#0b0f16';
    ctx.fillRect(0, 0, W, H);

    if (!f || !f.map || !f.map.length) {
      ctx.fillStyle = '#6b7386';
      ctx.font = '13px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('waiting for the field…', W / 2, H / 2);
      return;
    }

    const cols = f.map[0].length, rows = f.map.length;
    const cs = Math.min(W / cols, H / rows);
    const ox = (W - cols * cs) / 2;
    const oy = (H - rows * cs) / 2;

    /* floor grid, so movement reads even on an empty field */
    ctx.fillStyle = '#12161f';
    ctx.fillRect(ox, oy, cols * cs, rows * cs);
    ctx.strokeStyle = 'rgba(255,255,255,.035)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 1; c < cols; c++) {
      ctx.moveTo(ox + c * cs, oy);
      ctx.lineTo(ox + c * cs, oy + rows * cs);
    }
    for (let r = 1; r < rows; r++) {
      ctx.moveTo(ox, oy + r * cs);
      ctx.lineTo(ox + cols * cs, oy + r * cs);
    }
    ctx.stroke();

    /* walls */
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ch = f.map[r][c];
        const pal = TK2_COL[ch];
        if (!pal) continue;
        const x = ox + c * cs, y = oy + r * cs;
        ctx.fillStyle = pal[0];
        ctx.fillRect(x + 0.5, y + 0.5, cs - 1, cs - 1);
        if (ch === 'S') {
          /* a specular line so steel looks harder than brick */
          ctx.fillStyle = 'rgba(255,255,255,.16)';
          ctx.fillRect(x + 2, y + 2, cs - 4, Math.max(1, cs * 0.12));
        } else {
          /* brick courses */
          ctx.strokeStyle = 'rgba(0,0,0,.3)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, y + cs / 2);
          ctx.lineTo(x + cs, y + cs / 2);
          ctx.moveTo(x + cs / 2, y);
          ctx.lineTo(x + cs / 2, y + cs / 2);
          ctx.moveTo(x + cs / 4, y + cs / 2);
          ctx.lineTo(x + cs / 4, y + cs);
          ctx.moveTo(x + cs * 0.75, y + cs / 2);
          ctx.lineTo(x + cs * 0.75, y + cs);
          ctx.stroke();
        }
      }
    }

    /* bullets */
    const since = Math.min(0.09, (performance.now() - tkFieldAt) / 1000);
    for (const b of (f.bullets || [])) {
      const bx = b.x + (b.vx || 0) * since;
      const by = b.y + (b.vy || 0) * since;
      const x = ox + bx * cs, y = oy + by * cs;
      const rr = Math.max(2, cs * 0.17);
      ctx.beginPath();
      ctx.arc(x, y, rr * 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,209,102,.22)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.fillStyle = '#fff2b0';
      ctx.fill();
    }

    /* tanks */
    for (const u of (f.units || [])) {
      const sm = tkPos.get(u.id) || u;
      const px = ox + sm.x * cs, py = oy + sm.y * cs;
      const half = cs * 0.38;
      const self = u.id === (st && st.youId);
      const ci = tkColourIndex(st || { players: [] }, u.id);
      const pal = TK2_TANK[ci];

      if (!u.alive) {
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#2a2f3a';
        ctx.fillRect(px - half, py - half, half * 2, half * 2);
        ctx.strokeStyle = '#ff4d3d';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px - half * 0.6, py - half * 0.6);
        ctx.lineTo(px + half * 0.6, py + half * 0.6);
        ctx.moveTo(px + half * 0.6, py - half * 0.6);
        ctx.lineTo(px - half * 0.6, py + half * 0.6);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      /* body */
      const g = ctx.createLinearGradient(px - half, py - half, px + half, py + half);
      g.addColorStop(0, pal[0]);
      g.addColorStop(1, pal[1]);
      ctx.fillStyle = g;
      ctx.fillRect(px - half, py - half, half * 2, half * 2);

      /* treads */
      ctx.fillStyle = 'rgba(0,0,0,.42)';
      if (u.dir === 0 || u.dir === 2) {
        ctx.fillRect(px - half, py - half, half * 0.42, half * 2);
        ctx.fillRect(px + half - half * 0.42, py - half, half * 0.42, half * 2);
      } else {
        ctx.fillRect(px - half, py - half, half * 2, half * 0.42);
        ctx.fillRect(px - half, py + half - half * 0.42, half * 2, half * 0.42);
      }

      /* barrel */
      ctx.fillStyle = self ? '#fff2b0' : '#e6ecf6';
      const bl = half * 1.15, bw = Math.max(2, half * 0.3);
      if (u.dir === 0) ctx.fillRect(px - bw / 2, py - half - bl * 0.55, bw, bl);
      else if (u.dir === 2) ctx.fillRect(px - bw / 2, py + half - bl * 0.45, bw, bl);
      else if (u.dir === 3) ctx.fillRect(px - half - bl * 0.55, py - bw / 2, bl, bw);
      else ctx.fillRect(px + half - bl * 0.45, py - bw / 2, bl, bw);

      /* turret */
      ctx.beginPath();
      ctx.arc(px, py, half * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = self ? '#ffd166' : '#dfe6f2';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.45)';
      ctx.lineWidth = 1;
      ctx.stroke();

      /* self marker */
      if (self) {
        ctx.strokeStyle = 'rgba(255,209,102,.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px - half - 2, py - half - 2, half * 2 + 4, half * 2 + 4);
      }

      /* health bar */
      const hbw = half * 2, hx = px - half, hy = py - half - 7;
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(hx, hy, hbw, 3);
      ctx.fillStyle = u.hp > 60 ? '#3ddc84' : u.hp > 25 ? '#ffb703' : '#ff4d3d';
      ctx.fillRect(hx, hy, hbw * Math.max(0, u.hp / 100), 3);
    }
  }

  function renderTanks(st) {
    const t = st.tanks;

    $('tk-round').textContent = 'Round ' + Math.min(t.round, t.rounds) + ' of ' + t.rounds;
    const mine = t.you;
    const alive = mine && mine.alive;
    if (t.state === 'gap') {
      $('tk-turn').textContent = 'next round…';
    } else if (!alive) {
      $('tk-turn').textContent = 'destroyed';
    } else {
      $('tk-turn').textContent = t.left ? Math.ceil(t.left / 1000) + 's' : 'live';
    }

    /* unit readout */
    $('tk-units').innerHTML = (t.units || []).map((u) => {
      const p = st.players.find((q) => q.id === u.id);
      const cls = (u.id === st.youId ? 'me ' : '') + (u.alive ? '' : 'dead ');
      return '<div class="tkunit ' + cls + '">' +
        '<span class="tkun">' + esc(p ? p.name : '?') + '</span>' +
        '<span class="tkhp"><i style="width:' + Math.max(0, u.hp) + '%"></i></span>' +
        '<span class="tkhpv">' + (u.alive ? u.hp : '—') + '</span></div>';
    }).join('');

    /* D-pad live only while it is worth pressing */
    const canDrive = t.state === 'live' && alive;
    for (const id of ['tk-up', 'tk-down', 'tk-left', 'tk-right']) {
      const el = $(id);
      if (el) el.disabled = !canDrive;
    }
    const fb = $('tk-fire');
    if (fb) fb.disabled = !canDrive;

    const ov = $('tk-overlay');
    if (t.state === 'gap') {
      ov.textContent = t.roundWinner
        ? t.roundWinner + ' takes round ' + t.round
        : 'Round ' + t.round + ' drawn';
      ov.classList.remove('hidden');
    } else if (!alive) {
      ov.textContent = 'Destroyed — watching';
      ov.classList.remove('hidden');
    } else {
      ov.classList.add('hidden');
    }

    if (!tkField || !tkField.map || !tkField.map.length) {
      tkField = { map: t.map, units: t.units, bullets: t.bullets || [], state: t.state };
      tkFieldAt = performance.now();
      for (const u of (t.units || [])) tkPos.set(u.id, { x: u.x, y: u.y });
    } else {
      tkField.units = t.units;
      tkField.bullets = t.bullets || [];
      tkField.state = t.state;
      if (t.map && t.map.length) tkField.map = t.map;
    }
    tkDrawField(st);
    tkStartLoop();
  }

  function tkSend(force) {
    if (!ws || ws.readyState !== 1) return;
    const t = performance.now();
    if (!force && t - tkLastSend < 60) return;
    tkLastSend = t;
    try {
      ws.send(JSON.stringify({ t: 'in', d: tkHeld === null ? null : tkHeld }));
    } catch (e) { /* socket gone */ }
  }

  function tkBind() {
    const cv = $('tk-canvas');
    if (cv && !cv.dataset.bound) {
      cv.dataset.bound = '1';
      /* size the backing store to the element so the grid is sharp on a phone */
      const fit = () => {
        const w = cv.clientWidth || 320;
        const rows = (tkField && tkField.map) ? tkField.map.length : 19;
        const cols = (tkField && tkField.map) ? tkField.map[0].length : 25;
        const h = Math.round((w * rows) / cols);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.height = h + 'px';
        if (S && S.phase === 'tanks') tkDrawField(S);
      };
      fit();
      window.addEventListener('resize', fit);
      setInterval(fit, 700);
    }

    const bind = (id, dir) => {
      const el = $(id);
      if (!el || el.dataset.bound) return;
      el.dataset.bound = '1';
      const start = (e) => {
        e.preventDefault();
        tkHeld = dir;
        tkSend(true);
      };
      const stop = (e) => {
        if (e) e.preventDefault();
        if (tkHeld === dir) { tkHeld = null; tkSend(true); }
      };
      el.addEventListener('pointerdown', start);
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, stop);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    bind('tk-up', 0);
    bind('tk-right', 1);
    bind('tk-down', 2);
    bind('tk-left', 3);

    const fire = $('tk-fire');
    if (fire && !fire.dataset.bound) {
      fire.dataset.bound = '1';
      fire.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (!S || S.phase !== 'tanks') return;
        beep(300, 0.05, 'square', 0.06);
        act('fire');
      });
    }

    if (!window.__tkKeys) {
      window.__tkKeys = true;
      const map = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3, w: 0, d: 1, s: 2, a: 3 };
      window.addEventListener('keydown', (e) => {
        if (!S || S.phase !== 'tanks') return;
        const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (k === ' ') { e.preventDefault(); act('fire'); return; }
        const dir = map[k];
        if (dir === undefined) return;
        e.preventDefault();
        if (tkHeld !== dir) { tkHeld = dir; tkSend(true); }
      });
      window.addEventListener('keyup', (e) => {
        const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        const dir = map[k];
        if (dir === undefined) return;
        if (tkHeld === dir) { tkHeld = null; tkSend(true); }
      });
      setInterval(() => {
        if (S && S.phase === 'tanks' && tkHeld !== null) tkSend(false);
      }, 80);
    }
  }

  function renderOver(st) {
    const w = st.players.find((p) => p.id === st.winnerId);
    $('over-kicker').textContent = st.game === 'stop' ? 'Dead Stop'
      : st.game === 'panic' ? 'Ink Panic'
      : st.game === 'bonk' ? 'Bonk Arena'
      : st.game === 'tanks' ? 'Tanks' : 'Bomb Word';
    $('over-name').textContent = w ? w.name : 'draw';
    $('over-sub').textContent = st.overText || '';
    show('btn-again', st.hostId === st.youId);
  }

  function renderPlayers(st) {
    $('players').innerHTML = st.players.map((p) => {
      const tags = [];
      if (p.id === st.hostId) tags.push('host');
      if (p.id === st.youId) tags.push('you');
      if (!p.live) tags.push('away');
      if (st.phase === 'bomb') {
        if (p.id === st.bomb.turnId) tags.push('bomb');
        if (p.lives <= 0) tags.push('out');
      }
      if (st.phase === 'stop') {
        if (p.id === st.stop.order[st.stop.idx] && !st.stop.running) tags.push('up');
        if (p.id === st.stop.runningPid) tags.push('holding');
      }
      if (st.phase === 'panic') {
        if (st.panic.solvedBy === p.id) tags.push('took it');
        else if (st.panic.locked.includes(p.id)) tags.push('out');
        else if (!st.panic.solvedBy) tags.push('in');
      }
      if (st.phase === 'bonk') {
        const bd = snap ? snap.bodies.find((x) => x[0] === p.id) : null;
        if (bd && bd[3] !== 1) tags.push('fell');
      }
      if (st.phase === 'tanks') {
        const u = (st.tanks.units || []).find((x) => x.id === p.id);
        if (u) tags.push(u.alive ? u.hp + 'hp' : 'destroyed');
      }
      const cls = (st.phase === 'bomb' && st.bomb.turnId === p.id ? 'turn ' : '') +
        (st.phase === 'bomb' && p.lives <= 0 ? 'out' : '');
      const hearts = '●'.repeat(Math.max(0, Math.min(3, p.lives))) +
        '○'.repeat(Math.max(0, 3 - p.lives));
      return '<li class="' + cls + '">' +
        '<span class="nm">' + esc(p.name) + '</span>' +
        '<span class="tagline">' + esc(tags.join(' · ')) + '</span>' +
        '<span class="pts">' + p.score + '</span>' +
        (st.phase === 'bomb' ? '<span class="hearts">' + hearts + '</span>' : '') +
        '</li>';
    }).join('');
  }

  function renderFeed(st) {
    $('feed').innerHTML = st.feed.slice(-40).reverse().map((e) => {
      if (e.k === 'word' || e.k === 'try') {
        return '<li><span class="w">' + esc(e.text) + '</span><span class="who">' + esc(e.name) + '</span></li>';
      }
      if (e.k === 'miss') {
        return '<li><span class="missmark">miss</span><span>' + esc(e.name) + ' · ' + esc(e.text) + '</span></li>';
      }
      if (e.k === 'boom') {
        return '<li><span class="boom">boom</span><span>' + esc(e.name) + ' — ' + esc(e.text) + '</span></li>';
      }
      if (e.k === 'join') {
        return '<li><span class="sys">' + esc(e.name) + ' joined</span></li>';
      }
      return '<li><span class="sys">' + esc(e.text) + '</span></li>';
    }).join('');
  }

  function render() {
    const st = S;
    if (!st) return;
    show('s-join', false);
    show('s-room', true);
    $('roomcode').textContent = st.code;

    const playing = st.phase === 'bomb' || st.phase === 'stop' || st.phase === 'panic' ||
      st.phase === 'bonk' || st.phase === 'tanks';
    show('stage-lobby', st.phase === 'lobby');
    show('stage-bomb', st.phase === 'bomb');
    show('stage-stop', st.phase === 'stop');
    show('stage-panic', st.phase === 'panic');
    show('stage-bonk', st.phase === 'bonk');
    show('stage-tanks', st.phase === 'tanks');
    show('stage-over', st.phase === 'over');
    if (!playing) wasMine = false;

    if (st.phase === 'lobby') renderLobby(st);
    if (st.phase === 'bomb') renderBomb(st);
    if (st.phase === 'stop') renderStop(st);
    if (st.phase === 'panic') renderPanic(st);
    if (st.phase === 'bonk') renderBonk(st);
    if (st.phase === 'tanks') renderTanks(st);
    if (st.phase === 'over') renderOver(st);

    renderPlayers(st);
    renderFeed(st);
  }

  /* ----------------------------- timer ----------------------------- */

  function loop() {
    requestAnimationFrame(loop);
    if (!S || S.phase !== 'bomb' || !S.bomb.deadline) return;
    const left = Math.max(0, S.bomb.deadline - (Date.now() + skew));
    const total = Math.max(1, S.bomb.timeMs);
    $('bar').style.width = Math.min(100, (left / total) * 100) + '%';
    $('clock').textContent = (left / 1000).toFixed(1) + 's';
    $('bomb').classList.toggle('tick', left < 6000 && left > 0);
    const sec = Math.ceil(left / 1000);
    if (left > 0 && left < 5200 && sec !== lastTick) {
      lastTick = sec;
      beep(620 + (5 - Math.min(5, sec)) * 110, 0.04, 'square', 0.05);
    }
    if (left <= 0) lastTick = -1;
  }

  /* ----------------------------- sound ----------------------------- */

  let ac = null;
  function beep(freq, dur, type, vol) {
    if (!sound) return;
    try {
      if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      g.gain.value = vol || 0.12;
      o.connect(g);
      g.connect(ac.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      o.stop(ac.currentTime + dur + 0.02);
    } catch (e) { /* audio is a luxury, not a requirement */ }
  }

  function boomFx() {
    beep(180, 0.35, 'sawtooth', 0.22);
    setTimeout(() => beep(90, 0.45, 'square', 0.18), 60);
    document.body.classList.remove('shake');
    void document.body.offsetWidth;
    document.body.classList.add('shake');
    const b = $('bomb');
    b.classList.remove('boomout');
    void b.offsetWidth;
    b.classList.add('boomout');
  }

  /* ----------------------------- wiring ----------------------------- */

  const nameVal = () => ($('name').value || '').trim().slice(0, 14);

  $('btn-create').addEventListener('click', () => join(null, nameVal(), null));
  $('btn-join').addEventListener('click', () => {
    const code = ($('code').value || '').trim().toUpperCase();
    if (code.length < 4) { $('join-err').textContent = 'Codes are four characters.'; return; }
    join(code, nameVal(), null);
  });
  $('code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
  $('name').addEventListener('keydown', (e) => { if (e.key === 'Enter' && $('code').value) $('btn-join').click(); });

  $('word-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendWord($('word').value);
  });

  async function copyLink() {
    const url = inviteUrl();
    try {
      await navigator.clipboard.writeText(url);
      flash('Invite link copied.', true);
    } catch (e) {
      window.prompt('Copy this link:', url);
    }
  }
  $('btn-share').addEventListener('click', copyLink);
  $('roomcode').addEventListener('click', copyLink);

  $('pick-bomb').addEventListener('click', () => act('pick', { game: 'bomb' }));
  $('pick-stop').addEventListener('click', () => act('pick', { game: 'stop' }));
  $('pick-panic').addEventListener('click', () => act('pick', { game: 'panic' }));
  $('pick-bonk').addEventListener('click', () => act('pick', { game: 'bonk' }));
  $('pick-tanks').addEventListener('click', () => act('pick', { game: 'tanks' }));
  tkBind();

  /* bonk controls: pointer press/release on the pad, plus WASD / arrows */
  const bindHold = (id, on, off) => {
    const el = $(id);
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); on(); sendInput(true); });
    for (const evName of ['pointerup', 'pointercancel', 'pointerleave']) {
      el.addEventListener(evName, () => { off(); sendInput(true); });
    }
  };
  bindHold('bk-left', () => { keys.l = true; }, () => { keys.l = false; });
  bindHold('bk-right', () => { keys.r = true; }, () => { keys.r = false; });
  $('bk-jump').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if ($('bk-jump').disabled) return;
    jumpQueued = true;
    sendInput(true);
    beep(300, 0.05, 'square', 0.06);
  });

  const keyMap = { ArrowLeft: 'l', a: 'l', A: 'l', ArrowRight: 'r', d: 'r', D: 'r' };
  window.addEventListener('keydown', (e) => {
    if (!S || S.phase !== 'bonk') return;
    const k = keyMap[e.key];
    if (k) { keys[k] = true; sendInput(true); e.preventDefault(); return; }
    if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
      jumpQueued = true;
      sendInput(true);
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = keyMap[e.key];
    if (k) { keys[k] = false; sendInput(true); }
  });

  for (const c of COLORS) {
    $('pad-' + c.toLowerCase()).addEventListener('click', async (ev) => {
      if (!S || S.phase !== 'panic') return;
      const btn = ev.currentTarget;
      btn.disabled = true;
      const j = await act('tap', { pick: c });
      if (j && !j.ok) {
        $('panic-flash').textContent = j.e || '';
      } else {
        beep(c === 'RED' ? 520 : c === 'BLUE' ? 600 : c === 'GREEN' ? 680 : 760, 0.06, 'square', 0.06);
      }
    });
  }

  $('btn-start').addEventListener('click', () => act('start', { game: S ? S.game : 'bomb' }));
  $('btn-again').addEventListener('click', () => act('again'));

  async function doGo() {
    if (!S) return;
    flash('', false, 'stop');
    const j = await act('go');
    if (j && j.ok) beep(300, 0.05, 'square', 0.06);
  }

  async function doHit() {
    if (!S || !S.stop.running) return;
    await act('hit');
  }

  $('btn-go').addEventListener('click', doGo);
  $('btn-hit').addEventListener('click', doHit);

  $('btn-sound').addEventListener('click', () => {
    sound = !sound;
    $('btn-sound').textContent = sound ? '🔊' : '🔇';
    if (sound) beep(660, 0.08, 'sine', 0.1);
  });

  $('btn-leave').addEventListener('click', async () => {
    if (!confirm('Leave this session?')) return;
    await act('leave');
    store.clear();
    location.href = location.pathname;
  });

  /* ----------------------------- boot ----------------------------- */

  /* The join screen's copy is derived from the game tiles themselves, so it
     cannot drift out of sync when a game is added or removed. One list. */
  function syncJoinCopy() {
    const tiles = [...document.querySelectorAll('#stage-lobby .pick')];
    const names = tiles.map((t) => (t.querySelector('.pick-name') || {}).textContent || '');
    const subs = tiles.map((t) => (t.querySelector('.pick-sub') || {}).textContent || '');
    const n = tiles.length;
    const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    const count = words[n] || String(n);

    const tag = $('join-tag');
    if (tag) tag.textContent = count.charAt(0).toUpperCase() + count.slice(1) +
      (n === 1 ? ' game' : ' games') + '. One room. Pass a phone or hold your own.';

    const fine = $('join-games');
    if (fine) {
      fine.textContent = names
        .map((nm, i) => nm.toUpperCase() + ': ' + (subs[i] || '').replace(/\.$/, ''))
        .join('. ') + '. Host picks in the lobby.';
    }
  }

  (function boot() {
    const q = new URLSearchParams(location.search);
    const qroom = (q.get('room') || '').toUpperCase();
    if (qroom) $('code').value = qroom;
    syncJoinCopy();
    const saved = store.get();
    const nameInput = $('name');
    try { nameInput.value = localStorage.getItem('partysuite-name') || ''; } catch (e) { /* ignore */ }
    nameInput.addEventListener('change', () => {
      try { localStorage.setItem('partysuite-name', nameInput.value.trim().slice(0, 14)); } catch (e) { /* ignore */ }
    });

    if (saved && saved.room && saved.secret && (!qroom || qroom === saved.room)) {
      join(saved.room, saved.name || nameInput.value, saved);
    } else {
      show('s-join', true);
      show('s-room', false);
      if (nameInput.value && !qroom) setTimeout(() => nameInput.focus(), 200);
    }
    loop();
    bonkInputLoop();
  })();
})();
