/* A stand-in for the artifact runtime, injected before the page's own scripts in tests.
   It follows the documented contract: claude.use(name) resolves a namespace or null. */
(function () {
  var cfg = window.__mockCfg || {};
  var KEY = '__mockdb';
  function loadDb() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function saveDb(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {} }
  var store = loadDb(), writes = [];
  window.__mock = { writes: writes, store: function () { return store; }, sampleCalls: [], spoken: [], saved: [] };
  var SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
  function check(path, even) {
    var segs = path.split('/');
    if (segs.some(function (s) { return !SEG.test(s); })) throw new TypeError('bad path segment in ' + path);
    if ((segs.length % 2 === 0) !== even) throw new TypeError((even ? 'document' : 'collection') + ' path has wrong parity: ' + path);
    return segs;
  }
  function snap(id, body) { return { id: id, exists: body !== undefined, data: function () { return body === undefined ? undefined : Object.freeze(JSON.parse(JSON.stringify(body))); }, metadata: { fromCache: false, hasPendingWrites: false } }; }
  function later(v, ms) { return new Promise(function (r) { setTimeout(function () { r(v); }, ms || 15); }); }
  function docRef(path) {
    check(path, true);
    var id = path.split('/').pop();
    return {
      id: id, path: path,
      get: function () { return later(snap(id, store[path])); },
      set: function (data) {
        if (cfg.readOnly) return Promise.reject({ code: 'invalid_argument', message: 'read only' });
        if (!data || typeof data !== 'object' || Array.isArray(data)) return Promise.reject({ code: 'invalid_argument', message: 'body must be an object' });
        if (JSON.stringify(data).length > 256 * 1024) return Promise.reject({ code: 'invalid_argument', message: 'too large' });
        store[path] = JSON.parse(JSON.stringify(data)); writes.push({ op: 'set', path: path }); saveDb(store); return later();
      },
      update: function (data) { if (store[path] === undefined) return Promise.reject({ code: 'invalid_argument', message: 'missing' }); store[path] = Object.assign({}, store[path], data); writes.push({ op: 'update', path: path }); saveDb(store); return later(); },
      delete: function () { delete store[path]; writes.push({ op: 'delete', path: path }); saveDb(store); return later(); },
      onSnapshot: function () { return function () {}; },
      collection: function (p) { return colRef(path + '/' + p); }
    };
  }
  function colRef(path) {
    check(path, false);
    function query(lim) {
      return {
        path: path, where: function () { return query(lim); }, orderBy: function () { return query(lim); }, limit: function (n) { return query(n); },
        get: function () {
          if (cfg.dbFail) return Promise.reject({ code: 'unavailable', message: 'down' });
          var depth = path.split('/').length + 1, docs = [];
          Object.keys(store).sort().forEach(function (p) { if (p.indexOf(path + '/') === 0 && p.split('/').length === depth) docs.push(snap(p.split('/').pop(), store[p])); });
          if (lim) docs = docs.slice(0, lim);
          return later({ docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: false } }, cfg.dbDelay || 15);
        },
        onSnapshot: function () { return function () {}; },
        doc: function (id) { return docRef(path + '/' + (id || 'auto' + Math.random().toString(36).slice(2))); },
        add: function (data) { var r = docRef(path + '/auto' + Math.random().toString(36).slice(2)); return r.set(data).then(function () { return r; }); }
      };
    }
    return query(0);
  }
  var db = Object.freeze({ doc: docRef, collection: colRef });

  var uid = cfg.uid || 'u_tester';
  var user = Object.freeze({
    id: function () { return later(uid); }, isOwner: function () { return later(true); }, canEdit: function () { return later(true); }, can: function () { return later(true); },
    me: function () { return later({ id: uid, name: 'Tester', avatarUrl: '', color: '#888', email: null, isOwner: true, canEdit: true }); },
    profiles: function (ids) { var out = {}; [].concat(ids).forEach(function (id) { out[id] = { id: id, name: id === 'u_friend' ? 'Ada' : '', avatarUrl: '', color: '#888', email: null, isMe: id === uid, guest: false }; }); return later(out); }
  });

  /* The answers come from test/fake-model.js, which the test harness loads just before this file. */
  var model = null;
  function answer(prompt) { if (!model) model = window.__fakeModel(window.HZ); return model.answer(prompt); }
  function sample(input, opts) {
    return sample.json(input, opts).then(function (v) { return { text: JSON.stringify(v), truncated: false, modelTierApplied: 'default' }; });
  }
  sample.json = function (input, opts) {
    var prompt = typeof input === 'string' ? input : input.map(function (m) { return m.content; }).join('\n');
    window.__mock.sampleCalls.push({ prompt: prompt, opts: opts ? { modelTier: opts.modelTier } : null });
    return new Promise(function (res, rej) {
      var mode = window.__sampleMode || cfg.sampleMode || 'ok';
      var t = setTimeout(function () {
        if (mode !== 'ok') { rej({ code: mode, message: 'mock ' + mode }); return; }
        try { res(answer(prompt)); } catch (e) { rej({ code: 'upstream_error', message: String(e) }); }
      }, cfg.sampleDelay || 250);
      if (opts && opts.signal) opts.signal.addEventListener('abort', function () { clearTimeout(t); rej({ code: 'cancelled', message: 'aborted' }); });
    });
  };
  sample.limits = function () { return later({ maxPromptBytes: 262144 }); };

  var dFinal = [], dPartial = [], dState = [], dOn = false;
  var dictation = Object.freeze({
    start: function () {
      dOn = true; dState.forEach(function (h) { h({ state: 'listening' }); });
      setTimeout(function () { if (dOn) dPartial.forEach(function (h) { h({ text: 'I think most' }); }); }, 60);
      setTimeout(function () { if (dOn) { dPartial.forEach(function (h) { h({ text: '' }); }); dFinal.forEach(function (h) { h({ text: ' I think most plans fail quietly.' }); }); } }, 140);
      return later();
    },
    stop: function () { dOn = false; return later(null, 30).then(function () { dState.forEach(function (h) { h({ state: 'idle', reason: 'stopped' }); }); }); },
    active: function () { return dOn; },
    onFinal: function (h) { dFinal.push(h); return function () {}; }, onPartial: function (h) { dPartial.push(h); return function () {}; }, onState: function (h) { dState.push(h); return function () {}; }
  });
  var tts = Object.freeze({ speak: function (t) { window.__mock.spoken.push(t); return later(null, 80); }, stop: function () {}, onState: function () { return function () {}; } });
  var downloads = Object.freeze({ save: function (r) { window.__mock.saved.push({ filename: r.filename, size: String(r.data).length }); return later({ status: 'saved' }); } });

  var caps = { db: db, user: user, sample: sample, dictation: dictation, tts: tts, downloads: downloads };
  (cfg.without || []).forEach(function (n) { caps[n] = null; });
  window.claude = Object.freeze({ use: function (name) { return later(Object.prototype.hasOwnProperty.call(caps, name) ? caps[name] : null, cfg.useDelay || 20); } });
})();
