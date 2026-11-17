/* Horizon storage. Inside Claude, durable data lives in the page's database, in the viewer's own private
   subtree. On a plain website there is no database, so the map is kept in this browser only, and the app says so. */
(function (root) {
  'use strict';
  var HZ = root.HZ, LS_KEY = 'horizon.state.v1';

  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej({ code: 'timeout', message: 'timed out' }); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function localOk() { try { var k = '__hz'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch (e) { return false; } }

  function create() {
    var db = null, uid = null, mode = 'memory', saved = {}, timer = null, flushing = false, pending = null, onStatus = null;
    var status = { mode: 'memory', error: null, savedAt: 0, dirty: false };
    function col() { return db.collection('data/users/' + uid); }
    function tell() { status.mode = mode; if (onStatus) onStatus(status); }

    async function init(caps) {
      db = caps.db || null; uid = null;
      if (db && caps.user) { try { uid = await caps.user.id(); } catch (e) { uid = null; } }
      mode = db && uid ? 'db' : (localOk() ? 'local' : 'memory');
      tell(); return mode;
    }
    /* Returns the saved state, or null when there is none. Throws if the store could not be read:
       the caller must then stop saving, so an unread world is never overwritten. */
    async function load() {
      if (mode === 'db') {
        var snap = await withTimeout(col().limit(1000).get(), 10000);
        var docs = {};
        snap.docs.forEach(function (d) { if (d.exists) docs[d.id] = JSON.parse(JSON.stringify(d.data())); });
        var state = HZ.fromDocs(docs);
        saved = {};
        Object.keys(docs).forEach(function (id) { saved[id] = ''; }); // known to exist; content compared below
        if (state) { var canon = HZ.toDocs(state); Object.keys(canon).forEach(function (id) { if (docs[id]) saved[id] = JSON.stringify(canon[id]); }); }
        return state;
      }
      if (mode === 'local') {
        var raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        try { return HZ.repair(JSON.parse(raw)); } catch (e) { return null; }
      }
      return null;
    }
    function detach(reason) { mode = 'memory'; status.error = reason || 'detached'; tell(); }

    async function flush() {
      if (flushing) return;
      flushing = true;
      var failed = false;
      while (pending) {
        var state = pending; pending = null; failed = false;
        try {
          if (mode === 'db') {
            var docs = HZ.toDocs(state), ids = Object.keys(docs), i;
            for (i = 0; i < ids.length; i++) {
              var json = JSON.stringify(docs[ids[i]]);
              if (saved[ids[i]] === json) continue;
              await writeDoc(ids[i], JSON.parse(json)); // one write at a time, only what changed
              saved[ids[i]] = json;
            }
            var stale = Object.keys(saved).filter(function (id) { return !docs[id]; });
            for (i = 0; i < stale.length; i++) { await col().doc(stale[i]).delete(); delete saved[stale[i]]; }
          } else if (mode === 'local') {
            localStorage.setItem(LS_KEY, JSON.stringify(state));
          }
          status.error = null; status.savedAt = Date.now();
        } catch (e) {
          // whatever was written stays written; the rest goes out with the next change
          status.error = (e && e.code) || 'error'; failed = true;
        }
      }
      status.dirty = failed; flushing = false; tell();
    }
    var retried = {};
    async function writeDoc(id, body) {
      try { await col().doc(id).set(body); }
      catch (e) {
        if (e && e.code === 'unavailable' && !retried[id]) { retried[id] = 1; await new Promise(function (r) { setTimeout(r, 700 + Math.random() * 600); }); await col().doc(id).set(body); retried[id] = 0; return; }
        retried[id] = 0; throw e;
      }
    }
    function save(state) {
      if (mode === 'memory') return;
      pending = state; status.dirty = true;
      clearTimeout(timer); timer = setTimeout(flush, 250);
    }
    function flushNow() { clearTimeout(timer); return flush(); }

    async function publishShare(share) { if (mode !== 'db') throw { code: 'no_db' }; await db.doc('shares/' + uid).set(JSON.parse(JSON.stringify(share))); }
    async function removeShare() { if (mode !== 'db') return; await db.doc('shares/' + uid).delete(); }
    async function listShares() {
      if (mode !== 'db') return [];
      var snap = await withTimeout(db.collection('shares').limit(200).get(), 10000);
      return snap.docs.filter(function (d) { return d.exists; }).map(function (d) { return { id: d.id, mine: d.id === uid, data: JSON.parse(JSON.stringify(d.data())) }; });
    }

    return {
      init: init, load: load, save: save, flushNow: flushNow, detach: detach,
      publishShare: publishShare, removeShare: removeShare, listShares: listShares,
      mode: function () { return mode; }, uid: function () { return uid; }, status: function () { return status; },
      onStatus: function (fn) { onStatus = fn; }
    };
  }
  root.HZStore = { create: create };
})(typeof self !== 'undefined' ? self : this);
