/* Horizon app: the panels, the daily loop, and the wiring to Claude, voice and saved data. */
(function () {
  'use strict';
  var HZ = window.HZ, ENV = window.HZEnv, SOLO = ENV.standalone, store = window.HZStore.create(), world = null;
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var app = $('#app'), sheet = $('#sheet'), filmEl = $('#film'), scrim = $('#scrim'), dialog = $('#dialog'), toastEl = $('#toast');
  var wide = window.matchMedia('(min-width: 920px)'), calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  var VIEWS = ['map', 'today', 'bets', 'concepts', 'more'];
  var HIDE = ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'];
  var KEYISH = ['bad_key', 'org_blocked', 'billing', 'no_permission', 'need_workspace', 'bad_workspace', 'bad_model']; // trouble with the key or the account, not with the entry
  var MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/></svg>';

  var S = {
    state: HZ.newState(), ready: false, loadNote: '',
    caps: { sample: null, dictation: null, tts: null, downloads: null, user: null },
    view: 'today', sub: null, sel: null, mapKey: false, lastKey: '',
    drafts: {}, voiced: {}, listening: null, partial: '',
    working: null, error: null, result: null, care: null,
    deepen: null, betFor: null, exp: null, tog: null, film: null, speaking: false,
    ctl: null, dlg: null, kept: false, connBusy: false
  };

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtDate(x) { try { return new Date(x).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }
  function fmtDay(key) { var p = String(key).split('-'); try { return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); } catch (e) { return key; } }
  function regionName(id) { return HZ.REGIONS[HZ.regionIndex(id)].name; }
  function unit(id) { return HZ.unitById(S.state, id); }
  function noop() {}
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(function () { toastEl.classList.remove('on'); }, 3200); }
  function ask2(title, body, yes, danger) {
    return new Promise(function (res) {
      dialog.innerHTML = '<h2 id="dialog-t">' + esc(title) + '</h2><p>' + esc(body) + '</p><div class="btns"><button class="btn' + (danger ? ' ghost danger' : '') + '" type="button" data-act="dlg" data-v="1">' + esc(yes) + '</button><button class="btn text" type="button" data-act="dlg" data-v="0">Cancel</button></div>';
      scrim.hidden = false; S.dlg = res;
      var b = $('button', dialog); if (b) b.focus();
    });
  }
  function persist() { store.save(S.state); }
  function changed() { persist(); world.setState(S.state); render(); }
  function copyFor(code) {
    if (code === 'rate_limited') return SOLO ? 'Anthropic is limiting how fast this key can be used. Wait a minute, then try again.' : 'Claude is busy, or you have reached a usage limit. Wait a little, then try again.';
    if (code === 'session_expired') return 'You have been signed out. Sign in to Claude again, then try again.';
    if (code === 'refused') return 'Claude declined to read this entry. Try wording it differently.';
    if (code === 'invalid_json' || code === 'empty_completion') return 'The reply came back garbled. Try again.';
    if (code === 'cut_off') return 'The reply was cut off before it finished. Try again.';
    if (code === 'prompt_too_large') return 'That is too long to read in one go. Send a shorter entry.';
    if (code === 'bad_key') return 'Anthropic did not accept the key. It may have been mistyped or revoked.';
    if (code === 'bad_key_format') return 'That does not look like a Claude API key. Paste the whole key.';
    if (code === 'org_blocked') return 'Your Claude organization does not let its keys be used from a web page. That is set on the organization, so nothing on this page can change it. A key from a personal account works.';
    if (code === 'billing') return 'Your Anthropic account needs credit, a payment method or a higher spend limit. Check billing in the Claude Console.';
    if (code === 'no_permission') return 'This key is not allowed to do that. Check what the key can use in the Claude Console.';
    if (code === 'need_workspace') return 'This key is not tied to one workspace, so Anthropic needs to be told which one to use. Add a workspace ID under Advanced, or make a key for a single workspace.';
    if (code === 'bad_workspace') return 'Anthropic did not recognise the workspace ID. Check it in the Claude Console.';
    if (code === 'bad_model') return 'Anthropic did not recognise a model name. Check the names under Advanced.';
    if (code === 'bad_request') return 'Anthropic did not accept the request.';
    if (code === 'overloaded') return 'Claude is overloaded right now. Try again in a minute.';
    if (code === 'timeout') return 'Claude took too long to answer. Try again.';
    if (code === 'network') return 'Could not reach Claude. Check your connection, then try again.';
    return 'The connection to Claude dropped. Try again.';
  }
  function said(detail) { return detail ? '<p class="small">Anthropic said: ' + esc(detail) + '</p>' : ''; }
  function ext(href, label) { return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>'; }
  /* One call to Claude. Resolves {data}, {offline:true} when Claude cannot be used in this view, or {error: code}. */
  async function ask(prompt, tier) {
    var sample = S.caps.sample;
    if (!sample) return { offline: true };
    S.ctl = new AbortController();
    try { return { data: await sample.json(prompt, { modelTier: tier || 'default', signal: S.ctl.signal }) }; }
    catch (e) {
      var code = e && typeof e.code === 'string' ? e.code : 'upstream_error';
      if (HIDE.indexOf(code) !== -1) { S.caps.sample = null; return { offline: true }; }
      return { error: code, detail: (e && e.detail) || '' };
    } finally { S.ctl = null; }
  }

  /* ---------- pieces ---------- */
  function micBtn(id) {
    if (!S.caps.dictation) return '';
    var on = S.listening === id;
    return '<button class="btn mic" type="button" data-act="mic" data-for="' + id + '" aria-pressed="' + on + '" aria-label="' + (on ? 'Stop listening' : 'Speak instead of typing') + '">' + MIC + '</button>';
  }
  function composer(id, label, act, ph, o) {
    o = o || {};
    var val = S.drafts[id] || '';
    return '<textarea id="t-' + id + '" data-draft="' + id + '"' + (o.small ? ' class="sm"' : '') + ' placeholder="' + esc(ph) + '" aria-labelledby="p-' + id + '">' + esc(val) + '</textarea>' +
      '<p class="partial" id="partial-' + id + '">' + (S.listening === id ? esc(S.partial) : '') + '</p>' +
      '<div class="field-row">' + micBtn(id) + '<button class="btn" type="button" data-act="' + act + '" data-need="' + id + '"' + (o.id ? ' data-id="' + o.id + '"' : '') + (val.trim() && S.ready ? '' : ' disabled') + '>' + esc(label) + '</button></div>';
  }
  function syncNeed(id) {
    var has = !!(S.drafts[id] || '').trim() && S.ready;
    sheet.querySelectorAll('[data-need="' + id + '"]').forEach(function (b) { b.disabled = !has; });
  }
  function betForm(unitId, moveId, days) {
    var has = (S.drafts.bet || '').trim();
    return '<div class="field"><label for="t-bet">Your prediction, worded so it clearly holds or fails</label>' +
      '<textarea id="t-bet" data-draft="bet" class="sm" placeholder="By Friday…">' + esc(S.drafts.bet || '') + '</textarea>' +
      '<label for="bet-days">Check it in</label><select id="bet-days">' + [3, 7, 14, 21].map(function (n) { return '<option value="' + n + '"' + (n === (days || 7) ? ' selected' : '') + '>' + n + ' days</option>'; }).join('') + '</select>' +
      '<div class="btns"><button class="btn" type="button" data-act="bet-take" data-id="' + unitId + '" data-need="bet"' + (has ? '' : ' disabled') + '>Take the bet</button>' +
      '<button class="btn text" type="button" data-act="bet-cancel"' + (moveId ? ' data-move="' + moveId + '"' : '') + '>Not now</button></div></div>';
  }
  function storeNote() {
    var m = store.mode(), st = store.status();
    if (m === 'db') return st.error ? '<p class="note warn">The last change could not be saved (' + esc(st.error) + '). It will go out with your next change.</p>' : '';
    if (m === 'local') return '<p class="small">Saved in this browser only.</p>';
    return '<p class="note warn">Nothing is being saved in this view.</p>';
  }

  /* On a plain website the map lives in one browser, so now and then it is worth a nudge to save a copy. */
  function backupDue() {
    if (!SOLO || store.mode() !== 'local' || S.state.entries.length < 3) return false;
    var b = ENV.local.get('backup.v1') || {};
    return Date.now() - Math.max(+b.savedAt || 0, +b.laterAt || 0) > 14 * 864e5;
  }
  function backedUp() { if (SOLO) ENV.local.set('backup.v1', { savedAt: Date.now() }); }
  /* Maps other people sent as share codes. Kept apart from your own map. */
  function friends() {
    var f = ENV.local.get('friends.v1');
    return (Array.isArray(f) ? f : []).map(function (p) {
      var n = p && HZ.normalizeShare(p);
      return n && n.units.length ? { id: String(p.id), name: HZ.clip(HZ.str(p.name), 40) || 'A friend', units: n.units, at: n.at } : null;
    }).filter(Boolean);
  }

  /* ---------- Today ---------- */
  function vToday() {
    if (!S.ready) return '<div class="panel"><p class="status"><i></i>Opening your world</p></div>';
    if (S.working) return '<div class="panel working"><blockquote class="quote">' + esc(HZ.clip(S.working.text, 700)) + '</blockquote><p class="status"><i></i>' + esc(S.working.label) + '</p><p class="hint">This usually takes under a minute.</p>' + (S.caps.sample ? '<button class="btn ghost" type="button" data-act="stop">Stop</button>' : '') + '</div>';
    if (S.error) return '<div class="panel"><div class="banner err"><p class="lbl">Not placed yet</p><p>' + esc(copyFor(S.error.code)) + '</p>' + said(S.error.detail) + '</div><blockquote class="quote">' + esc(HZ.clip(S.error.text, 700)) + '</blockquote><div class="btns"><button class="btn" type="button" data-act="retry">Try again</button>' + (SOLO && KEYISH.indexOf(S.error.code) !== -1 ? '<button class="btn ghost" type="button" data-act="more" data-sub="claude">Open Claude settings</button>' : '') + '<button class="btn ghost" type="button" data-act="retry-offline">Place it without Claude</button><button class="btn text" type="button" data-act="edit-entry">Edit it</button></div></div>';
    if (S.care) return vCare();
    if (S.result) return vResult();
    var st = S.state, door = HZ.openDoor(st), first = !st.entries.length, h = '<div class="panel">';
    if (S.loadNote) h += '<p class="note warn">' + esc(S.loadNote) + '</p>';
    HZ.dueBets(st).forEach(function (b) { h += dueBet(b); });
    h += '<div class="field"><h2 class="prompt" id="p-today">' + esc(door ? door.text : first ? 'What is on your mind?' : 'What is on your mind today?') + '</h2>';
    h += '<p class="hint">' + (door ? 'This is the door you were left with. Answer it, or say whatever is on your mind instead.' : first ? 'Say it the way you would to a friend. Two minutes is plenty. It goes on the map in your own words.' : 'Two minutes is plenty.') + '</p>';
    h += composer('today', 'Place it on the map', 'submit-today', 'Speak or type') + '</div>';
    if (!S.caps.dictation) h += '<p class="small">On a phone, the microphone key on the keyboard works here.</p>';
    if (!S.caps.sample) h += SOLO
      ? '<div class="nudge"><p>Claude is not connected, so a simple built-in reader is sorting your sentences. Connect Claude for real readings.</p><button class="btn sm ghost" type="button" data-act="more" data-sub="claude">Connect Claude</button></div>'
      : '<p class="small">Claude is not connected in this view, so entries are read by a simple built-in reader. Open the page inside Claude for the full reading.</p>';
    if (backupDue()) h += '<div class="nudge"><p>Your map lives only in this browser. A saved copy protects it.</p><span class="btns"><button class="btn sm ghost" type="button" data-act="more" data-sub="data">Save a copy</button><button class="btn sm text" type="button" data-act="backup-later">Later</button></span></div>';
    h += storeNote();
    if (SOLO && first) h += '<p class="small"><button class="link" type="button" data-act="more" data-sub="about">What Horizon is, and where your words go</button></p>';
    var last = st.moves[st.moves.length - 1];
    if (last) h += '<div class="section"><h3>Last move, ' + esc(fmtDate(last.at)) + '</h3><p><button class="link" type="button" data-act="show-move" data-id="' + last.id + '">' + esc(HZ.MOVES[last.kind] + ': ' + last.title) + '</button></p></div>';
    return h + '</div>';
  }
  function dueBet(b) {
    var u = unit(b.unit);
    return '<div class="banner"><p class="lbl">A bet came due, ' + esc(fmtDay(b.due)) + '</p><blockquote class="quote sm">' + esc(b.text) + '</blockquote>' +
      (u ? '<p class="small">It tests: <button class="link" type="button" data-act="open" data-kind="unit" data-id="' + u.id + '">' + esc(u.label) + '</button></p>' : '') +
      '<div class="btns"><button class="btn sm" type="button" data-act="bet-resolve" data-id="' + b.id + '" data-out="held">It held</button><button class="btn sm ghost" type="button" data-act="bet-resolve" data-id="' + b.id + '" data-out="failed">It did not hold</button><button class="btn sm text" type="button" data-act="bet-resolve" data-id="' + b.id + '" data-out="void">Cannot tell</button></div></div>';
  }
  function vMove(m) {
    var st = S.state, h = '<article class="move k-' + m.kind + '"><p class="kind"><b>' + esc(HZ.MOVES[m.kind]) + '</b><span>' + esc(HZ.MOVE_BLURB[m.kind]) + '</span></p>';
    h += '<h2>' + esc(m.title) + '</h2><p class="body">' + esc(m.body) + '</p>';
    var refs = m.refs.map(unit).filter(Boolean);
    if (refs.length) h += '<p class="small">About ' + refs.map(function (u) { return '<button class="link" type="button" data-act="open" data-kind="unit" data-id="' + u.id + '">' + esc(u.label) + '</button>'; }).join(' and ') + '</p>';
    var c = m.concept && HZ.byId(st.concepts, m.concept);
    if (c) h += '<div class="concept"><p class="lbl">Collected</p><h3>' + esc(c.name) + '</h3><p>' + esc(c.gist) + '</p>' + (c.disputed ? '<p class="small">Disputed: ' + esc(c.disputed) + '</p>' : '') + '</div>';
    if (m.betDraft && unit(m.betDraft.unit)) h += '<div class="section"><h3>Take it as a bet</h3>' + betForm(m.betDraft.unit, m.id, m.betDraft.dueDays) + '</div>';
    if (m.offline) h += '<p class="small">A simple reply from the built-in reader. Claude was not connected for this one.</p>';
    return h + '</article>';
  }
  /* Shown instead of a move when what was said sounds like a crisis. Nothing is placed and nothing is saved. */
  function vCare() {
    var C = S.care;
    return '<div class="panel"><article class="move care"><h2>' + esc(C.title) + '</h2><p class="body">' + esc(C.body) + '</p>' +
      '<p>Crisis lines by country: ' + ext(ENV.links.helplines, 'findahelpline.com') + '</p>' +
      '<p class="small">Nobody reads what you write in Horizon, so nobody here can answer you or send help. Nothing was placed on the map' + (C.o && C.o.expedition ? '.' : ', and your words are still in the box.') + '</p></article>' +
      '<div class="btns"><button class="btn" type="button" data-act="care-back">Back</button><button class="btn text" type="button" data-act="care-place">This is not about me. Place it on the map</button></div></div>';
  }
  function vResult() {
    var st = S.state, m = HZ.byId(st.moves, S.result.move), h = '<div class="panel">';
    if (!m) { S.result = null; return vToday(); }
    h += vMove(m);
    var us = S.result.units.map(unit).filter(Boolean);
    h += '<div class="section placed"><h3>Placed on your map</h3>';
    if (!us.length) h += '<p class="empty">Nothing new this time. Either it was already there, or there was not enough to place.</p>';
    else h += '<ul>' + us.map(function (u) {
      var ghost = u.status !== 'yours';
      return '<li><div class="row1"><span class="who"><button class="link" type="button" data-act="fly" data-kind="unit" data-id="' + u.id + '">' + esc(u.label) + '</button><span class="chip">' + HZ.TYPE_NAMES[u.type] + '</span><span class="chip">' + esc(regionName(u.region)) + '</span>' + (ghost ? '<span class="chip outline">Outline</span>' : '') + '</span>' +
        '<span class="btns">' + (ghost ? '<button class="btn sm" type="button" data-act="confirm" data-id="' + u.id + '">That is mine</button>' : '') + '<button class="btn sm text" type="button" data-act="remove" data-id="' + u.id + '">Not mine</button></span></div>' +
        '<blockquote class="quote sm">' + esc(u.text) + '</blockquote>' + (ghost ? '<p class="small">Not your exact words, so it stays an outline until you claim it.</p>' : '') + '</li>';
    }).join('') + '</ul>';
    h += '</div>';
    if (m.door) h += '<div class="section"><h3>A door for next time</h3><p>' + esc(m.door) + '</p></div>';
    if (m.takeTo) h += '<div class="section"><h3>Take this to someone</h3><p>' + esc(m.takeTo) + '</p></div>';
    h += '<div class="btns"><button class="btn" type="button" data-act="done">See the map</button>' + (S.caps.tts ? '<button class="btn ghost" type="button" data-act="speak" data-id="' + m.id + '">' + (S.speaking ? 'Stop reading' : 'Read it to me') + '</button>' : '') + '</div>';
    return h + '</div>';
  }

  /* ---------- detail: one thing on the map ---------- */
  function vDetail() {
    var st = S.state, k = S.sel.kind, id = S.sel.id;
    if (k === 'unit') { var u = unit(id); if (u) return vUnit(u); }
    if (k === 'concept') { var c = HZ.byId(st.concepts, id); if (c) return vConcept(c); }
    if (k === 'door') { var d = HZ.byId(st.doors, id); if (d && !d.answeredAt) return '<div class="panel"><button class="btn text back" type="button" data-act="back">Back</button><p class="chips"><span class="chip mint">Door</span><span class="chip">' + esc(regionName(d.region)) + '</span></p><h2>' + esc(d.text) + '</h2><p class="hint">A question waiting at the edge of the fog. Left on ' + esc(fmtDate(d.at)) + '.</p><div class="btns"><button class="btn" type="button" data-act="door-answer" data-id="' + d.id + '">Answer it now</button><button class="btn text" type="button" data-act="door-close" data-id="' + d.id + '">Close this door</button></div></div>'; }
    if (k === 'move') { var m = HZ.byId(st.moves, id); if (m) return '<div class="panel"><button class="btn text back" type="button" data-act="back">Back</button>' + vMove(m) + (m.door ? '<div class="section"><h3>The door it left</h3><p>' + esc(m.door) + '</p></div>' : '') + '</div>'; }
    S.sel = null; return viewHTML();
  }
  function vConcept(c) {
    var u = c.unit && unit(c.unit);
    return '<div class="panel"><button class="btn text back" type="button" data-act="back">Back</button><p class="chips"><span class="chip">Concept</span></p><h2>' + esc(c.name) + '</h2><p>' + esc(c.gist) + '</p>' +
      (c.disputed ? '<div class="section"><h3>Who disputes it</h3><p>' + esc(c.disputed) + '</p></div>' : '') +
      (u ? '<div class="section"><h3>You said it first, ' + esc(fmtDate(c.at)) + '</h3><blockquote class="quote">' + esc(u.text) + '</blockquote><p><button class="link" type="button" data-act="open" data-kind="unit" data-id="' + u.id + '">' + esc(u.label) + '</button></p></div>' : '') + '</div>';
  }
  function vUnit(u) {
    var st = S.state, d = u.depth || 0, ghost = u.status !== 'yours', i, h = '<div class="panel"><button class="btn text back" type="button" data-act="back">Back</button>';
    h += '<p class="chips"><span class="chip">' + HZ.TYPE_NAMES[u.type] + '</span><span class="chip">' + esc(regionName(u.region)) + '</span>' + (ghost ? '<span class="chip outline">Outline</span>' : '') + (u.tested ? '<span class="chip stone">In stone</span>' : '') + (u.cracked ? '<span class="chip ember">A bet on this failed</span>' : '') + '</p>';
    h += '<h2>' + esc(u.label) + '</h2><blockquote class="quote">' + esc(u.text) + '</blockquote>';
    if (ghost) return h + '<p class="hint">This is a guess at what you meant, not your exact words. It stays an outline, without a light, until you claim it.</p><div class="btns"><button class="btn" type="button" data-act="confirm" data-id="' + u.id + '">That is mine</button><button class="btn ghost" type="button" data-act="remove" data-id="' + u.id + '">Not mine</button></div></div>';
    h += '<p class="small">Your words, ' + esc(fmtDate(u.at)) + '. ' + esc(HZ.ORIGIN_NAMES[u.origin] || HZ.ORIGIN_NAMES.unknown) + '.</p>';
    h += '<div><div class="ladder" role="img" aria-label="Depth: ' + HZ.DEPTHS[d] + ', step ' + (d + 1) + ' of 5">';
    for (i = 0; i < 5; i++) h += '<span class="' + (i <= d ? 'on' + (u.tested ? ' stone' : '') : '') + '"></span>';
    h += '</div><p class="ladder-l"><span>Depth: <b>' + HZ.DEPTHS[d] + '</b></span><span>' + (d < 4 ? 'Next: ' + HZ.DEPTHS[d + 1].toLowerCase() : 'A prediction held') + '</span></p></div>';
    h += '<div class="conv"><span class="lbl" id="conv-l">How sure are you?</span><div class="dots" role="group" aria-labelledby="conv-l">';
    for (i = 1; i <= 5; i++) h += '<button type="button" data-act="conv" data-id="' + u.id + '" data-v="' + i + '" aria-pressed="' + (i <= (u.conviction || 3)) + '" aria-label="' + i + ' of 5"><i></i></button>';
    h += '</div></div>';
    if (u.cracked) h += '<div class="banner err"><p class="lbl">A prediction from this did not hold</p><p>You can keep it as it is, or say it the way you would say it now.</p><div class="btns"><button class="btn sm ghost" type="button" data-act="revise-start" data-id="' + u.id + '">Reword it</button></div></div>';
    h += vDeepen(u);
    if (u.notes && u.notes.length) {
      var names = { because: 'Your reason', challenge: 'The objection', reply: 'Your answer', was: 'Earlier wording' };
      h += '<div class="section"><h3>What you have added</h3><ul class="notes">' + u.notes.map(function (n) { return '<li><span class="lbl">' + (names[n.k] || 'Note') + '</span>' + (n.k === 'challenge' ? '<span>' + esc(n.text) + '</span>' : '<span class="quote sm">' + esc(n.text) + '</span>') + '</li>'; }).join('') + '</ul></div>';
    }
    var ls = HZ.linksOf(st, u.id);
    if (ls.length) {
      h += '<div class="section"><h3>Connected to</h3><ul class="notes">' + ls.map(function (l) {
        var o = unit(l.a === u.id ? l.b : l.a), from = l.a === u.id, rel;
        if (l.kind === 'contradicts') rel = l.state === 'open' ? 'A rift with' : l.state === 'held' ? 'A rift you hold knowingly, with' : 'A settled rift with';
        else if (l.kind === 'because') rel = from ? 'A reason for' : 'Backed by';
        else if (l.kind === 'example_of') rel = from ? 'An example of' : 'Shown by';
        else rel = 'The same idea as';
        return '<li><span class="lbl">' + rel + '</span><button class="link" type="button" data-act="open" data-kind="unit" data-id="' + o.id + '">' + esc(o.label) + '</button>' +
          (l.kind === 'contradicts' && l.state === 'open' ? '<span class="btns"><button class="btn sm ghost" type="button" data-act="rift" data-id="' + l.id + '" data-how="held">I hold both</button><button class="btn sm text" type="button" data-act="rift" data-id="' + l.id + '" data-how="settled">It is settled</button></span>' : '') + '</li>';
      }).join('') + '</ul></div>';
    }
    var bs = st.bets.filter(function (b) { return b.unit === u.id; });
    if (bs.length) h += '<div class="section"><h3>Bets on this</h3><ul class="notes">' + bs.map(function (b) { return '<li>' + betChip(b) + '<span class="quote sm">' + esc(b.text) + '</span></li>'; }).join('') + '</ul></div>';
    h += '<div class="btns">' + (d !== 3 && S.betFor !== u.id ? '<button class="btn ghost" type="button" data-act="bet-form" data-id="' + u.id + '">Make a bet on this</button>' : '') + '<button class="btn text danger" type="button" data-act="remove" data-id="' + u.id + '">Not mine, remove it</button></div>';
    return h + '</div>';
  }
  function betChip(b) {
    if (b.status === 'open') return '<span class="chip">Open, due ' + esc(fmtDay(b.due)) + '</span>';
    if (b.status === 'held') return '<span class="chip good">&#10003; Held</span>';
    if (b.status === 'failed') return '<span class="chip ember">&#10005; Did not hold</span>';
    return '<span class="chip">Set aside</span>';
  }
  function vDeepen(u) {
    var d = u.depth || 0, D = S.deepen && S.deepen.id === u.id ? S.deepen : null, h = '<div class="section">';
    if (S.betFor === u.id) return h + '<h3>Turn it into a prediction</h3>' + betForm(u.id, null, 7) + '</div>';
    if (D && D.revise) return h + '<h3 id="p-revise">Say it the way you would say it now</h3>' + composer('revise', 'Save the new wording', 'revise-save', 'In your words', { small: true, id: u.id }) + '<div class="btns"><button class="btn text" type="button" data-act="deepen-cancel">Cancel</button></div></div>';
    if (d === 0) h += '<h3 id="p-why">Why do you think this is true?</h3>' + composer('why', 'Save the reason', 'explain', 'Because…', { small: true, id: u.id });
    else if (d === 1) h += '<h3 id="p-story">Tell me about a time you saw this.</h3>' + composer('story', 'Add the story', 'exemplify', 'One time…', { small: true, id: u.id });
    else if (d === 2) {
      if (D && D.loading) h += '<p class="status"><i></i>Finding the strongest objection</p>';
      else if (D && D.challenge) h += '<div class="challenge"><p><b>' + esc(D.challenge.who) + '</b></p><p>' + esc(D.challenge.argument) + '</p></div><h3 id="p-reply">' + esc(D.challenge.question) + '</h3>' + composer('reply', 'Save my answer', 'reply', 'I would say…', { small: true, id: u.id }) + '<div class="btns"><button class="btn text" type="button" data-act="revise-start" data-id="' + u.id + '">It changed my mind</button></div>';
      else h += '<h3>Has it met its strongest objection?</h3><p class="hint">You have a reason and an example. Next is the best case against it, from someone real.</p><div class="btns"><button class="btn" type="button" data-act="challenge" data-id="' + u.id + '">Show me the strongest objection</button></div>';
    } else if (d === 3) h += '<h3>The last step is a test</h3><p class="hint">Make a prediction that follows from this and can be checked. If it holds, this turns to stone.</p><div class="btns"><button class="btn" type="button" data-act="bet-form" data-id="' + u.id + '">Make a bet on this</button></div>';
    else h += '<h3>Tested</h3><p class="hint">A prediction that followed from this held.</p>';
    return h + '</div>';
  }

  /* ---------- Bets, Concepts ---------- */
  function vBets() {
    var st = S.state, open = st.bets.filter(function (b) { return b.status === 'open'; }).sort(function (a, b) { return a.due < b.due ? -1 : 1; });
    var done = st.bets.filter(function (b) { return b.status !== 'open'; }).sort(function (a, b) { return (b.resolvedAt || '') < (a.resolvedAt || '') ? -1 : 1; }), today = HZ.dayKey();
    var h = '<div class="panel"><h2>Bets</h2><p class="hint">A belief counts as tested when a prediction that follows from it holds. To make a bet, open any structure on the map.</p>';
    if (!st.bets.length) h += '<p class="empty">No bets yet.</p>';
    function card(b) {
      var u = unit(b.unit), due = b.status === 'open' && b.due <= today;
      return '<li class="card">' + (due ? '<span class="chips"><span class="chip" style="border-color:var(--lamp);color:var(--lamp)">Due now</span></span>' : '<span class="chips">' + betChip(b) + '</span>') + '<blockquote class="quote sm">' + esc(b.text) + '</blockquote>' +
        (u ? '<p class="small">It tests: <button class="link" type="button" data-act="open" data-kind="unit" data-id="' + u.id + '">' + esc(u.label) + '</button></p>' : '') + (b.note ? '<p class="small">' + esc(b.note) + '</p>' : '') +
        (b.status === 'open' ? '<div class="btns"><button class="btn sm' + (due ? '' : ' ghost') + '" type="button" data-act="bet-resolve" data-id="' + b.id + '" data-out="held">It held</button><button class="btn sm ghost" type="button" data-act="bet-resolve" data-id="' + b.id + '" data-out="failed">It did not hold</button><button class="btn sm text" type="button" data-act="bet-resolve" data-id="' + b.id + '" data-out="void">Cannot tell</button></div>' : '') + '</li>';
    }
    if (open.length) h += '<ul class="cards">' + open.map(card).join('') + '</ul>';
    if (done.length) h += '<div class="section"><h3>Settled</h3><ul class="cards">' + done.map(card).join('') + '</ul></div>';
    return h + '</div>';
  }
  function vConcepts() {
    var st = S.state, h = '<div class="panel"><h2>Concepts</h2><p class="hint">When something you say turns out to have a name, the name lands here and an obelisk goes up on the map.</p>';
    if (!st.concepts.length) h += '<p class="empty">None yet. They come from what you say, not from a syllabus.</p>';
    else h += '<ul class="cards">' + st.concepts.slice().reverse().map(function (c) {
      var u = c.unit && unit(c.unit);
      return '<li class="card"><h3><button class="link" type="button" data-act="open" data-kind="concept" data-id="' + c.id + '">' + esc(c.name) + '</button></h3><p>' + esc(c.gist) + '</p>' + (u ? '<blockquote class="quote sm">' + esc(HZ.clip(u.text, 160)) + '</blockquote>' : '') + '<p class="small">Collected ' + esc(fmtDate(c.at)) + '</p></li>';
    }).join('') + '</ul>';
    return h + '</div>';
  }

  /* ---------- Map key and list ---------- */
  function vMap() {
    var h = '<div class="panel"><h2>How to read the map</h2><div class="key">' +
      '<b>Light</b><span>How sure you are. Brighter means surer.</span>' +
      '<b>Tent, hut, house, tower</b><span>A belief, growing as you explain it, give an example, and answer its strongest objection.</span>' +
      '<b>Stone tower with a beacon</b><span>A belief that passed a test: a prediction held.</span>' +
      '<b>Tree</b><span>Something you value.</span><b>Fire</b><span>A story from your life.</span>' +
      '<b>Green lantern</b><span>A question you are carrying.</span><b>Glowing arch</b><span>A door: a question waiting at the edge of the fog.</span>' +
      '<b>Obelisk</b><span>An idea of yours that turned out to have a name.</span>' +
      '<b>Dashed outline</b><span>A guess at what you meant. Not yours until you claim it.</span>' +
      '<b>Dotted road</b><span>Two things that connect.</span><b>Red crack</b><span>Two things that cannot both hold as stated.</span>' +
      '<b>Mist</b><span>Where you have not been yet.</span></div>';
    return h + vList(true) + '</div>';
  }
  function vList(inner) {
    var st = S.state, h = inner ? '<div class="section"><h3>Everything on the map</h3>' : '<div class="panel"><button class="btn text back" type="button" data-act="more-back">Back</button><h2>Everything on the map</h2>';
    if (!st.units.length) h += '<p class="empty">Nothing yet. The first thing you say will stand near the landing light.</p>';
    HZ.REGIONS.forEach(function (r) {
      var us = st.units.filter(function (u) { return u.region === r.id; });
      if (!us.length) return;
      h += '<div class="section"><h3>' + esc(r.name) + ', ' + us.length + '</h3><ul class="rows">' + us.map(function (u) {
        return '<li><span><button class="link" type="button" data-act="open" data-kind="unit" data-id="' + u.id + '">' + esc(u.label) + '</button><span class="d">' + HZ.TYPE_NAMES[u.type] + ', ' + (u.status !== 'yours' ? 'outline' : HZ.DEPTHS[u.depth || 0].toLowerCase()) + '</span></span></li>';
      }).join('') + '</ul></div>';
    });
    return h + '</div>';
  }

  /* ---------- More ---------- */
  function vMore() {
    if (S.sub === 'expedition') return vExpedition();
    if (S.sub === 'film') return vFilm();
    if (S.sub === 'together') return vTogether();
    if (S.sub === 'lens') return vLens();
    if (S.sub === 'progress') return vProgress();
    if (S.sub === 'list') return vList(false);
    if (S.sub === 'data') return vData();
    if (S.sub === 'rules') return vRules();
    if (S.sub === 'about') return vAbout();
    if (S.sub === 'claude' && SOLO) return vClaude();
    var rows = [
      ['expedition', 'Expedition', 'Five questions into one region you rarely visit.'],
      ['film', 'Film', 'Fly through your own map, with your words as captions.'],
      ['together', 'Together', 'Lay your map over someone else\'s and get three things to talk about.'],
      ['lens', 'Brain lens', 'What kind of thinking your world is made of. An estimate, clearly marked.'],
      ['progress', 'Progress', 'Fog cleared, depth built, bets settled.'],
      ['list', 'Everything on the map', 'The whole map as a plain list.'],
      ['data', 'Your data', 'Save a copy, bring one back, or start over.'],
      ['rules', 'How Horizon behaves', 'The rules it keeps.'],
      ['about', 'About and privacy', 'What this is, and where your words go.']
    ];
    if (SOLO) rows.unshift(['claude', 'Claude', S.caps.sample ? 'Connected. Your entries are read by Claude.' : 'Connect your own key for real readings.']);
    return '<div class="panel"><h2>More</h2><div class="rows">' + rows.map(function (r) { return '<button type="button" data-act="more" data-sub="' + r[0] + '"><span><span class="t">' + r[1] + '</span><span class="d">' + r[2] + '</span></span><span class="go" aria-hidden="true">&rsaquo;</span></button>'; }).join('') + '</div></div>';
  }
  function back() { return '<button class="btn text back" type="button" data-act="more-back">Back</button>'; }
  function vExpedition() {
    var st = S.state, E = S.exp, counts = HZ.regionCounts(st), h = '<div class="panel">' + back();
    if (!E) {
      var pick = HZ.leastVisited(st);
      h += '<h2>Expedition</h2><p class="hint">Five questions, about five minutes, into one part of your world. Your answers are placed on the map the same way a daily entry is.</p>';
      h += '<fieldset class="field" style="border:0;padding:0;margin:0"><legend class="lbl" style="padding:0;margin-bottom:10px">Where to?</legend><div class="regionpick">' + HZ.REGIONS.map(function (r) { return '<label><input type="radio" name="exp-region" value="' + r.id + '"' + (r.id === pick ? ' checked' : '') + '>' + esc(r.name) + ' <span class="n">' + counts[r.id] + '</span></label>'; }).join('') + '</div></fieldset>';
      return h + '<div class="btns"><button class="btn" type="button" data-act="exp-start">Start the expedition</button></div></div>';
    }
    if (E.loading) return h + '<h2>' + esc(regionName(E.region)) + '</h2><p class="status"><i></i>Writing your five questions</p></div>';
    h += '<p class="steps">' + esc(regionName(E.region)) + ', question ' + (E.i + 1) + ' of ' + E.questions.length + '</p><div class="field"><h2 class="prompt" id="p-exp">' + esc(E.questions[E.i]) + '</h2>';
    h += composer('exp', E.i + 1 < E.questions.length ? 'Next question' : 'Place my answers on the map', 'exp-next', 'Speak or type') + '</div>';
    return h + '<div class="btns"><button class="btn text" type="button" data-act="exp-skip">Skip this one</button>' + (E.answers.some(Boolean) ? '<button class="btn text" type="button" data-act="exp-finish">Stop here and place what I have</button>' : '') + '<button class="btn text" type="button" data-act="exp-cancel">Leave the expedition</button></div></div>';
  }
  function vFilm() {
    var shots = HZ.buildFilm(S.state), h = '<div class="panel">' + back() + '<h2>Film</h2><p class="hint">A fly-through of your own map: where it started, what you built deepest, what is still fog. Your words are the captions.</p>';
    if (!shots) return h + '<p class="empty">The film needs at least three structures. Keep going for a day or two.</p></div>';
    h += '<p class="small">' + shots.length + ' shots, about ' + Math.round(shots.length * 5.5) + ' seconds.</p>';
    if (S.caps.tts) h += '<label class="switch"><input type="checkbox" id="narrate" data-act-change="narrate"' + (S.state.meta.narrate ? ' checked' : '') + '>Read the captions aloud</label>';
    h += '<div class="btns"><button class="btn" type="button" data-act="film-play">Play the film</button></div>';
    return h + '<p class="small">This plays from your map. A rendered film or a walkable world needs a world-model service connected, which this prototype does not have.</p></div>';
  }
  function vTogether() {
    var st = S.state, G = S.tog || {}, h = '<div class="panel">' + back() + '<h2>Together</h2><p class="hint">Lay your map over someone else\'s. You get three things to talk about: something you share, something you disagree on, and a door neither of you has opened.</p>';
    if (G.result) {
      var R = G.result, r = R.res;
      h += '<div class="section"><h3>You and ' + esc(R.name) + '</h3>';
      if (R.offline) h += '<p class="small">A rough comparison from the built-in reader. Claude was not connected for this one.</p>';
      function pair(title, p) { if (!p) return ''; return '<div class="card"><h3>' + title + '</h3><blockquote class="quote sm">' + esc(p.a.t) + '</blockquote><blockquote class="quote sm theirs">' + esc(p.b.t) + '</blockquote>' + (p.note ? '<p>' + esc(p.note) + '</p>' : '') + '<p><b>Ask each other:</b> ' + esc(p.ask) + '</p></div>'; }
      h += '<div class="cards">' + pair('Something you share', r.shared) + pair('Where you part ways', r.disagreement) + (r.door ? '<div class="card"><h3>A door neither of you has opened' + (r.door.region ? ': ' + esc(regionName(r.door.region)) : '') + '</h3>' + (r.door.note ? '<p>' + esc(r.door.note) + '</p>' : '') + '<p><b>Ask each other:</b> ' + esc(r.door.ask) + '</p></div>' : '') + '</div>';
      h += '<p class="small">Their lights are showing on your map in blue.</p><div class="btns"><button class="btn ghost" type="button" data-act="tog-clear">Done</button></div></div>';
      return h + '</div>';
    }
    if (G.running) return h + '<p class="status"><i></i>Comparing the two maps</p></div>';
    var viaDb = store.mode() === 'db';
    h += '<div class="section"><h3>Compare with</h3><ul class="rows">';
    (G.people || []).forEach(function (p) { h += '<li><span><span class="t">' + esc(p.name) + '</span><span class="d">' + p.units.length + ' shared' + (p.at ? (viaDb ? ', updated ' : ', made ') + esc(fmtDate(p.at)) : '') + '</span></span><span class="btns"><button class="btn sm" type="button" data-act="tog-run" data-id="' + esc(p.id) + '">Compare</button>' + (viaDb ? '' : '<button class="btn sm text" type="button" data-act="friend-remove" data-id="' + esc(p.id) + '">Remove</button>') + '</span></li>'; });
    h += '<li><span><span class="t">Mira, an example map</span><span class="d">A made-up person, so you can try this alone.</span></span><button class="btn sm ghost" type="button" data-act="tog-run" data-id="example">Compare</button></li></ul>';
    if (store.mode() === 'db') h += G.loading ? '<p class="status"><i></i>Looking for people who have shared</p>' : !(G.people || []).length ? '<p class="small">Nobody else has shared here yet. Share this page with someone from its page on Claude; when they open it and share some regions, they appear in this list.</p>' : '';
    h += '</div>';
    if (store.mode() === 'db') {
      var mine = st.meta.share || [];
      h += '<div class="section"><h3>What others can see of yours</h3><p class="hint">Nothing leaves your private map unless you share a region here. People who can open this page then see the structures in those regions, in your words.</p>';
      h += '<div class="regionpick">' + HZ.REGIONS.map(function (r) { return '<label><input type="checkbox" name="share-region" value="' + r.id + '"' + (mine.indexOf(r.id) !== -1 ? ' checked' : '') + '>' + esc(r.name) + '</label>'; }).join('') + '</div>';
      h += '<div class="btns"><button class="btn ghost" type="button" data-act="share-save">Share the ticked regions</button>' + (G.sharing ? '<button class="btn text" type="button" data-act="share-stop">Stop sharing</button>' : '') + '</div>';
      h += '<p class="small">' + (G.sharing ? 'You are sharing ' + G.sharing + (G.sharing === 1 ? ' structure.' : ' structures.') : 'You are not sharing anything.') + '</p></div>';
    } else if (SOLO) {
      var ticked = st.meta.share || [];
      h += '<div class="section"><h3 id="p-code">Add someone\'s map</h3><p class="hint">Paste the share code they sent you.</p><textarea id="t-code" data-draft="code" class="sm code" aria-labelledby="p-code" placeholder="hz1.…">' + esc(S.drafts.code || '') + '</textarea><div class="btns"><button class="btn ghost" type="button" data-act="code-add" data-need="code"' + ((S.drafts.code || '').trim() ? '' : ' disabled') + '>Add their map</button></div></div>';
      h += '<div class="section"><h3>Share yours</h3><p class="hint">Tick the regions you are willing to show, make a code, and send it to them any way you like. Nothing leaves this browser until you send the code yourself.</p>';
      h += '<div class="regionpick">' + HZ.REGIONS.map(function (r) { return '<label><input type="checkbox" name="share-region" value="' + r.id + '"' + (ticked.indexOf(r.id) !== -1 ? ' checked' : '') + '>' + esc(r.name) + '</label>'; }).join('') + '</div>';
      h += '<div class="field"><label for="share-name">The name they will see</label><input type="text" id="share-name" maxlength="40" autocomplete="off" value="' + esc(ENV.local.get('name.v1') || '') + '" placeholder="Your name"></div>';
      h += '<div class="btns"><button class="btn ghost" type="button" data-act="code-make">Make a share code</button></div>';
      if (G.code) h += '<div class="field"><label for="t-mycode">Your share code</label><textarea id="t-mycode" class="sm code" readonly>' + esc(G.code) + '</textarea><div class="btns"><button class="btn" type="button" data-act="code-copy">Copy the code</button></div><p class="small">The code holds what you placed in those regions, in your words, as it is now. Anyone who has the code can read it. Make a new one when your map has grown.</p></div>';
      h += '</div>';
    } else h += '<p class="small">Sharing with real people needs the page to be opened inside Claude, where it can save data.</p>';
    return h + '</div>';
  }
  function vLens() {
    var st = S.state, diet = HZ.lensDiet(st), any = st.units.some(function (u) { return u.status === 'yours'; }), real = st.meta.lensSource && st.meta.lensSource !== 'estimate';
    var h = '<div class="panel">' + back() + '<h2>Brain lens</h2>';
    h += '<p class="hint">' + (real ? 'Loaded from ' + esc(st.meta.lensSource) + ': the predicted response of an average brain to hearing each thing you said. It is a prediction about a typical listener, not a measurement of you.' : 'An estimate, made from the words alone, of which broad systems a typical brain would lean on to process each thing you said. It is not a measurement of your brain, and it does not show where a belief lives or came from.') + '</p>';
    if (!any) h += '<p class="empty">Place a few things on the map first.</p>';
    else {
      var max = Math.max.apply(null, diet.map(function (d) { return d.share; })) || 1;
      h += '<figure><div class="bars" role="img" aria-label="Share of your map by system: ' + diet.map(function (d) { return d.name + ' ' + Math.round(d.share * 100) + ' percent'; }).join(', ') + '">' + diet.map(function (d) {
        return '<span class="n"><span class="swatch" style="background:' + d.color + '"></span>' + esc(d.name) + '</span><span class="track"><span class="bar" style="width:' + Math.max(1, Math.round((d.share / max) * 78)) + '%;background:' + d.color + '"></span><span class="val">' + Math.round(d.share * 100) + '%</span></span>';
      }).join('') + '</div><figcaption class="small" style="margin-top:10px">Share of what is on your map, by the system each item leans on most.</figcaption></figure>';
      h += '<label class="switch"><input type="checkbox" id="tint" data-act-change="tint"' + (st.meta.tint ? ' checked' : '') + '>Tint the lights on the map by system</label>';
    }
    h += '<div class="section"><h3>The real version</h3><p class="hint">Meta\'s TRIBE v2 predicts a typical brain\'s response to speech. It needs a GPU and its licence is non-commercial, so it runs outside this page with the script that comes with this prototype. Copy the input, run the script, paste what it returns.</p>';
    h += '<div class="btns"><button class="btn ghost" type="button" data-act="lens-copy"' + (any ? '' : ' disabled') + '>Copy the input for the script</button></div>';
    h += '<label class="lbl" for="t-lens">Paste the script\'s output</label><textarea id="t-lens" data-draft="lens" class="sm" placeholder="{&quot;source&quot;: &quot;tribe-v2&quot;, &quot;units&quot;: …}" style="font-family:ui-monospace,monospace;font-style:normal;font-size:13px">' + esc(S.drafts.lens || '') + '</textarea>';
    h += '<div class="btns"><button class="btn ghost" type="button" data-act="lens-load" data-need="lens"' + ((S.drafts.lens || '').trim() ? '' : ' disabled') + '>Load it</button></div></div>';
    return h + '</div>';
  }
  function vProgress() {
    var s = HZ.stats(S.state), max = Math.max.apply(null, s.depth) || 1, h = '<div class="panel">' + back() + '<h2>Progress</h2>';
    h += '<div><p class="stat"><span class="v">' + Math.round(s.fog * 100) + '%</span></p><p class="small" style="margin:2px 0 8px">of the fog cleared</p><div class="meter" role="img" aria-label="' + Math.round(s.fog * 100) + ' percent of the fog cleared"><b style="width:' + Math.round(s.fog * 100) + '%"></b></div></div>';
    h += '<div class="section"><h3>Depth built</h3><div class="bars" role="img" aria-label="Structures by depth: ' + HZ.DEPTHS.map(function (n, i) { return n + ' ' + s.depth[i]; }).join(', ') + '">' + HZ.DEPTHS.map(function (n, i) {
      return '<span class="n">' + n + '</span><span class="track"><span class="bar" style="width:' + (s.depth[i] ? Math.max(2, Math.round((s.depth[i] / max) * 78)) : 0) + '%' + (i === 4 ? ';background:var(--stone)' : '') + '"></span><span class="val">' + s.depth[i] + '</span></span>';
    }).join('') + '</div></div>';
    function t(v, l) { return '<div class="stat"><p class="v">' + v + '</p><p class="l">' + l + '</p></div>'; }
    h += '<div class="section"><div class="stats">' + t(s.structures, 'structures') + t(s.stone, 'in stone') + t(s.outlines, 'outlines to claim') + t(s.bridges, 'roads') + t(s.riftsOpen, 'rifts open') + t(s.riftsHeld + s.riftsSettled, 'rifts held or settled') + t(s.betsOpen, 'bets open') + t(s.betsHeld + ' / ' + s.betsFailed, 'bets held / failed') + t(s.concepts, 'concepts') + t(s.doors, 'doors open') + t(s.days, s.days === 1 ? 'day' : 'days') + '</div></div>';
    return h + '</div>';
  }
  function vData() {
    var m = store.mode(), h = '<div class="panel">' + back() + '<h2>Your data</h2>';
    h += '<p class="hint">' + (m === 'db' ? 'Your map is saved with this page, in a part of its storage only you can read. Other people who open the page get their own empty map.' : m === 'local' ? 'Your map is saved in this browser only. Clearing the browser clears it. Save a copy now and then.' : 'Nothing is being saved in this view. Save a copy before you leave.') + '</p>';
    if (SOLO && m === 'local') h += S.kept ? '<p class="small">This browser has agreed not to clear your map on its own.</p>' : '<p class="small">A browser can clear saved data on its own if you stay away for a while. <button class="link" type="button" data-act="keep-ask">Ask this one to keep your map</button></p>';
    h += '<div class="btns">' + (S.caps.downloads ? '<button class="btn" type="button" data-act="data-save">Save a copy as a file</button>' : '') + '<button class="btn ghost" type="button" data-act="data-copy">Copy the whole map</button></div>';
    h += '<div class="section"><h3 id="p-import">Bring a copy back</h3><p class="hint">Paste a saved copy here. It replaces the map you have now.</p><textarea id="t-import" data-draft="import" class="sm" aria-labelledby="p-import" style="font-family:ui-monospace,monospace;font-style:normal;font-size:13px">' + esc(S.drafts.import || '') + '</textarea><div class="btns"><button class="btn ghost" type="button" data-act="data-import" data-need="import"' + ((S.drafts.import || '').trim() ? '' : ' disabled') + '>Replace my map with this</button></div></div>';
    h += '<div class="section"><h3>Start over</h3><div class="btns"><button class="btn ghost danger" type="button" data-act="data-reset">Delete everything</button></div></div>';
    return h + '</div>';
  }
  function vRules() {
    return '<div class="panel">' + back() + '<h2>How Horizon behaves</h2><div class="key">' +
      '<b>Your words</b><span>Only what you actually said goes on the map as yours. Anything reworded stays a dashed outline until you claim it.</span>' +
      '<b>No flattery</b><span>It does not praise you, steer you, or tell you what to believe. It shows your words back and brings real opposing views.</span>' +
      '<b>No diagnosis</b><span>It maps ideas. It does not assess you.</span>' +
      '<b>Prediction over assertion</b><span>Saying something makes a tent. Only a prediction that holds makes stone.</span>' +
      '<b>People first</b><span>Each day it offers a question to take to a real person.</span>' +
      '<b>Private by default</b><span>' + (SOLO ? 'Your map stays in this browser. Nothing is shared unless you make a share code under Together and send it yourself.' : 'Nothing is shared unless you tick a region under Together.') + '</span>' +
      '<b>No guilt</b><span>Nothing decays when you are away.</span>' +
      '<b>Brain lens</b><span>Always marked as an estimate or a prediction about a typical listener. Never a reading of your brain.</span></div></div>';
  }

  /* ---------- Claude, with your own key (the website only) ---------- */
  function vClaude() {
    var c = ENV.claude.info(), L = ENV.links, h = '<div class="panel">' + back() + '<h2>Claude</h2>';
    if (c.connected) {
      h += '<p class="hint">Connected, with the key ending in <b>' + esc(c.hint) + '</b>. Readings use ' + esc(c.main) + '. Quick questions use ' + esc(c.quick) + '.</p>';
      if (!c.stored) h += '<p class="note warn">This browser would not store the key, so it is kept only until this tab closes.</p>';
      if (c.lastError) h += '<div class="banner err"><p class="lbl">The last reading failed</p><p>' + esc(copyFor(c.lastError.code)) + '</p>' + said(c.lastError.detail) + '</div>';
      h += '<p id="k-status" class="note" role="status"></p>';
      h += '<div class="btns"><button class="btn ghost" type="button" data-act="claude-connect">Test the connection</button><button class="btn ghost danger" type="button" data-act="claude-forget">Forget this key</button></div>';
    } else {
      h += '<p class="hint">Horizon reads what you say with Claude. On this site that runs on your own Claude API key. Without one, a simple built-in reader sorts your sentences, and you miss the real readings.</p>';
      h += '<ol class="howto"><li>Create a key in the ' + ext(L.keys, 'Claude Console') + '. Choose one workspace for the key when you create it; that saves a step here.</li><li>Paste it below and press Connect.</li></ol>';
      h += '<div class="field"><label for="k-key">Claude API key</label><input type="password" id="k-key" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="sk-ant-…">';
      h += '<p id="k-status" class="note" role="status"></p><div class="btns"><button class="btn" type="button" data-act="claude-connect">Connect</button></div></div>';
    }
    h += '<details class="adv"><summary>Advanced</summary><div class="field">' +
      '<label for="k-main">Model for readings</label><input type="text" id="k-main" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(c.main) + '" placeholder="' + esc(c.defaults.main) + '">' +
      '<label for="k-quick">Model for quick questions</label><input type="text" id="k-quick" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(c.quick) + '" placeholder="' + esc(c.defaults.quick) + '">' +
      '<label for="k-ws">Workspace ID, only for a key that is not tied to one workspace</label><input type="text" id="k-ws" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(c.workspace) + '" placeholder="wrkspc_…">' +
      '<p class="small">Workspace IDs are listed on the ' + ext(L.workspaces, 'Workspaces page') + ' of the Claude Console, in the ID column.</p>' +
      (c.connected ? '<div class="btns"><button class="btn ghost" type="button" data-act="claude-connect">Save and test</button></div>' : '<p class="small">These are used when you press Connect.</p>') + '</div></details>';
    h += '<div class="section"><h3>What happens to the key</h3><div class="key">' +
      '<b>Where it is kept</b><span>In this browser, on this device. It is never sent to this website\'s host or to anyone but Anthropic.</span>' +
      '<b>Where it goes</b><span>To api.anthropic.com, with each entry you ask Claude to read. The page\'s own rules block it from contacting any other server.</span>' +
      '<b>What it costs</b><span>Anthropic bills your account for every reading. You can cap spending in the Claude Console.</span>' +
      '<b>Shared computers</b><span>Anyone who uses this browser profile can use a key stored in it. Do not connect on a computer you share.</span>' +
      '<b>Taking it back</b><span>Forget this key removes it from this browser. To cancel the key itself, revoke it in the Claude Console.</span></div></div>';
    return h + '</div>';
  }

  /* ---------- About and privacy ---------- */
  function vAbout() {
    var L = ENV.links, h = '<div class="panel">' + back() + '<h2>About and privacy</h2>';
    h += '<p class="hint">Horizon is an early prototype, version ' + esc(ENV.version) + '. You talk to it for a couple of minutes a day and it builds a map of how you think. Things will change, and some will break.</p><div class="key">';
    if (SOLO) {
      h += '<b>Your map</b><span>Is saved in this browser, on this device. There are no accounts and no Horizon server, so nobody else can open it, and it will not follow you to another device. Save a copy now and then under Your data.</span>' +
        '<b>Claude</b><span>Off until you connect your own key. Once connected, each entry is sent to Anthropic together with part of your map, so Claude can link new things to old ones. Anthropic\'s terms for your key apply.</span>' +
        '<b>Dictation</b><span>Off until you turn it on. It uses your browser\'s speech recognition, which in most browsers sends your voice to the browser\'s maker to be turned into text.</span>' +
        '<b>This site</b><span>Is served by GitHub Pages, which sees the usual details of a page request, such as your IP address. Horizon itself has no trackers, no analytics and no cookies.</span>' +
        '<b>On an iPhone</b><span>If you add Horizon to your home screen, that copy keeps a separate map of its own. Move a map across with Save a copy and Bring a copy back.</span>';
    } else {
      h += '<b>Your map</b><span>Is saved with this page, in storage only you can read. Other people who open the page get their own empty map.</span>' +
        '<b>Claude</b><span>Entries are read by Claude through this page, under your own Claude account.</span>';
    }
    h += '<b>What it is not</b><span>Horizon maps ideas. It is not therapy, advice or a diagnosis, and nobody reads what you write. If you are in danger or thinking about harming yourself, contact your local emergency number or a crisis line: ' + ext(L.helplines, 'findahelpline.com') + '.</span>' +
      '<b>Feedback</b><span>Say what worked and what did not: ' + ext(L.feedback, 'open an issue on GitHub') + ' (needs a GitHub account). The ' + ext(L.source, 'source code') + ' is public.</span>' +
      '<b>Who makes it</b><span>An independent project. It is not made or endorsed by Anthropic; Claude is Anthropic\'s product.</span></div>';
    return h + '</div>';
  }

  /* ---------- render ---------- */
  var VIEW_FN = { map: vMap, today: vToday, bets: vBets, concepts: vConcepts, more: vMore };
  function viewHTML() { return VIEW_FN[S.view](); }
  function render() {
    var ae = document.activeElement, keepId = ae && sheet.contains(ae) ? ae.id : null, a = keepId && ae.selectionStart, b = keepId && ae.selectionEnd;
    var key = (S.sel ? S.sel.kind + S.sel.id : S.view + '/' + S.sub) + (S.working ? 'w' : '') + (S.result ? 'r' : '');
    sheet.innerHTML = S.sel ? vDetail() : viewHTML();
    if (key !== S.lastKey) { sheet.scrollTop = 0; S.lastKey = key; }
    app.dataset.sheet = S.sel || S.view !== 'map' || S.mapKey ? 'open' : 'closed';
    document.querySelectorAll('#tabs button').forEach(function (t) { if (t.dataset.view === S.view) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
    var st = HZ.stats(S.state), pct = Math.round(st.fog * 100);
    $('#dayline').textContent = !S.ready ? 'Opening your world' : 'Day ' + Math.max(1, st.days) + (st.run > 1 ? ', ' + st.run + ' in a row' : '');
    $('#fogtext').textContent = pct + '% clear'; $('#fogbar').style.width = pct + '%';
    $('#betdot').hidden = !HZ.dueBets(S.state).length;
    if (keepId) { var el = document.getElementById(keepId); if (el) { el.focus({ preventScroll: true }); if (a != null && el.setSelectionRange) { try { el.setSelectionRange(a, b); } catch (e) {} } } }
    layout();
  }
  function layout() {
    if (!world) return;
    var open = app.dataset.sheet === 'open';
    if (wide.matches) world.setInsets({ left: 440, top: 0, bottom: 0 });
    else world.setInsets({ top: 50, bottom: (open ? sheet.offsetHeight : 0) + 62 });
  }
  function go(view, sub) {
    S.view = VIEWS.indexOf(view) !== -1 ? view : 'today'; S.sub = sub || null; S.sel = null; S.mapKey = false;
    S.result = null; S.care = null; S.deepen = null; S.betFor = null; // a finished move stays reachable under "Last move"
    if (world) world.select(null);
    try { if (location.hash !== '#' + S.view) location.hash = S.view; } catch (e) {}
    render();
  }
  function openItem(kind, id, fly) {
    S.sel = { kind: kind, id: id }; S.deepen = null; S.betFor = null;
    if (kind !== 'move') { world.select(kind, id); var pos = world.posOf(kind, id); render(); if (fly && pos) world.focus(pos, undefined, 800); }
    else render();
  }

  /* ---------- the daily loop ---------- */
  async function stopListening() { if (S.listening && S.caps.dictation) { try { await S.caps.dictation.stop(); } catch (e) {} } }
  async function submitEntry(text, via, o) {
    o = o || {};
    S.working = { text: text, label: o.label || 'Reading what you said' }; S.error = null; S.result = null; S.care = null; S.sel = null; S.view = 'today'; S.sub = null; render();
    var r = o.offline ? { offline: true } : await ask(HZ.dailyPrompt(S.state, text, { expedition: !!o.expedition, notAtRisk: !!o.noCare }), 'default');
    S.working = null;
    if (r.error) {
      if (r.error === 'cancelled') { if (!o.expedition) S.drafts.today = text; toast('Stopped. Nothing was placed.'); }
      else S.error = { code: r.error, detail: r.detail, text: text, via: via, o: o };
      render(); return;
    }
    var res = HZ.normalizeDaily(r.offline ? HZ.offlineDaily(S.state, text, null, { noCare: !!o.noCare }) : r.data, S.state, text);
    if (res.care) { // answered, not mapped: nothing is placed and nothing is saved
      if (!o.expedition) S.drafts.today = text;
      S.care = { title: res.move.title, body: res.move.body, text: text, via: via, o: o, again: !!o.noCare };
      render(); return;
    }
    if (r.offline) res.offline = true;
    var out = HZ.applyDaily(S.state, text, res, { via: via, keepDoor: !!o.expedition });
    if (!o.expedition) { S.drafts.today = ''; S.voiced.today = false; }
    S.drafts.bet = out.move.betDraft ? out.move.betDraft.text : '';
    S.result = { move: out.move.id, units: out.units.map(function (u) { return u.id; }) };
    changed();
    var placed = out.units.filter(function (u) { return u.pos; });
    if (placed.length) { world.celebrate(placed.filter(function (u) { return u.status === 'yours'; }).map(function (u) { return u.id; })); world.focus(placed[0].pos, 1.2, 1200); }
    // on a plain website, ask the browser to hold on to the map (Firefox would interrupt with a question, so there it is a button under Your data)
    if (SOLO && !S.kept && store.mode() === 'local' && !/Firefox/i.test(navigator.userAgent)) ENV.keep().then(function (v) { S.kept = v; });
  }

  /* ---------- film ---------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function drawFilm() {
    var F = S.film; if (!F) { filmEl.hidden = true; delete app.dataset.film; return; }
    var sh = F.shots[F.i];
    filmEl.hidden = false; app.dataset.film = 'on';
    filmEl.innerHTML = '<div class="cap"><p class="k">' + esc(sh.caption) + '</p><h2>' + esc(sh.title) + '</h2>' + (sh.text ? '<p class="quote">' + esc(HZ.clip(sh.text, 200)) + '</p>' : '') +
      '<div class="ctl"><button class="btn sm ghost" type="button" data-act="film-toggle">' + (F.ended ? 'Play again' : F.playing ? 'Pause' : 'Play') + '</button><button class="btn sm text" type="button" data-act="film-close">Close</button><span class="steps">' + (F.i + 1) + ' / ' + F.shots.length + '</span></div></div>';
  }
  async function playFilm() {
    var shots = HZ.buildFilm(S.state); if (!shots) return;
    var tok = {}; S.film = { shots: shots, i: 0, playing: true, ended: false, tok: tok };
    world.setInsets({ top: 0, bottom: 0, left: 0 }); world.select(null);
    for (var i = 0; i < shots.length; i++) {
      if (!S.film || S.film.tok !== tok) return;
      S.film.i = i; drawFilm();
      var sh = shots[i], fly;
      if (sh.k === 'wide') fly = world.fitAll(calm.matches ? 0 : 1700);
      else { var pos = world.posOf(sh.k, sh.id); fly = pos ? world.focus(pos, 1.75, calm.matches ? 0 : 1900) : Promise.resolve(); }
      if (S.state.meta.narrate && S.caps.tts) S.caps.tts.speak([sh.caption, sh.title, sh.text].filter(Boolean).join('. ')).catch(noop);
      await fly;
      var wait = 2600 + Math.min(4200, (sh.text || '').length * 32), t = 0;
      while (t < wait) { await sleep(120); if (!S.film || S.film.tok !== tok) return; if (S.film.playing) t += 120; }
    }
    if (S.film && S.film.tok === tok) { S.film.ended = true; S.film.playing = false; drawFilm(); }
  }
  function closeFilm() { S.film = null; if (S.caps.tts) { try { S.caps.tts.stop(); } catch (e) {} } drawFilm(); layout(); world.fitLit(calm.matches ? 0 : 900); }

  /* ---------- together ---------- */
  async function loadPeople() {
    S.tog = S.tog || {};
    if (store.mode() !== 'db') { S.tog.people = SOLO ? friends() : []; render(); return; }
    S.tog.loading = true; render();
    try {
      var all = await store.listShares(), others = [], mine = null;
      all.forEach(function (d) { var n = HZ.normalizeShare(d.data); if (!n) return; if (d.mine) mine = n; else if (n.units.length) others.push({ id: d.id, units: n.units, at: n.at, name: 'Someone' }); });
      if (others.length && S.caps.user) { try { var ps = await S.caps.user.profiles(others.map(function (o) { return o.id; })); others.forEach(function (o) { o.name = (ps[o.id] && ps[o.id].name) || 'Someone'; }); } catch (e) {} }
      S.tog.people = others; S.tog.sharing = mine ? mine.units.length : 0;
    } catch (e) { S.tog.people = []; toast('Could not load the list of people.'); }
    S.tog.loading = false; if (S.view === 'more' && S.sub === 'together') render();
  }
  async function runOverlay(pid) {
    var G = S.tog = S.tog || {}, partner;
    if (pid === 'example') partner = { name: 'Mira (example)', units: HZ.normalizeShare(HZ.EXAMPLE_PARTNER).units };
    else partner = (G.people || []).filter(function (p) { return p.id === pid; })[0];
    if (!partner) return;
    var mine = HZ.normalizeShare(HZ.buildShare(S.state, HZ.REGION_IDS)).units;
    if (mine.length < 2) { toast('Place a few things on your own map first.'); return; }
    G.running = true; render();
    var r = await ask(HZ.overlayPrompt(mine, partner.units), 'default');
    G.running = false;
    if (r.error && r.error !== 'cancelled') toast(copyFor(r.error));
    if (r.error === 'cancelled') { render(); return; }
    G.result = { name: partner.name, res: r.data ? HZ.normalizeOverlay(r.data, mine, partner.units) : HZ.offlineOverlay(mine, partner.units), offline: !r.data };
    // their lights, on free ground in the matching regions of your island
    var tmp = { units: S.state.units.slice(), concepts: S.state.concepts, doors: S.state.doors }, lights = [];
    partner.units.forEach(function (u, i) { var g = { id: 'pp' + i, region: u.r }; if (HZ.placeUnit(tmp, g)) { tmp.units.push(g); lights.push({ pos: g.pos, label: u.l }); } });
    world.setPartner(lights); render(); world.fitAll(calm.matches ? 0 : 900);
  }

  /* ---------- actions ---------- */
  var A = {
    go: function (el) { go(el.dataset.view); },
    more: function (el) { go('more', el.dataset.sub); if (el.dataset.sub === 'together') loadPeople(); },
    'more-back': function () { if (S.exp && S.sub === 'expedition') S.exp = null; if (S.sub === 'together' && S.tog && S.tog.result) { S.tog.result = null; world.setPartner(null); } go('more'); },
    back: function () { S.sel = null; S.deepen = null; S.betFor = null; world.select(null); render(); },
    dlg: function (el) { scrim.hidden = true; var r = S.dlg; S.dlg = null; if (r) r(el.dataset.v === '1'); },
    zoom: function (el) { world.zoomBy(+el.dataset.f); },
    'view-recent': function () { world.fitLit(calm.matches ? 0 : 700); },
    'view-all': function () { world.fitAll(calm.matches ? 0 : 700); },
    'map-key': function () { var on = !(S.view === 'map' && S.mapKey && !S.sel); S.sel = null; world.select(null); S.view = 'map'; S.sub = null; S.mapKey = on; render(); },
    open: function (el) { openItem(el.dataset.kind, el.dataset.id, true); },
    fly: function (el) { var pos = world.posOf(el.dataset.kind, el.dataset.id); if (pos) { world.select(el.dataset.kind, el.dataset.id); world.focus(pos, undefined, 800); } },
    'show-move': function (el) { openItem('move', el.dataset.id); },

    mic: function (el) {
      var d = S.caps.dictation, id = el.dataset.for; if (!d) return;
      if (S.listening === id) { d.stop().catch(noop); return; }
      function begin() {
        if (S.listening) d.stop().catch(noop);
        S.listening = id;
        var b = sheet.querySelector('[data-act="mic"][data-for="' + id + '"]'); if (b) { b.setAttribute('aria-pressed', 'true'); b.setAttribute('aria-label', 'Stop listening'); }
        d.start().catch(function (e) {
          var code = e && e.code; S.listening = null; S.partial = '';
          if (code === 'not_granted' || code === 'unavailable') { S.caps.dictation = null; toast('Dictation is not available here. Typing works.'); }
          else if (code !== 'stopped' && code !== 'dismissed') toast('The microphone did not start. Try again.');
          render();
        });
      }
      if (SOLO && !ENV.local.get('voice.v1')) { // the browser's own speech recognition usually sends audio to the browser's maker: ask once
        ask2('Turn on dictation?', 'Dictation uses your browser\'s speech recognition. In most browsers your voice is sent to the browser\'s maker, such as Google for Chrome or Apple for Safari, to be turned into text. Horizon does not record or keep any audio.', 'Turn on dictation').then(function (yes) { if (yes) { ENV.local.set('voice.v1', 1); begin(); } });
        return;
      }
      begin();
    },
    'submit-today': async function () { await stopListening(); var t = (S.drafts.today || '').trim(); if (t) submitEntry(t, S.voiced.today ? 'voice' : 'text'); },
    stop: function () { if (S.ctl) S.ctl.abort(); },
    retry: function () { var e = S.error; if (e) submitEntry(e.text, e.via, e.o); },
    'retry-offline': function () { var e = S.error; if (e) submitEntry(e.text, e.via, Object.assign({}, e.o, { offline: true })); },
    'edit-entry': function () { var e = S.error; if (e) { if (!e.o || !e.o.expedition) S.drafts.today = e.text; S.error = null; render(); } },
    done: function () { S.result = null; if (S.caps.tts && S.speaking) { try { S.caps.tts.stop(); } catch (e) {} } go('map'); },
    speak: function (el) {
      var t = S.caps.tts, m = HZ.byId(S.state.moves, el.dataset.id); if (!t || !m) return;
      if (S.speaking) { try { t.stop(); } catch (e) {} S.speaking = false; render(); return; }
      S.speaking = true; render();
      t.speak(HZ.clip([HZ.MOVES[m.kind], m.title, m.body, m.door ? 'A door for next time. ' + m.door : ''].filter(Boolean).join('. '), 1900)).catch(function (e) { if (e && e.code === 'not_granted') S.caps.tts = null; }).then(function () { S.speaking = false; render(); });
    },

    confirm: function (el) { HZ.confirmUnit(S.state, el.dataset.id); world.celebrate([el.dataset.id]); changed(); },
    remove: async function (el) {
      var u = unit(el.dataset.id); if (!u) return;
      if (!(await ask2('Remove this from your map?', '"' + HZ.clip(u.text, 140) + '"', 'Remove it', true))) return;
      HZ.removeUnit(S.state, u.id);
      if (S.sel && S.sel.id === u.id) { S.sel = null; world.select(null); }
      if (S.result) S.result.units = S.result.units.filter(function (x) { return x !== u.id; });
      changed();
    },
    conv: function (el) { HZ.setConviction(S.state, el.dataset.id, +el.dataset.v); changed(); },
    explain: async function (el) { await stopListening(); if (HZ.explain(S.state, el.dataset.id, S.drafts.why)) { S.drafts.why = ''; changed(); toast('Explained. It grew.'); } },
    exemplify: async function (el) { await stopListening(); var s = HZ.exemplify(S.state, el.dataset.id, S.drafts.story); if (s) { S.drafts.story = ''; changed(); world.celebrate([s.id]); toast('The story is on the map, next to it.'); } },
    challenge: async function (el) {
      var u = unit(el.dataset.id); if (!u) return;
      S.deepen = { id: u.id, loading: true }; render();
      var r = await ask(HZ.challengePrompt(u), 'default');
      if (!S.deepen || S.deepen.id !== u.id) return;
      if (r.error && r.error !== 'cancelled') toast(copyFor(r.error));
      S.deepen = r.error === 'cancelled' ? null : { id: u.id, challenge: r.data ? HZ.normalizeChallenge(r.data) : HZ.offlineChallenge() };
      render();
    },
    reply: async function (el) { await stopListening(); var D = S.deepen; if (HZ.answerChallenge(S.state, el.dataset.id, D && D.challenge, S.drafts.reply)) { S.drafts.reply = ''; S.deepen = null; changed(); toast('Answered. It stands taller.'); } },
    'revise-start': function (el) { var u = unit(el.dataset.id); if (!u) return; S.drafts.revise = u.text; S.deepen = { id: u.id, revise: true }; S.betFor = null; render(); },
    'revise-save': async function (el) { await stopListening(); if (HZ.revise(S.state, el.dataset.id, S.drafts.revise)) { S.drafts.revise = ''; S.deepen = null; changed(); toast('Reworded. The earlier wording is kept in its notes.'); } },
    'deepen-cancel': function () { S.deepen = null; render(); },
    rift: function (el) { HZ.settleRift(S.state, el.dataset.id, el.dataset.how); changed(); },

    'bet-form': function (el) { S.betFor = el.dataset.id; S.deepen = null; S.drafts.bet = ''; render(); var t = $('#t-bet'); if (t) t.focus(); },
    'bet-take': function (el) {
      var days = +(($('#bet-days') || {}).value || 7), b = HZ.addBet(S.state, el.dataset.id, S.drafts.bet, days);
      if (!b) return;
      S.drafts.bet = ''; S.betFor = null; changed(); toast('Bet taken. It comes due ' + fmtDay(b.due) + '.');
    },
    'bet-cancel': function (el) { S.betFor = null; S.drafts.bet = ''; if (el.dataset.move) { var m = HZ.byId(S.state.moves, el.dataset.move); if (m) { m.betDraft = null; persist(); } } render(); },
    'bet-resolve': function (el) {
      var b = HZ.resolveBet(S.state, el.dataset.id, el.dataset.out); if (!b) return;
      changed();
      if (b.status === 'held') { world.celebrate([b.unit]); var p = world.posOf('unit', b.unit); if (p) world.focus(p, 1.5, 1000); toast('It held. That one is stone now.'); }
      else if (b.status === 'failed') toast('It did not hold. Open it to reword it, or keep it as it is.');
      else toast('Set aside.');
    },
    'door-answer': function (el) { if (HZ.setDoor(S.state, el.dataset.id)) { persist(); go('today'); var t = $('#t-today'); if (t) t.focus(); } },
    'door-close': function (el) { var d = HZ.byId(S.state.doors, el.dataset.id); if (!d) return; d.answeredAt = HZ.iso(); d.expired = true; if (S.state.meta.door && S.state.meta.door.id === d.id) S.state.meta.door = null; S.sel = null; world.select(null); changed(); },

    'exp-start': async function () {
      var pick = document.querySelector('input[name="exp-region"]:checked'), region = pick ? pick.value : HZ.leastVisited(S.state);
      S.exp = { region: region, loading: true, questions: [], answers: [], i: 0 }; S.drafts.exp = ''; render();
      var r = await ask(HZ.expeditionPrompt(S.state, region), 'quick');
      if (!S.exp || S.exp.region !== region) return;
      if (r.error === 'cancelled') { S.exp = null; render(); return; }
      if (r.error) toast('Claude could not write the questions, so these are ready-made ones.');
      S.exp.questions = r.data ? HZ.normalizeExpedition(r.data, region) : HZ.offlineExpedition(region);
      S.exp.loading = false; render();
      var c = HZ.terrain().centroid[HZ.regionIndex(region)]; world.focus({ x: Math.round(c.x), y: Math.round(c.y) }, 1.0, 1000);
    },
    'exp-next': async function () { await stopListening(); var E = S.exp; if (!E) return; E.answers[E.i] = (S.drafts.exp || '').trim(); S.drafts.exp = ''; if (E.i + 1 < E.questions.length) { E.i++; render(); var t = $('#t-exp'); if (t) t.focus(); } else A['exp-finish'](); },
    'exp-skip': function () { var E = S.exp; if (!E) return; E.answers[E.i] = ''; S.drafts.exp = ''; if (E.i + 1 < E.questions.length) { E.i++; render(); } else A['exp-finish'](); },
    'exp-finish': function () {
      var E = S.exp; if (!E) return;
      if ((S.drafts.exp || '').trim()) E.answers[E.i] = S.drafts.exp.trim();
      var text = HZ.expeditionTranscript(E.questions, E.answers);
      S.exp = null; S.drafts.exp = '';
      if (!text) { toast('No answers to place.'); go('more', 'expedition'); return; }
      submitEntry(text, 'expedition', { expedition: true, label: 'Reading your answers' });
    },
    'exp-cancel': function () { S.exp = null; S.drafts.exp = ''; render(); },

    'film-play': function () { playFilm(); },
    'film-toggle': function () { var F = S.film; if (!F) return; if (F.ended) { playFilm(); return; } F.playing = !F.playing; if (!F.playing && S.caps.tts) { try { S.caps.tts.stop(); } catch (e) {} } drawFilm(); },
    'film-close': closeFilm,

    'tog-run': function (el) { runOverlay(el.dataset.id); },
    'tog-clear': function () { if (S.tog) S.tog.result = null; world.setPartner(null); render(); world.fitLit(calm.matches ? 0 : 700); },
    'share-save': async function () {
      var regions = Array.prototype.map.call(document.querySelectorAll('input[name="share-region"]:checked'), function (i) { return i.value; });
      if (!regions.length) { toast('Tick at least one region, or use Stop sharing.'); return; }
      var share = HZ.buildShare(S.state, regions);
      if (!(await ask2('Share ' + share.units.length + (share.units.length === 1 ? ' structure?' : ' structures?'), 'Everyone who can open this page will be able to read what you have placed in ' + regions.map(regionName).join(', ') + ', in your words.', 'Share them'))) return;
      try { await store.publishShare(share); S.state.meta.share = regions; persist(); S.tog.sharing = share.units.length; toast('Shared.'); }
      catch (e) { toast('Could not share. Your access to this page may be view-only.'); }
      render();
    },
    'share-stop': async function () { try { await store.removeShare(); S.state.meta.share = []; persist(); S.tog.sharing = 0; toast('Sharing stopped.'); } catch (e) { toast('Could not stop sharing. Try again.'); } render(); },

    'care-back': function () { var C = S.care; S.care = null; if (C && C.o && C.o.expedition) { go('today'); return; } render(); var t = $('#t-today'); if (t) t.focus(); },
    'care-place': function () {
      var C = S.care; if (!C) return;
      // Claude gets one more look, told that the person says it is not about them; after that, or without Claude, the built-in reader places it
      submitEntry(C.text, C.via, Object.assign({}, C.o, { noCare: true, offline: C.again || !S.caps.sample || !!(C.o && C.o.offline) }));
    },

    'claude-connect': function () {
      if (S.connBusy) return;
      function val(id) { var el = $(id); return el ? el.value : ''; }
      var keyEl = $('#k-key'), st = $('#k-status'), btns = sheet.querySelectorAll('[data-act="claude-connect"]');
      S.connBusy = true;
      btns.forEach(function (b) { b.disabled = true; });
      if (st) { st.className = 'status'; st.innerHTML = '<i></i>Asking Claude one short question with this key'; }
      ENV.claude.connect({ key: val('#k-key'), main: val('#k-main'), quick: val('#k-quick'), workspace: val('#k-ws') }).then(function () {
        S.connBusy = false; if (keyEl) keyEl.value = '';
        S.caps.sample = ENV.claude.sample();
        toast('Connected. Claude answered.'); render();
      }, function (e) {
        S.connBusy = false;
        sheet.querySelectorAll('[data-act="claude-connect"]').forEach(function (b) { b.disabled = false; });
        var now = $('#k-status'), code = e && e.code;
        if (now) { now.className = 'note warn'; now.textContent = copyFor(code) + (e && e.detail && code !== 'network' && code !== 'need_workspace' ? ' Anthropic said: ' + e.detail : ''); }
        if (code === 'need_workspace' || code === 'bad_workspace') { // show where the workspace ID goes
          var adv = sheet.querySelector('.adv'), ws = $('#k-ws');
          if (adv) adv.open = true;
          if (ws) { ws.focus(); ws.scrollIntoView({ block: 'nearest' }); }
        }
      });
    },
    'claude-forget': async function () {
      if (!(await ask2('Forget this key?', 'The key will be removed from this browser, and the built-in reader will read your entries until you connect again. To cancel the key itself, revoke it in the Claude Console.', 'Forget it', true))) return;
      ENV.claude.forget(); S.caps.sample = null; toast('The key was removed from this browser.'); render();
    },

    'code-make': async function () {
      var regions = Array.prototype.map.call(document.querySelectorAll('input[name="share-region"]:checked'), function (i) { return i.value; }), nameEl = $('#share-name'), name = HZ.clip(HZ.str(nameEl ? nameEl.value : ''), 40);
      if (!regions.length) { toast('Tick at least one region.'); return; }
      var share = HZ.buildShare(S.state, regions);
      if (!share.units.length) { toast('You have not placed anything in those regions yet.'); return; }
      if (!(await ask2('Make a code for ' + share.units.length + (share.units.length === 1 ? ' structure?' : ' structures?'), 'Anyone you send the code to can read what you have placed in ' + regions.map(regionName).join(', ') + ', in your words.', 'Make the code'))) return;
      if (name) ENV.local.set('name.v1', name);
      S.state.meta.share = regions; persist();
      S.tog = S.tog || {}; S.tog.code = HZ.encodeShare(share, name);
      render(); var t = $('#t-mycode'); if (t) t.scrollIntoView({ block: 'nearest' });
    },
    'code-copy': function () {
      var code = S.tog && S.tog.code; if (!code) return;
      copyText(code, 'Copied. Send it to them any way you like.', null, function () { var t = $('#t-mycode'); if (t) { t.focus(); t.select(); toast('Copying is blocked here. The code is selected: copy it by hand.'); } });
    },
    'code-add': function () {
      var p = HZ.decodeShare(S.drafts.code || '');
      if (!p) { toast('That is not a Horizon share code. Ask them to copy all of it.'); return; }
      var list = (ENV.local.get('friends.v1') || []).filter(function (x) { return x && typeof x === 'object'; });
      var mine = { id: 'f' + Date.now().toString(36), name: p.name, at: p.at, regions: p.regions, units: p.units };
      list.push(mine); list = list.slice(-12);
      S.tog = S.tog || {};
      if (ENV.local.set('friends.v1', list)) S.tog.people = friends();
      else S.tog.people = (S.tog.people || []).concat([{ id: mine.id, name: mine.name, units: mine.units, at: mine.at }]); // this browser would not store it: keep it for this visit
      S.drafts.code = ''; toast('Added ' + p.name + '. Press Compare.'); render();
    },
    'friend-remove': async function (el) {
      var id = el.dataset.id, who = ((S.tog && S.tog.people) || []).filter(function (p) { return p.id === id; })[0]; if (!who) return;
      if (!(await ask2('Remove ' + who.name + '?', 'Their shared map will be removed from this browser. You can add it again with their share code.', 'Remove it', true))) return;
      ENV.local.set('friends.v1', (ENV.local.get('friends.v1') || []).filter(function (x) { return x && String(x.id) !== id; }));
      S.tog.people = (S.tog.people || []).filter(function (p) { return p.id !== id; }); render();
    },
    'backup-later': function () { var b = ENV.local.get('backup.v1') || {}; b.laterAt = Date.now(); ENV.local.set('backup.v1', b); render(); },
    'keep-ask': function () { ENV.keep().then(function (v) { S.kept = v; toast(v ? 'Done. This browser will keep your map.' : 'The browser said no for now. A saved copy is the sure way.'); render(); }); },

    'lens-copy': function () { copyText(JSON.stringify(HZ.lensExport(S.state)), 'Copied. Save it as horizon_lens_input.json for the script.'); },
    'lens-load': function () {
      var data; try { data = JSON.parse(S.drafts.lens || ''); } catch (e) { toast('That is not valid JSON. Paste the script\'s whole output.'); return; }
      var n = HZ.applyLensImport(S.state, data);
      if (!n) { toast('Nothing in that matched what is on your map.'); return; }
      S.drafts.lens = ''; changed(); toast('Lens data loaded for ' + n + (n === 1 ? ' structure.' : ' structures.'));
    },
    'data-copy': function () { copyText(HZ.exportState(S.state), 'Copied. Paste it somewhere safe.', backedUp); },
    'data-save': function () {
      var d = S.caps.downloads; if (!d) return;
      d.save({ filename: 'horizon-' + HZ.dayKey() + '.json', data: HZ.exportState(S.state) }).then(function () { backedUp(); toast('Saved.'); }, function (e) { var c = e && e.code; if (c === 'declined') return; if (c === 'unavailable' || c === 'not_granted') { S.caps.downloads = null; render(); } toast('Could not save a file here. Use Copy instead.'); });
    },
    'data-import': async function () {
      var st = HZ.importState(S.drafts.import || '');
      if (!st) { toast('That does not look like a saved Horizon map.'); return; }
      if (!(await ask2('Replace your map?', 'The map you have now, with ' + S.state.units.length + ' structures, will be replaced by the pasted one, with ' + st.units.length + '.', 'Replace it', true))) return;
      S.state = st; S.drafts.import = ''; S.result = null; S.sel = null; changed(); world.fitLit(0); toast('Your map was replaced.');
    },
    'data-reset': async function () {
      var others = SOLO ? friends().length : 0;
      if (!(await ask2('Delete everything?', 'All ' + S.state.units.length + ' structures, every bet and every concept will be removed.' + (others ? ' So will the ' + (others === 1 ? 'map someone' : others + ' maps other people') + ' shared with you.' : '') + ' This cannot be undone. Save a copy first if you might want it.' + (SOLO && S.caps.sample ? ' Your Claude key stays connected; you can forget it under Claude.' : ''), 'Delete everything', true))) return;
      if (SOLO) { ENV.local.del('friends.v1'); ENV.local.del('backup.v1'); }
      S.state = HZ.newState(); S.result = null; S.care = null; S.sel = null; S.exp = null; S.tog = null; world.setPartner(null); changed(); world.fitLit(0); go('today'); toast('Your map is empty again.');
    }
  };
  function copyText(text, ok, done, blocked) {
    function no() { if (blocked) blocked(); else toast('Copying is blocked here.'); }
    try { navigator.clipboard.writeText(text).then(function () { toast(ok); if (done) done(); }, no); }
    catch (e) { no(); }
  }

  /* ---------- events ---------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el || el.disabled) return;
    var fn = A[el.dataset.act]; if (fn) fn(el, e);
  });
  document.addEventListener('input', function (e) {
    var t = e.target; if (t && t.dataset && t.dataset.draft) { S.drafts[t.dataset.draft] = t.value; syncNeed(t.dataset.draft); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target, act = t && t.dataset && t.dataset.actChange;
    if (act === 'tint') { S.state.meta.tint = t.checked; world.setTint(t.checked); persist(); }
    if (act === 'narrate') { S.state.meta.narrate = t.checked; persist(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (!scrim.hidden) { A.dlg({ dataset: { v: '0' } }); } else if (S.film) closeFilm(); else if (S.sel) A.back(); return; }
    if (e.key === 'Enter' && e.target.id === 'k-key') { e.preventDefault(); A['claude-connect'](); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.dataset && e.target.dataset.draft) {
      var b = sheet.querySelector('[data-need="' + e.target.dataset.draft + '"]'); if (b && !b.disabled) { e.preventDefault(); b.click(); }
    }
  });
  window.addEventListener('resize', function () { if (world) { world.resize(); layout(); } });
  window.addEventListener('hashchange', function () { var v = location.hash.replace('#', ''); if (VIEWS.indexOf(v) !== -1 && v !== S.view) go(v); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) store.flushNow(); });

  /* ---------- start ---------- */
  function wireDictation(d) {
    S.caps.dictation = d;
    d.onFinal(function (e) {
      var id = S.listening; if (!id) return;
      var cur = S.drafts[id] || '', add = (e && e.text) || '';
      S.drafts[id] = cur ? cur + add : add.replace(/^\s+/, ''); S.voiced[id] = true;
      var ta = document.getElementById('t-' + id); if (ta) { ta.value = S.drafts[id]; ta.scrollTop = ta.scrollHeight; }
      syncNeed(id);
    });
    d.onPartial(function (e) { S.partial = (e && e.text) || ''; var p = S.listening && document.getElementById('partial-' + S.listening); if (p) p.textContent = S.partial; });
    d.onState(function (e) {
      if (e.state !== 'idle') return;
      S.listening = null; S.partial = '';
      if (e.reason === 'not_granted' || e.reason === 'unavailable') { S.caps.dictation = null; toast('Dictation is not available here. Typing works.'); }
      else if (e.reason === 'network') toast('Dictation needs an internet connection.');
      render();
    });
  }
  async function start(hot) {
    hot = hot || {};
    if (VIEWS.indexOf(hot.view) !== -1) { S.view = hot.view; S.sub = hot.sub || null; }
    else { var hv = location.hash.replace('#', ''); if (VIEWS.indexOf(hv) !== -1) S.view = hv; }
    if (hot.drafts && typeof hot.drafts === 'object') S.drafts = hot.drafts;
    world = window.HZWorld.create($('#world'), { reducedMotion: calm.matches, onPick: function (hit) { if (S.film) return; if (!hit) { if (S.sel) A.back(); return; } openItem(hit.kind, hit.id, false); } });
    render(); world.fitLit(0);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { world.invalidate(); });
    if (document.fonts && document.fonts.load) Promise.all([document.fonts.load('italic 500 15px Literata'), document.fonts.load('600 13px "Bricolage Grotesque"')]).then(function () { world.invalidate(); }, noop); // the map draws its labels in these

    var use = ENV.use;
    use('sample').then(function (v) { S.caps.sample = v; if (S.ready) render(); });
    use('dictation').then(function (v) { if (v) { wireDictation(v); render(); } });
    use('tts').then(function (v) { S.caps.tts = v; if (v && S.ready) render(); });
    use('downloads').then(function (v) { S.caps.downloads = v; if (v && S.ready) render(); });
    var caps = await Promise.all([use('db'), use('user')]);
    S.caps.user = caps[1];
    await store.init({ db: caps[0], user: caps[1] });
    try { var saved = await store.load(); if (saved) S.state = saved; }
    catch (e) { store.detach('unread'); S.loadNote = 'Your saved map could not be reached, so nothing you do now will be saved. Reload the page to try again.'; }
    store.onStatus(function () { if (S.view === 'today' && !S.working && !S.sel && !document.activeElement.dataset.draft) render(); });
    S.ready = true;
    world.setTint(!!S.state.meta.tint); world.setState(S.state); render(); world.fitLit(0);
    if (SOLO) ENV.kept().then(function (v) { S.kept = v; });
  }
  try { if (window.claude && window.claude.hot && window.claude.hot.snapshot) window.claude.hot.snapshot(function () { return { view: S.view, sub: S.sub, drafts: S.drafts }; }); } catch (e) {}
  if (window.claude && window.claude.hot && typeof window.claude.hot.ready === 'function') window.claude.hot.ready(start);
  else start((window.claude && window.claude.hot && window.claude.hot.data) || {});

  window.__hz = { S: S, world: function () { return world; }, store: store }; // for the test harness
})();
