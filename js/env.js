/* Horizon environment. Loaded first.

   The app needs five services: ask Claude, dictation, reading aloud, saving a file, and storage.
   - Inside Claude (the page published as an artifact) they come from the Claude runtime, window.claude.
   - On an ordinary website they come from this file: the person's own Claude API key, the browser's
     speech features, a plain file download, and this browser's storage. There is no server.

   The key rules for the website case, all enforced here:
   - The page may talk to exactly one other host, api.anthropic.com, and only with the person's own key.
   - The key is kept in this browser's storage, is never drawn back onto the page in full, and is only
     stored after Claude has answered with it once.
   - No other script, font, image or request from anywhere else (see the policy below). */
(function (root) {
  'use strict';

  var VERSION = '0.2.0';
  var API_URL = 'https://api.anthropic.com/v1/messages';
  var API_VERSION = '2026-10-21';
  var MODELS = { main: 'claude-sonnet-5-5', quick: 'claude-haiku-5-5' };
  var SYSTEM = 'Reply with exactly one JSON object and nothing else. No code fences and no text before or after it.';
  var LINKS = {
    source: 'https://github.com/AviralGupta2211/horizon',
    feedback: 'https://github.com/AviralGupta2211/horizon/issues/new',
    keys: 'https://platform.claude.com/settings/keys',
    helplines: 'https://findahelpline.com'
  };
  /* What the page may load and where it may send things, when it runs as a website. */
  var POLICY = [
    "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "font-src 'self'", "connect-src https://api.anthropic.com", "manifest-src 'self'", "base-uri 'none'", "form-action 'none'"
  ].join('; ');

  var KEY_RE = /^[\x21-\x7e]{20,400}$/, WS_RE = /^[A-Za-z0-9_\-]{6,80}$/, MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@\-]{2,80}$/;

  /* ---------- pure helpers (also used by the tests) ---------- */
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  /* The text of a reply: every text block, in order. Thinking blocks come first and are skipped. */
  function textOf(data) {
    var out = '';
    (data && Array.isArray(data.content) ? data.content : []).forEach(function (b) { if (b && b.type === 'text' && typeof b.text === 'string') out += b.text; });
    return out;
  }
  /* Models are asked for bare JSON. This also accepts JSON in a code fence or with a sentence around it. */
  function parseJson(text) {
    var t = String(text == null ? '' : text).trim(), v;
    if (!t) return undefined;
    try { v = JSON.parse(t); if (v && typeof v === 'object') return v; } catch (e) {}
    var f = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
    if (f) { try { v = JSON.parse(f[1].trim()); if (v && typeof v === 'object') return v; } catch (e2) {} }
    var a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a !== -1 && b > a) { try { v = JSON.parse(t.slice(a, b + 1)); if (v && typeof v === 'object') return v; } catch (e3) {} }
    return undefined;
  }
  /* Turn an error reply from the API into one of the app's own codes. `detail` is the API's own sentence. */
  function mapError(status, payload) {
    var err = payload && payload.error && typeof payload.error === 'object' ? payload.error : {};
    var type = String(err.type || ''), msg = String(err.message || ''), code;
    if (status === 401) code = /^CORS requests are not allowed/i.test(msg) ? 'org_blocked' : 'bad_key';
    else if (status === 402 || type === 'billing_error') code = 'billing';
    else if (status === 403) code = 'no_permission';
    else if (status === 404) code = /workspace/i.test(msg) ? 'bad_workspace' : 'bad_model';
    else if (status === 413) code = 'prompt_too_large';
    else if (status === 429) code = 'rate_limited';
    else if (status === 529 || type === 'overloaded_error') code = 'overloaded';
    else if (status === 400) {
      if (/anthropic-workspace-id/i.test(msg)) code = /valid workspace id/i.test(msg) ? 'bad_workspace' : 'need_workspace';
      else if (/spend|credit|billing|balance/i.test(msg)) code = 'billing';
      else if (/prompt is too long|too many tokens|context window/i.test(msg)) code = 'prompt_too_large';
      else code = 'bad_request';
    } else code = 'upstream_error';
    return { code: code, status: status, detail: clip(msg, 240) };
  }
  /* Break text into pieces a browser voice can speak without cutting out. */
  function speechChunks(text, max) {
    max = max || 220;
    var out = [], cur = '';
    (String(text || '').match(/[^.!?\n]+[.!?]*\s*|\n+/g) || []).forEach(function (s) {
      s = s.replace(/\s+/g, ' ');
      while (s.length > max) { var cut = s.lastIndexOf(' ', max); if (cut < 40) cut = max; if (cur.trim()) { out.push(cur.trim()); cur = ''; } out.push(s.slice(0, cut).trim()); s = s.slice(cut); }
      if ((cur + s).length > max && cur.trim()) { out.push(cur.trim()); cur = ''; }
      cur += s;
    });
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function cleanConn(o) {
    if (!o || typeof o !== 'object' || typeof o.key !== 'string' || !KEY_RE.test(o.key)) return null;
    return {
      key: o.key,
      workspace: typeof o.workspace === 'string' && WS_RE.test(o.workspace) ? o.workspace : '',
      main: typeof o.main === 'string' && MODEL_RE.test(o.main) ? o.main : MODELS.main,
      quick: typeof o.quick === 'string' && MODEL_RE.test(o.quick) ? o.quick : MODELS.quick
    };
  }

  if (typeof module === 'object' && module.exports) { // under Node, for the unit tests
    module.exports = { VERSION: VERSION, API_URL: API_URL, API_VERSION: API_VERSION, MODELS: MODELS, POLICY: POLICY, textOf: textOf, parseJson: parseJson, mapError: mapError, speechChunks: speechChunks, cleanConn: cleanConn };
    return;
  }

  var doc = root.document, nav = root.navigator || {};
  var cl = root.claude, inClaude = !!(cl && typeof cl.use === 'function');

  if (!inClaude && doc && doc.head) {
    var meta = doc.createElement('meta');
    meta.httpEquiv = 'Content-Security-Policy'; meta.content = POLICY;
    doc.head.appendChild(meta);
  }

  /* ---------- this browser's storage ---------- */
  function lsGet(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { root.localStorage.removeItem(k); } catch (e) {} }
  var local = {
    get: function (k) { var raw = lsGet('horizon.' + k); if (raw == null) return null; try { return JSON.parse(raw); } catch (e) { return null; } },
    set: function (k, v) { return lsSet('horizon.' + k, JSON.stringify(v)); },
    del: function (k) { lsDel('horizon.' + k); }
  };
  function keep() { // ask the browser not to clear this site's storage on its own
    try { if (nav.storage && nav.storage.persist) return nav.storage.persist().then(function (v) { return !!v; }, function () { return false; }); } catch (e) {}
    return Promise.resolve(false);
  }
  function kept() {
    try { if (nav.storage && nav.storage.persisted) return nav.storage.persisted().then(function (v) { return !!v; }, function () { return false; }); } catch (e) {}
    return Promise.resolve(false);
  }

  /* ---------- Claude, with the person's own key ---------- */
  var LS_CONN = 'horizon.claude.v1', conn = null, stored = false, lastError = null, noEffort = {};
  (function () { var raw = lsGet(LS_CONN); if (raw) { try { conn = cleanConn(JSON.parse(raw)); stored = !!conn; } catch (e) { conn = null; } } })();
  root.addEventListener('storage', function (e) { // the key was changed or forgotten in another tab
    if (e.key !== LS_CONN) return;
    try { conn = e.newValue ? cleanConn(JSON.parse(e.newValue)) : null; } catch (e2) { conn = null; }
    stored = !!conn;
  });

  function post(c, body, signal, ms) {
    var ctl = new AbortController(), timedOut = false, cancelled = false;
    var timer = setTimeout(function () { timedOut = true; ctl.abort(); }, ms);
    function onAbort() { cancelled = true; ctl.abort(); }
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort); }
    /* The last header is Anthropic's required opt-in for calls made from a web page. The risk it names is a
       key shipped inside a page for every visitor to read. Here there is no shipped key: each person pastes
       their own, and it goes from their browser to Anthropic and nowhere else. */
    var headers = { 'content-type': 'application/json', 'anthropic-version': API_VERSION, 'authorization': 'Bearer ' + c.key, 'anthropic-dangerous-direct-browser-access': 'true' };
    if (c.workspace) headers['anthropic-workspace-id'] = c.workspace;
    function done() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
    return root.fetch(API_URL, { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: headers, body: JSON.stringify(body), signal: ctl.signal })
      .then(function (rsp) {
        return rsp.text().then(function (text) {
          var data = null; try { data = JSON.parse(text); } catch (e) {}
          if (!rsp.ok) throw mapError(rsp.status, data);
          if (!data || !Array.isArray(data.content)) throw { code: 'upstream_error', detail: 'The reply was not in the expected form.' };
          return data;
        });
      })
      .then(function (data) { done(); return data; }, function (e) {
        done();
        // an aborted fetch throws a DOMException, which has a numeric code of its own: check why it stopped first
        if (cancelled) throw { code: 'cancelled' };
        if (timedOut) throw { code: 'timeout' };
        if (e && typeof e.code === 'string') throw e;
        throw { code: 'network', detail: clip(e && e.message, 160) };
      });
  }
  function request(c, o, signal) {
    var body = { model: o.model, max_tokens: o.max, messages: [{ role: 'user', content: o.prompt }] };
    if (o.system) body.system = o.system;
    if (o.effort && !noEffort[o.model]) body.output_config = { effort: o.effort };
    return post(c, body, signal, o.ms).catch(function (e) {
      // a model that does not take the effort setting: send the same request once more without it
      if (e.code === 'bad_request' && body.output_config && /output_config|effort/i.test(e.detail || '')) { noEffort[o.model] = true; delete body.output_config; return post(c, body, signal, o.ms); }
      throw e;
    });
  }
  var KEY_TROUBLE = ['bad_key', 'org_blocked', 'billing', 'no_permission', 'need_workspace', 'bad_workspace', 'bad_model'];
  function note(e) { lastError = e && KEY_TROUBLE.indexOf(e.code) !== -1 ? { code: e.code, detail: e.detail || '' } : lastError; }

  function sampleJson(input, opts) {
    opts = opts || {};
    var c = conn;
    if (!c) return Promise.reject({ code: 'not_granted', message: 'No Claude key is connected.' });
    var quick = opts.modelTier === 'quick', prompt = typeof input === 'string' ? input : JSON.stringify(input);
    return request(c, { model: quick ? c.quick : c.main, max: quick ? 6000 : 16000, effort: quick ? 'low' : 'medium', system: SYSTEM, prompt: prompt, ms: quick ? 70000 : 150000 }, opts.signal).then(function (data) {
      lastError = null;
      if (data.stop_reason === 'refusal') throw { code: 'refused' };
      var text = textOf(data), cut = data.stop_reason === 'max_tokens';
      if (!text.trim()) throw { code: cut ? 'cut_off' : 'empty_completion' };
      var v = parseJson(text);
      if (!v) throw { code: cut ? 'cut_off' : 'invalid_json' };
      return v;
    }, function (e) { note(e); throw e; });
  }
  var sample = { json: sampleJson };

  function info() {
    return { connected: !!conn, hint: conn ? conn.key.slice(-4) : '', main: conn ? conn.main : MODELS.main, quick: conn ? conn.quick : MODELS.quick, workspace: conn ? conn.workspace : '', stored: stored, lastError: lastError, defaults: MODELS };
  }
  /* Check a key by asking Claude one very short question with it. Only a key that works is kept. */
  function connect(input) {
    input = input || {};
    var key = String(input.key || '').replace(/\s+/g, ''), ws = String(input.workspace || '').trim(), main = String(input.main || '').trim(), quick = String(input.quick || '').trim();
    if (!key && conn) key = conn.key; // changing the models or the workspace only
    if (!KEY_RE.test(key)) return Promise.reject({ code: 'bad_key_format' });
    if (ws && !WS_RE.test(ws)) return Promise.reject({ code: 'bad_workspace' });
    if ((main && !MODEL_RE.test(main)) || (quick && !MODEL_RE.test(quick))) return Promise.reject({ code: 'bad_model' });
    var cand = cleanConn({ key: key, workspace: ws, main: main || MODELS.main, quick: quick || MODELS.quick });
    return request(cand, { model: cand.main, max: 1000, effort: 'low', prompt: 'Reply with the single word: ok', ms: 60000 }, null).then(function () {
      conn = cand; stored = lsSet(LS_CONN, JSON.stringify(cand)); lastError = null;
      return info();
    });
  }
  function forget() { conn = null; stored = false; lastError = null; lsDel(LS_CONN); }

  /* ---------- dictation, with the browser's own speech recognition ---------- */
  function makeDictation() {
    var SR = root.SpeechRecognition || root.webkitSpeechRecognition;
    if (typeof SR !== 'function') return null;
    var finals = [], partials = [], states = [], rec = null, want = false, restarts = 0;
    var android = /Android/i.test(nav.userAgent || '');
    function emit(list, v) { list.slice().forEach(function (h) { try { h(v); } catch (e) {} }); }
    function sub(list) { return function (h) { list.push(h); return function () { var i = list.indexOf(h); if (i !== -1) list.splice(i, 1); }; }; }
    function idle(reason) { want = false; rec = null; emit(partials, { text: '' }); emit(states, { state: 'idle', reason: reason }); }
    function begin() {
      var r = new SR(), err = null, gotFinal = false;
      rec = r;
      r.lang = nav.language || 'en-US'; r.interimResults = true; r.maxAlternatives = 1;
      r.continuous = !android; // Android repeats itself in continuous mode, so there it listens one phrase at a time
      r.onresult = function (e) {
        var interim = '';
        for (var i = e.resultIndex; i < e.results.length; i++) {
          var res = e.results[i], t = res && res[0] ? String(res[0].transcript || '') : '';
          if (res.isFinal) { if (t.trim()) { gotFinal = true; emit(finals, { text: ' ' + t.trim() }); } }
          else interim += t;
        }
        emit(partials, { text: interim.trim() });
      };
      r.onerror = function (e) { err = (e && e.error) || 'error'; };
      r.onend = function () {
        if (rec !== r) return;
        if (err === 'not-allowed' || err === 'service-not-allowed') { idle('not_granted'); return; }
        if (err === 'audio-capture' || err === 'language-not-supported') { idle('unavailable'); return; }
        if (want && android && gotFinal && !err && restarts < 60) { restarts++; try { begin(); return; } catch (e2) {} }
        idle(!want ? 'stopped' : err === 'network' ? 'network' : 'ended');
      };
      r.start();
    }
    return {
      start: function () {
        if (want) return Promise.resolve();
        want = true; restarts = 0;
        try { begin(); } catch (e) { want = false; rec = null; return Promise.reject({ code: 'unavailable', message: String((e && e.message) || e) }); }
        emit(states, { state: 'listening' });
        return Promise.resolve();
      },
      /* Resolves once the recogniser has handed over its last words. */
      stop: function () {
        var r = rec; want = false;
        if (!r) return Promise.resolve();
        return new Promise(function (res) {
          var over = false, prev = r.onend;
          function fin() { if (!over) { over = true; res(); } }
          r.onend = function () { if (prev) prev(); fin(); };
          try { r.stop(); } catch (e) { rec = null; fin(); }
          setTimeout(function () { if (rec === r) idle('stopped'); fin(); }, 2500);
        });
      },
      active: function () { return want; },
      onFinal: sub(finals), onPartial: sub(partials), onState: sub(states)
    };
  }

  /* ---------- reading aloud, with a voice on the device where the browser lists one ---------- */
  function makeTts() {
    var syn = root.speechSynthesis, Utter = root.SpeechSynthesisUtterance;
    if (!syn || typeof Utter !== 'function') return null;
    var token = 0;
    function pick() {
      var vs = []; try { vs = syn.getVoices() || []; } catch (e) {}
      var lang = String(nav.language || 'en').slice(0, 2).toLowerCase(), here = vs.filter(function (v) { return v.localService; });
      return here.filter(function (v) { return String(v.lang || '').toLowerCase().indexOf(lang) === 0; })[0] || here.filter(function (v) { return /^en/i.test(v.lang || ''); })[0] || here[0] || null;
    }
    function voices() { // some browsers fill the list a moment after the page loads
      return new Promise(function (res) {
        var have = []; try { have = syn.getVoices() || []; } catch (e) {}
        if (have.length) { res(); return; }
        var over = false; function fin() { if (!over) { over = true; res(); } }
        try { syn.addEventListener('voiceschanged', fin, { once: true }); } catch (e) {}
        setTimeout(fin, 700);
      });
    }
    return {
      speak: function (text) {
        var my = ++token, parts = speechChunks(text);
        try { syn.cancel(); } catch (e) {}
        if (!parts.length) return Promise.resolve();
        return voices().then(function () {
          var voice = pick();
          return new Promise(function (res, rej) {
            var i = 0, spoke = false;
            function next() {
              if (my !== token || i >= parts.length) { res(); return; }
              var u = new Utter(parts[i++]), over = false;
              if (voice) { u.voice = voice; u.lang = voice.lang; }
              function fin() { if (!over) { over = true; clearTimeout(guard); next(); } }
              var guard = setTimeout(fin, 6000 + u.text.length * 110); // some browsers never report the end
              u.onstart = function () { spoke = true; };
              u.onend = fin;
              u.onerror = function (e) {
                var why = e && e.error;
                if (why === 'not-allowed' && !spoke) { over = true; clearTimeout(guard); rej({ code: 'unavailable' }); return; }
                if (why === 'canceled' || why === 'interrupted') { over = true; clearTimeout(guard); res(); return; }
                fin();
              };
              try { syn.speak(u); } catch (e) { over = true; clearTimeout(guard); rej({ code: 'unavailable' }); }
            }
            next();
          });
        });
      },
      stop: function () { token++; try { syn.cancel(); } catch (e) {} }
    };
  }

  /* ---------- saving a file ---------- */
  var downloads = {
    save: function (r) {
      try {
        var url = root.URL.createObjectURL(new root.Blob([String(r.data)], { type: r.type || 'application/json' })), a = doc.createElement('a');
        a.href = url; a.download = r.filename || 'horizon.json'; a.rel = 'noopener'; a.style.display = 'none';
        doc.body.appendChild(a); a.click();
        setTimeout(function () { root.URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 4000);
        return Promise.resolve({ status: 'saved' });
      } catch (e) { return Promise.reject({ code: 'unavailable' }); }
    }
  };

  var dictation, tts;
  function own(name) {
    if (name === 'sample') return conn ? sample : null;
    if (name === 'dictation') { if (dictation === undefined) dictation = makeDictation(); return dictation; }
    if (name === 'tts') { if (tts === undefined) tts = makeTts(); return tts; }
    if (name === 'downloads') return doc && root.Blob && root.URL && root.URL.createObjectURL ? downloads : null;
    return null; // no database and no accounts on a plain website: the map stays in this browser
  }
  /* Resolves the named service, or null when this place does not have it. Never rejects. */
  function use(name) {
    if (inClaude) { try { return cl.use(name).then(function (v) { return v || null; }, function () { return null; }); } catch (e) { return Promise.resolve(null); } }
    return Promise.resolve(own(name));
  }

  root.HZEnv = {
    version: VERSION, standalone: !inClaude, links: LINKS, use: use, local: local, keep: keep, kept: kept,
    claude: { info: info, connect: connect, forget: forget, sample: function () { return conn ? sample : null; } }
  };
})(typeof window !== 'undefined' ? window : this);
