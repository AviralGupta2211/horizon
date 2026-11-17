/* Horizon world view: the island at night, drawn isometric on one canvas. */
(function (root) {
  'use strict';
  var HZ = root.HZ;
  var TW = 48, TH = 24, HS = 9, SCALE = 1.5;
  var LAMP = '#ffcf7a', MINT = '#86dcc9', EMBER = '#ea6a52', MIST = '#9db3d9', COOL = '#8fb8ff', GOOD = '#35c24a';
  var FOG_RGB = [26, 35, 55];
  var TINT = {
    self: [46, 60, 108], people: [80, 54, 98], work: [44, 72, 100], money: [94, 76, 50],
    society: [58, 72, 90], nature: [32, 86, 78], meaning: [68, 52, 116], play: [102, 52, 84]
  };
  var WOOD = { t: '#74624e', l: '#55473a', r: '#3d332b' }, ROOF = { l: '#8a5140', r: '#643a2e' };
  var STONE = { t: '#b4bed0', l: '#8c97ad', r: '#69738c' }, CLOTH = { l: '#93826a', r: '#6e604e' };
  var GOLD = { l: '#f0b450', r: '#c98f34' };

  function rgb(c, k) { return 'rgb(' + Math.round(c[0] * k) + ',' + Math.round(c[1] * k) + ',' + Math.round(c[2] * k) + ')'; }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function hexA(hex, a) { var n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }
  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  var sprites = {};
  function glow(color) {
    if (sprites[color]) return sprites[color];
    var c = document.createElement('canvas'); c.width = c.height = 128;
    var g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, hexA(color, 0.95)); gr.addColorStop(0.25, hexA(color, 0.45)); gr.addColorStop(0.6, hexA(color, 0.12)); gr.addColorStop(1, hexA(color, 0));
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return (sprites[color] = c);
  }

  function create(canvas, opts) {
    opts = opts || {};
    var ctx = canvas.getContext('2d'), T = HZ.terrain(), N = HZ.N;
    var W = 300, H = 300, dpr = 1;
    var cam = { x: 0, y: (T.cx + T.cy) * TH / 2, z: 1 };
    var insets = { left: 0, right: 0, top: 0, bottom: 0 };
    var state = HZ.newState(), rev = HZ.computeReveal(state), lv = HZ.computeHeights(state);
    var topCol = new Array(N * N), leftCol = new Array(N * N), rightCol = new Array(N * N);
    var items = [], hits = [], selected = null, hover = null, tint = false, partner = null, born = {};
    var reduced = !!opts.reducedMotion, flight = null, timer = null, raf = 0, dirty = true, destroyed = false;

    function proj(x, y, level) { return { X: (x - y) * TW / 2, Y: (x + y) * TH / 2 - (level || 0) * HS }; }
    function levelAt(x, y) { var xi = Math.round(x), yi = Math.round(y); if (xi < 0 || yi < 0 || xi >= N || yi >= N) return 0; return lv[yi * N + xi]; }
    function base(pos) { return proj(pos.x, pos.y, levelAt(pos.x, pos.y)); }
    function centre() { return { x: insets.left + (W - insets.left - insets.right) / 2, y: insets.top + (H - insets.top - insets.bottom) / 2 }; }
    function toScreen(p) { var c = centre(); return { x: (p.X - cam.x) * cam.z + c.x, y: (p.Y - cam.y) * cam.z + c.y }; }

    function rebuild() {
      rev = HZ.computeReveal(state); lv = HZ.computeHeights(state);
      for (var i = 0; i < N * N; i++) {
        if (!T.land[i]) continue;
        var x = i % N, y = (i / N) | 0;
        var r = Math.pow(rev[i], 0.8), col = mix(FOG_RGB, TINT[HZ.REGION_IDS[T.region[i]]], r);
        var k = 0.84 + 0.075 * lv[i] + (HZ.noise2(x * 1.7, y * 1.7, 5) - 0.5) * 0.09;
        if (T.coast[i] <= 1) k *= 0.92;
        topCol[i] = rgb(col, k); leftCol[i] = rgb(col, k * 0.68); rightCol[i] = rgb(col, k * 0.5);
      }
      items = [];
      var betBy = {};
      state.bets.forEach(function (b) { if (!betBy[b.unit] || b.status === 'open') betBy[b.unit] = b.status; });
      state.units.forEach(function (u) { if (u.pos) items.push({ kind: 'unit', id: u.id, pos: u.pos, u: u, bet: betBy[u.id] || null, s: u.pos.x + u.pos.y }); });
      state.concepts.forEach(function (c) { if (c.pos) items.push({ kind: 'concept', id: c.id, pos: c.pos, c: c, s: c.pos.x + c.pos.y }); });
      state.doors.forEach(function (d) { if (d.pos && !d.answeredAt) items.push({ kind: 'door', id: d.id, pos: d.pos, d: d, s: d.pos.x + d.pos.y }); });
      if (partner) partner.forEach(function (p, i) { items.push({ kind: 'partner', id: 'p' + i, pos: p.pos, p: p, s: p.pos.x + p.pos.y }); });
      items.push({ kind: 'landing', id: 'landing', pos: { x: Math.round(T.cx), y: Math.round(T.cy) }, s: Math.round(T.cx) + Math.round(T.cy) });
      items.sort(function (a, b) { return a.s - b.s || a.pos.x - b.pos.x; });
      dirty = true;
    }

    /* ---- drawing primitives ---- */
    function poly(pts, fill, stroke) {
      ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
      for (var i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
    }
    function box(x, y, w, h, c, ghost) {
      var hh = w / 2;
      if (ghost) {
        ctx.setLineDash([2.5, 2.5]); ctx.lineWidth = 1;
        poly([x - w, y, x, y + hh, x, y + hh - h, x - w, y - h], 'rgba(170,180,200,0.05)', 'rgba(190,200,220,0.6)');
        poly([x + w, y, x, y + hh, x, y + hh - h, x + w, y - h], 'rgba(170,180,200,0.03)', 'rgba(190,200,220,0.6)');
        poly([x, y - hh - h, x + w, y - h, x, y + hh - h, x - w, y - h], null, 'rgba(190,200,220,0.6)');
        ctx.setLineDash([]);
        return;
      }
      poly([x - w, y, x, y + hh, x, y + hh - h, x - w, y - h], c.l);
      poly([x + w, y, x, y + hh, x, y + hh - h, x + w, y - h], c.r);
      poly([x, y - hh - h, x + w, y - h, x, y + hh - h, x - w, y - h], c.t);
    }
    function roof(x, y, w, rh, c, ghost) {
      var hh = w / 2;
      if (ghost) {
        ctx.setLineDash([2.5, 2.5]); ctx.lineWidth = 1;
        poly([x - w, y, x, y + hh, x, y - rh], 'rgba(170,180,200,0.05)', 'rgba(190,200,220,0.6)');
        poly([x + w, y, x, y + hh, x, y - rh], 'rgba(170,180,200,0.03)', 'rgba(190,200,220,0.6)');
        ctx.setLineDash([]);
        return;
      }
      poly([x - w, y, x, y + hh, x, y - rh], c.l);
      poly([x + w, y, x, y + hh, x, y - rh], c.r);
    }
    function windowsLeft(x, y, w, h, rows, color) {
      var hh = w / 2; ctx.fillStyle = color;
      for (var r = 0; r < rows; r++) {
        var px = x - w * 0.62, py = y + hh * 0.38 - (h * (r + 0.55)) / rows;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + 3, py + 1.5); ctx.lineTo(px + 3, py - 2.5); ctx.lineTo(px, py - 4); ctx.closePath(); ctx.fill();
      }
    }
    function windowsRight(x, y, w, h, rows, color) {
      var hh = w / 2; ctx.fillStyle = color;
      for (var r = 0; r < rows; r++) {
        var px = x + w * 0.34, py = y + hh * 0.66 - (h * (r + 0.55)) / rows;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + 3, py - 1.5); ctx.lineTo(px + 3, py - 5.5); ctx.lineTo(px, py - 4); ctx.closePath(); ctx.fill();
      }
    }
    function light(x, y, radius, color, alpha, flat) {
      if (alpha <= 0) return;
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.min(1, alpha);
      var ry = flat ? radius * 0.5 : radius;
      ctx.drawImage(glow(color), x - radius, y - ry, radius * 2, ry * 2);
      ctx.restore();
    }
    function lightColor(u) {
      if (tint) { var d = HZ.dominantLens(u); if (d) return HZ.LENS[HZ.LENS_IDS.indexOf(d)].color; }
      return u.tested ? '#ffe9bd' : LAMP;
    }

    /* ---- structures. Each returns the y of its top, for markers and labels. ---- */
    function drawBelief(x, y, u, ghost, k) {
      var d = u.depth || 0, c = u.conviction || 3, col = lightColor(u), wa = hexA(tint ? col : '#ffd98f', (0.38 + 0.13 * c) * k), top;
      var detail = cam.z >= 0.55 && !ghost;
      if (d === 0) { // a tent: said once
        roof(x, y, 7, 10, CLOTH, ghost); top = y - 10;
        if (detail) { ctx.fillStyle = wa; ctx.beginPath(); ctx.moveTo(x - 1.4, y + 2.6); ctx.lineTo(x + 1.6, y + 2.6); ctx.lineTo(x + 0.1, y - 3.2); ctx.closePath(); ctx.fill(); }
      } else if (d === 1) { // a hut: explained
        box(x, y, 7, 6, WOOD, ghost); roof(x, y - 6, 7, 6, ROOF, ghost); top = y - 12;
        if (detail) { windowsLeft(x, y, 7, 6, 1, wa); }
      } else if (d === 2) { // a house: has a lived example
        box(x, y, 9, 9, WOOD, ghost); roof(x, y - 9, 9, 7, ROOF, ghost); top = y - 16;
        if (detail) { windowsLeft(x, y, 9, 9, 1, wa); windowsRight(x, y, 9, 9, 1, wa); }
      } else if (d === 3) { // a tower: has faced its strongest objection
        box(x, y, 8, 21, WOOD, ghost); top = y - 21;
        if (!ghost) { box(x - 5, y - 21 + 2.5, 2.2, 3, WOOD); box(x + 5, y - 21 + 2.5, 2.2, 3, WOOD); box(x, y - 21 - 2.5, 2.2, 3, WOOD); box(x, y - 21 + 5, 2.2, 3, WOOD); top = y - 26; }
        if (detail) { windowsLeft(x, y, 8, 21, 2, wa); windowsRight(x, y, 8, 21, 2, wa); }
      } else { // stone, with a beacon: a prediction held
        box(x, y, 9, 27, STONE, ghost); top = y - 27;
        if (!ghost) { box(x, y - 27, 4, 4, STONE); top = y - 33; light(x, top - 1, 15, col, 0.9 * k); ctx.fillStyle = '#fff3d6'; ctx.beginPath(); ctx.arc(x, top - 1, 2, 0, 6.3); ctx.fill(); }
        if (detail) { windowsLeft(x, y, 9, 27, 3, wa); windowsRight(x, y, 9, 27, 3, wa); }
      }
      if (u.cracked && !ghost) {
        ctx.strokeStyle = EMBER; ctx.lineWidth = 1.3; ctx.beginPath();
        var ty = top + 4; ctx.moveTo(x + 3, ty); ctx.lineTo(x + 5.5, ty + (y - ty) * 0.3); ctx.lineTo(x + 2.5, ty + (y - ty) * 0.55); ctx.lineTo(x + 5, y + 2); ctx.stroke();
      }
      return top;
    }
    function drawValue(x, y, u, ghost, k) {
      var d = u.depth || 0, r = [5, 7, 9, 11, 12.5][d], c = u.conviction || 3, col = lightColor(u), cy = y - 6 - r * 0.8;
      if (ghost) {
        ctx.setLineDash([2.5, 2.5]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(190,200,220,0.6)';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 6); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, cy, r, 0, 6.3); ctx.stroke(); ctx.setLineDash([]);
        return cy - r;
      }
      ctx.fillStyle = '#3b2f28'; ctx.fillRect(x - 1.2, y - 7, 2.4, 8);
      ctx.fillStyle = u.tested ? '#5d7f86' : '#1d5248'; ctx.beginPath(); ctx.arc(x, cy, r, 0, 6.3); ctx.fill();
      ctx.fillStyle = u.tested ? '#7ea3aa' : '#2b7364'; ctx.beginPath(); ctx.arc(x - r * 0.28, cy - r * 0.3, r * 0.68, 0, 6.3); ctx.fill();
      if (cam.z >= 0.55) {
        ctx.fillStyle = hexA(tint ? col : '#ffd98f', 0.95 * k);
        for (var i = 0; i < c; i++) {
          var a = (HZ.hash32(u.id + i) % 628) / 100, rr = r * (0.25 + ((HZ.hash32(u.id + 'r' + i) % 60) / 100));
          ctx.beginPath(); ctx.arc(x + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.8, 1.1, 0, 6.3); ctx.fill();
        }
      }
      return cy - r;
    }
    function drawStory(x, y, u, ghost, k, t) {
      var d = u.depth || 0, hgt = 8 + 2 * d, f = reduced ? 1 : 1 + 0.12 * Math.sin(t / 130 + (HZ.hash32(u.id) % 10));
      if (ghost) {
        ctx.setLineDash([2.5, 2.5]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(190,200,220,0.6)';
        ctx.beginPath(); ctx.moveTo(x - 4, y + 1); ctx.quadraticCurveTo(x, y - hgt * 1.5, x + 4, y + 1); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
        return y - hgt;
      }
      ctx.strokeStyle = '#2c2420'; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x - 5, y + 1.5); ctx.lineTo(x + 5, y - 0.5); ctx.moveTo(x - 5, y - 0.5); ctx.lineTo(x + 5, y + 1.5); ctx.stroke();
      var col = lightColor(u);
      ctx.fillStyle = tint ? col : '#f08a3c'; ctx.beginPath(); ctx.moveTo(x - 3.6, y); ctx.quadraticCurveTo(x - 4, y - hgt * 0.5 * f, x, y - hgt * f); ctx.quadraticCurveTo(x + 4, y - hgt * 0.5 * f, x + 3.6, y); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffe2a0'; ctx.beginPath(); ctx.moveTo(x - 1.8, y); ctx.quadraticCurveTo(x - 2, y - hgt * 0.3 * f, x, y - hgt * 0.6 * f); ctx.quadraticCurveTo(x + 2, y - hgt * 0.3 * f, x + 1.8, y); ctx.closePath(); ctx.fill();
      return y - hgt * f;
    }
    function drawQuestion(x, y, u, ghost) {
      ctx.strokeStyle = ghost ? 'rgba(190,200,220,0.6)' : '#55617a'; ctx.lineWidth = 1.4;
      if (ghost) ctx.setLineDash([2.5, 2.5]);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 14); ctx.stroke(); ctx.setLineDash([]);
      if (ghost) { ctx.beginPath(); ctx.arc(x, y - 16, 3, 0, 6.3); ctx.stroke(); return y - 19; }
      light(x, y - 16, 12, MINT, 0.8);
      ctx.fillStyle = MINT; poly([x, y - 20, x + 3, y - 16, x, y - 12, x - 3, y - 16], MINT);
      return y - 20;
    }
    function drawConcept(x, y) {
      box(x, y, 3.4, 22, STONE); roof(x, y - 22, 3.4, 5, GOLD);
      light(x, y - 26, 13, LAMP, 0.55);
      return y - 27;
    }
    function drawDoor(x, y, t) {
      var p = reduced ? 0.8 : 0.65 + 0.3 * Math.sin(t / 700);
      light(x, y - 10, 34, MINT, 0.5 * p);
      box(x - 6.5, y + 1, 1.8, 15, { t: '#9fe6d6', l: '#5fb5a3', r: '#3f8f80' });
      box(x + 6.5, y + 1, 1.8, 15, { t: '#9fe6d6', l: '#5fb5a3', r: '#3f8f80' });
      var g = ctx.createLinearGradient(0, y - 24, 0, y);
      g.addColorStop(0, hexA(MINT, 0.42 * p)); g.addColorStop(1, hexA(MINT, 0.04));
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x - 6.5, y); ctx.lineTo(x - 6.5, y - 14); ctx.quadraticCurveTo(x, y - 27, x + 6.5, y - 14); ctx.lineTo(x + 6.5, y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = MINT; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 6.5, y - 13.5); ctx.quadraticCurveTo(x, y - 27, x + 6.5, y - 13.5); ctx.stroke();
      return y - 24;
    }
    function drawLanding(x, y) {
      ctx.strokeStyle = '#6b7690'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 17); ctx.stroke();
      light(x, y - 18, 16, LAMP, 0.85); light(x, y, 44, LAMP, 0.16, true);
      ctx.fillStyle = '#ffe9bd'; ctx.beginPath(); ctx.arc(x, y - 18, 2.4, 0, 6.3); ctx.fill();
      return y - 21;
    }
    function drawPartner(x, y) {
      ctx.strokeStyle = hexA(COOL, 0.7); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(x, y, 8, 4, 0, 0, 6.3); ctx.stroke();
      ctx.strokeStyle = '#51607c'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 11); ctx.stroke();
      light(x, y - 12, 14, COOL, 0.85); ctx.fillStyle = '#dbe8ff'; ctx.beginPath(); ctx.arc(x, y - 12, 2, 0, 6.3); ctx.fill();
      return y - 15;
    }
    function drawBetMark(x, y, status, t) {
      if (status === 'open') {
        var p = reduced ? 1 : 0.6 + 0.4 * Math.sin(t / 420);
        ctx.strokeStyle = hexA(LAMP, p); ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(x, y - 6, 3.2, 0, 6.3); ctx.stroke();
      } else if (status === 'held') {
        poly([x, y - 10, x + 3.6, y - 6, x, y - 2, x - 3.6, y - 6], GOOD);
      } else if (status === 'failed') {
        ctx.strokeStyle = EMBER; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(x - 3, y - 9); ctx.lineTo(x + 3, y - 3); ctx.moveTo(x + 3, y - 9); ctx.lineTo(x - 3, y - 3); ctx.stroke();
      }
    }

    function groundText(text, p, alpha) {
      ctx.save();
      ctx.translate(p.X, p.Y); ctx.transform(1, 0.5, -1, 0.5, 0, 0); ctx.scale(0.86, 0.86);
      ctx.font = 'italic 500 15px Literata, Georgia, serif'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(214,220,234,' + alpha + ')';
      var chars = text.toUpperCase().split(''), gap = 3.2, total = 0, widths = chars.map(function (ch) { var w = ctx.measureText(ch).width; total += w + gap; return w; });
      var x = -total / 2;
      chars.forEach(function (ch, i) { ctx.fillText(ch, x, 0); x += widths[i] + gap; });
      ctx.restore();
    }
    function chip(text, sx, sy) {
      ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = '600 13px "Bricolage Grotesque", system-ui, sans-serif'; ctx.textBaseline = 'middle';
      var w = Math.min(ctx.measureText(text).width, 220) + 18, x = Math.max(6, Math.min(W - w - 6, sx - w / 2)), y = Math.max(6, sy - 30);
      ctx.fillStyle = 'rgba(11,19,34,0.94)'; ctx.strokeStyle = 'rgba(236,231,218,0.22)'; ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, 24, 7); else ctx.rect(x, y, w, 24);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ece7da'; ctx.fillText(text, x + 9, y + 12.5, 220);
      ctx.restore();
    }

    /* ---- one frame ---- */
    function render(t) {
      if (destroyed) return;
      t = t || (typeof performance !== 'undefined' ? performance.now() : 0);
      dirty = false; hits = [];
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var sea = ctx.createLinearGradient(0, 0, 0, H);
      sea.addColorStop(0, '#0a111f'); sea.addColorStop(1, '#0e1a2d');
      ctx.fillStyle = sea; ctx.fillRect(0, 0, W, H);
      var c = centre(), z = cam.z;
      ctx.save(); ctx.translate(c.x, c.y); ctx.scale(z, z); ctx.translate(-cam.x, -cam.y);
      var minX = cam.x - c.x / z - 70, maxX = cam.x + (W - c.x) / z + 70, minY = cam.y - c.y / z - 80, maxY = cam.y + (H - c.y) / z + 80;
      var x, y, i, s, p;

      // shoreline: two faint rings in the water, the way charts draw a coast
      ctx.lineWidth = 1;
      for (s = 0; s <= 2 * (N - 1); s++) for (x = Math.max(0, s - N + 1); x <= Math.min(N - 1, s); x++) {
        y = s - x; i = y * N + x;
        if (!T.land[i] || T.coast[i] > 1) continue;
        p = proj(x, y, 0); if (p.X < minX || p.X > maxX || p.Y < minY || p.Y > maxY) continue;
        ctx.strokeStyle = 'rgba(140,165,210,0.10)';
        ctx.beginPath(); ctx.moveTo(p.X, p.Y - TH * 0.5 + 5); ctx.lineTo(p.X + TW * 0.5 + 9, p.Y + 9.5); ctx.lineTo(p.X, p.Y + TH * 0.5 + 14); ctx.lineTo(p.X - TW * 0.5 - 9, p.Y + 9.5); ctx.closePath(); ctx.stroke();
      }
      // the ground, back to front
      for (s = 0; s <= 2 * (N - 1); s++) for (x = Math.max(0, s - N + 1); x <= Math.min(N - 1, s); x++) {
        y = s - x; i = y * N + x;
        if (!T.land[i]) continue;
        var L = lv[i]; p = proj(x, y, L);
        if (p.X < minX || p.X > maxX || p.Y < minY || p.Y > maxY) continue;
        var hw = TW / 2, hh = TH / 2;
        var front = y + 1 < N && T.land[(y + 1) * N + x] ? lv[(y + 1) * N + x] : -1;
        var side = x + 1 < N && T.land[y * N + x + 1] ? lv[y * N + x + 1] : -1;
        if (L > front) { var dl = (L - front) * HS * (front < 0 ? 0.75 : 1); poly([p.X - hw, p.Y, p.X, p.Y + hh, p.X, p.Y + hh + dl, p.X - hw, p.Y + dl], leftCol[i]); }
        if (L > side) { var dr = (L - side) * HS * (side < 0 ? 0.75 : 1); poly([p.X + hw, p.Y, p.X, p.Y + hh, p.X, p.Y + hh + dr, p.X + hw, p.Y + dr], rightCol[i]); }
        poly([p.X, p.Y - hh - 0.4, p.X + hw + 0.4, p.Y, p.X, p.Y + hh + 0.4, p.X - hw - 0.4, p.Y], topCol[i]);
      }
      // region names, lettered on the ground
      if (z > 0.34) HZ.REGIONS.forEach(function (r, k) {
        var cn = T.centroid[k], li = Math.round(cn.y) * N + Math.round(cn.x);
        groundText(r.name, proj(cn.x, cn.y, lv[li]), 0.2 + 0.3 * rev[li]);
      });
      // light pooling on the ground under everything you hold
      for (i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.kind !== 'unit' || it.u.status !== 'yours') continue;
        p = base(it.pos); if (p.X < minX || p.X > maxX || p.Y < minY || p.Y > maxY) continue;
        var cv = it.u.conviction || 3, bk = bornK(it.id, t);
        light(p.X, p.Y + 2, (30 + 9 * cv) * (it.u.type === 'story' ? 1.15 : 1), lightColor(it.u), (0.13 + 0.05 * cv) * bk, true);
      }
      // roads between ideas that connect, cracks between ideas that cannot both hold
      state.links.forEach(function (l) {
        var a = HZ.unitById(state, l.a), b = HZ.unitById(state, l.b);
        if (!a || !b || !a.pos || !b.pos) return;
        var pa = base(a.pos), pb = base(b.pos), dx = pb.X - pa.X, dy = pb.Y - pa.Y, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, k2;
        ctx.lineCap = 'round';
        if (l.kind === 'contradicts') {
          var pts = [[pa.X, pa.Y]], seg = Math.max(4, Math.round(len / 16));
          for (k2 = 1; k2 < seg; k2++) { var o = ((HZ.hash32(l.id + k2) % 100) / 100 - 0.5) * 11; pts.push([pa.X + dx * k2 / seg + nx * o, pa.Y + dy * k2 / seg + ny * o * 0.5]); }
          pts.push([pb.X, pb.Y]);
          var open = l.state === 'open';
          var trace = function () { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (var q = 1; q < pts.length; q++) ctx.lineTo(pts[q][0], pts[q][1]); ctx.stroke(); };
          if (l.state === 'settled') { ctx.strokeStyle = 'rgba(170,180,200,0.22)'; ctx.lineWidth = 1; trace(); return; }
          ctx.strokeStyle = hexA(EMBER, open ? 0.2 : 0.1); ctx.lineWidth = 7; trace();
          if (!open) ctx.setLineDash([5, 4]);
          ctx.strokeStyle = hexA(EMBER, open ? 0.95 : 0.6); ctx.lineWidth = 1.7; trace(); ctx.setLineDash([]);
        } else {
          ctx.setLineDash([1.5, 6]); ctx.strokeStyle = hexA(LAMP, 0.6); ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(pa.X, pa.Y); ctx.quadraticCurveTo((pa.X + pb.X) / 2 + nx * 9, (pa.Y + pb.Y) / 2 + ny * 5, pb.X, pb.Y); ctx.stroke(); ctx.setLineDash([]);
        }
      });
      // everything standing on the ground, back to front
      for (i = 0; i < items.length; i++) {
        it = items[i]; p = base(it.pos);
        if (p.X < minX || p.X > maxX || p.Y < minY || p.Y > maxY) continue;
        var top = 0, r = 15, label = '';
        // structures are drawn around their own base point, a little larger than life so they read on a phone
        ctx.save(); ctx.translate(p.X, p.Y); ctx.scale(SCALE, SCALE);
        if (it.kind === 'unit') {
          var u = it.u, ghost = u.status !== 'yours', k = bornK(u.id, t);
          if (k < 1 && !ghost) { ctx.strokeStyle = hexA(LAMP, 1 - k); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(0, 0, 8 + 34 * k, 4 + 17 * k, 0, 0, 6.3); ctx.stroke(); }
          if (u.type === 'value') top = drawValue(0, 0, u, ghost, k);
          else if (u.type === 'story') top = drawStory(0, 0, u, ghost, k, t);
          else if (u.type === 'question') top = drawQuestion(0, 0, u, ghost);
          else top = drawBelief(0, 0, u, ghost, k);
          if (it.bet) drawBetMark(0, top - 2, it.bet, t);
          if (tint && !ghost && z >= 0.6) { var dl2 = HZ.dominantLens(u); if (dl2) { ctx.font = '700 8px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ece7da'; ctx.fillText(HZ.LENS[HZ.LENS_IDS.indexOf(dl2)].short, 0, top - (it.bet ? 14 : 4)); ctx.textAlign = 'start'; } }
          label = u.label;
        } else if (it.kind === 'concept') { top = drawConcept(0, 0); label = it.c.name; }
        else if (it.kind === 'landing') { top = drawLanding(0, 0); label = 'The landing'; r = 9; }
        else if (it.kind === 'partner') { top = drawPartner(0, 0); label = it.p.label; }
        else { ctx.restore(); continue; } // doors are drawn after the mist
        ctx.restore();
        top = p.Y + top * SCALE;
        var sp = toScreen({ X: p.X, Y: (p.Y + top) / 2 });
        hits.push({ kind: it.kind, id: it.id, x: sp.x, y: sp.y, r: Math.max(16, r * z + (p.Y - top) * z * 0.5), top: toScreen({ X: p.X, Y: top }), label: label, s: it.s });
      }
      // mist over what you have not visited
      var drift = reduced ? 0 : t / 5200;
      for (y = 1; y < N; y += 2) for (x = 1 + (y % 4 === 1 ? 0 : 1); x < N; x += 2) {
        i = y * N + x; if (!T.land[i] || rev[i] > 0.55) continue;
        p = proj(x, y, lv[i]); if (p.X < minX - 60 || p.X > maxX + 60 || p.Y < minY - 60 || p.Y > maxY + 60) continue;
        ctx.globalAlpha = 0.13 * (1 - rev[i] / 0.55);
        var ox = Math.sin(drift + i * 0.7) * 7, rad = 54 + (HZ.hash32('m' + i) % 30);
        ctx.drawImage(glow(MIST), p.X - rad + ox, p.Y - rad * 0.62 - 6, rad * 2, rad * 1.24);
      }
      ctx.globalAlpha = 1;
      // doors glow through the mist
      for (i = 0; i < items.length; i++) {
        it = items[i]; if (it.kind !== 'door') continue;
        p = base(it.pos); if (p.X < minX || p.X > maxX || p.Y < minY || p.Y > maxY) continue;
        ctx.save(); ctx.translate(p.X, p.Y); ctx.scale(SCALE, SCALE); var dt = p.Y + drawDoor(0, 0, t) * SCALE; ctx.restore();
        var ds = toScreen({ X: p.X, Y: p.Y - 14 });
        hits.push({ kind: 'door', id: it.id, x: ds.x, y: ds.y, r: Math.max(18, 16 * z), top: toScreen({ X: p.X, Y: dt }), label: 'Door: ' + HZ.REGIONS[HZ.regionIndex(it.d.region)].name, s: it.s });
      }
      // selection ring
      if (selected) {
        var sel = find(selected.kind, selected.id);
        if (sel) { p = base(sel.pos); ctx.strokeStyle = LAMP; ctx.lineWidth = 2 / Math.max(0.6, z); ctx.beginPath(); ctx.ellipse(p.X, p.Y + 1, 22, 11, 0, 0, 6.3); ctx.stroke(); }
      }
      ctx.restore();
      var shown = {};
      [selected, hover].forEach(function (pick) {
        if (!pick || shown[pick.kind + pick.id]) return;
        for (var j = 0; j < hits.length; j++) if (hits[j].kind === pick.kind && hits[j].id === pick.id) { chip(hits[j].label, hits[j].top.x, hits[j].top.y); shown[pick.kind + pick.id] = 1; break; }
      });
    }
    function bornK(id, t) { var b = born[id]; if (!b) return 1; var k = (t - b) / 1400; if (k >= 1) { delete born[id]; return 1; } return k < 0 ? 0 : ease(k); }
    function find(kind, id) { for (var i = 0; i < items.length; i++) if (items[i].kind === kind && items[i].id === id) return items[i]; return null; }

    /* ---- loop: a slow ambient tick, a fast one while the camera or a new structure is moving ---- */
    var lastActive = 0;
    function touch() { lastActive = typeof performance !== 'undefined' ? performance.now() : 0; }
    /* The mist drifts and the doors pulse while someone is looking; after half a minute of stillness the map rests. */
    function ambient() { return !reduced && performance.now() - lastActive < 30000; }
    function schedule() {
      if (destroyed || raf || timer) return;
      var fast = !!flight || Object.keys(born).length > 0;
      if (fast || dirty) { raf = requestAnimationFrame(function (t) { raf = 0; step(t); }); }
      else if (ambient() && !document.hidden) { timer = setTimeout(function () { timer = null; raf = requestAnimationFrame(function (t) { raf = 0; step(t); }); }, 90); }
    }
    function step(t) {
      if (flight) {
        var k = Math.min(1, (t - flight.t0) / flight.ms), e = ease(k);
        cam.x = flight.from.x + (flight.to.x - flight.from.x) * e;
        cam.y = flight.from.y + (flight.to.y - flight.from.y) * e;
        cam.z = flight.from.z * Math.pow(flight.to.z / flight.from.z, e);
        if (k >= 1) { var done = flight.done; flight = null; done(); }
      }
      render(t); schedule();
    }
    function invalidate() { dirty = true; touch(); schedule(); }

    /* ---- camera ---- */
    function clampCam() {
      cam.z = HZ.clamp(cam.z, 0.26, 2.6);
      var lim = N * TW / 2;
      cam.x = HZ.clamp(cam.x, -lim, lim); cam.y = HZ.clamp(cam.y, -40, N * TH + 40);
    }
    function flyTo(to, ms) {
      if (flight) { var d0 = flight.done; flight = null; d0(); }
      to = { x: to.x, y: to.y, z: HZ.clamp(to.z || cam.z, 0.26, 2.6) };
      if (reduced || !ms) { cam.x = to.x; cam.y = to.y; cam.z = to.z; clampCam(); invalidate(); return Promise.resolve(); }
      return new Promise(function (res) {
        flight = { from: { x: cam.x, y: cam.y, z: cam.z }, to: to, ms: ms, t0: performance.now(), done: res };
        schedule();
      });
    }
    function focus(pos, z, ms) { var p = base(pos); return flyTo({ x: p.X, y: p.Y - 14, z: z || Math.max(cam.z, 1.15) }, ms === undefined ? 900 : ms); }
    function fitBox(minX, minY, maxX, maxY, ms, zMax) {
      var fw = Math.max(80, W - insets.left - insets.right), fh = Math.max(80, H - insets.top - insets.bottom);
      var z = Math.min(fw / (maxX - minX), fh / (maxY - minY));
      return flyTo({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: HZ.clamp(z, 0.26, zMax || 1.5) }, ms);
    }
    function fitAll(ms) { var R = 19 * TW / Math.SQRT2, c = proj(T.cx, T.cy, 0); return fitBox(c.X - R - 30, c.Y - R / 2 - 60, c.X + R + 30, c.Y + R / 2 + 40, ms, 1.2); }
    /* Frame what was placed most recently; with nothing placed yet, the landing. */
    function fitLit(ms) {
      var pts = [];
      state.units.slice(-8).forEach(function (u) { if (u.pos) pts.push(u.pos); });
      var open = state.doors.filter(function (d) { return d.pos && !d.answeredAt; }).pop();
      if (open) pts.push(open.pos);
      if (pts.length < 3) pts.push({ x: T.cx, y: T.cy });
      var a = 1e9, b = 1e9, c = -1e9, d2 = -1e9;
      pts.forEach(function (q) { var p = proj(q.x, q.y, 0); a = Math.min(a, p.X); b = Math.min(b, p.Y); c = Math.max(c, p.X); d2 = Math.max(d2, p.Y); });
      return fitBox(a - 130, b - 110, c + 130, d2 + 80, ms, 1.25);
    }
    function zoomAt(f, sx, sy) {
      var c = centre(); if (sx === undefined) { sx = c.x; sy = c.y; }
      var wx = (sx - c.x) / cam.z + cam.x, wy = (sy - c.y) / cam.z + cam.y;
      cam.z = HZ.clamp(cam.z * f, 0.26, 2.6);
      cam.x = wx - (sx - c.x) / cam.z; cam.y = wy - (sy - c.y) / cam.z;
      clampCam(); invalidate();
    }

    /* ---- input ---- */
    var ptrs = {}, drag = null, pinch = null;
    function local(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function pickAt(pt) {
      var best = null, bd = 1e9;
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i]; if (h.kind === 'landing' || h.kind === 'partner') continue;
        var d = Math.hypot(pt.x - h.x, pt.y - h.y);
        if (d <= h.r && d - h.s * 0.01 < bd) { bd = d - h.s * 0.01; best = h; }
      }
      return best;
    }
    function down(e) {
      if (flight) { var d0 = flight.done; flight = null; d0(); }
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      var pt = local(e); ptrs[e.pointerId] = pt;
      var ids = Object.keys(ptrs);
      if (ids.length === 1) drag = { x: pt.x, y: pt.y, cx: cam.x, cy: cam.y, moved: false };
      else if (ids.length === 2) { var a = ptrs[ids[0]], b = ptrs[ids[1]]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; if (drag) drag.moved = true; }
    }
    function move(e) {
      var pt = local(e);
      if (ptrs[e.pointerId]) {
        ptrs[e.pointerId] = pt;
        var ids = Object.keys(ptrs);
        if (ids.length >= 2 && pinch) {
          var a = ptrs[ids[0]], b = ptrs[ids[1]], d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
          zoomAt(d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2); pinch.d = d; return;
        }
        if (drag) {
          var dx = pt.x - drag.x, dy = pt.y - drag.y;
          if (!drag.moved && Math.hypot(dx, dy) > 5) drag.moved = true;
          if (drag.moved) { cam.x = drag.cx - dx / cam.z; cam.y = drag.cy - dy / cam.z; clampCam(); invalidate(); }
        }
        return;
      }
      if (e.pointerType === 'mouse') {
        if (!ambient()) { touch(); schedule(); }
        var h = pickAt(pt), nh = h ? { kind: h.kind, id: h.id } : null;
        if ((nh && (!hover || hover.kind !== nh.kind || hover.id !== nh.id)) || (!nh && hover)) { hover = nh; canvas.style.cursor = nh ? 'pointer' : 'grab'; invalidate(); }
      }
    }
    function up(e) {
      var had = ptrs[e.pointerId]; delete ptrs[e.pointerId];
      if (Object.keys(ptrs).length < 2) pinch = null;
      if (had && drag && !drag.moved && Object.keys(ptrs).length === 0) {
        var h = pickAt(local(e));
        if (opts.onPick) opts.onPick(h ? { kind: h.kind, id: h.id } : null);
      }
      if (Object.keys(ptrs).length === 0) drag = null;
    }
    function wheel(e) { e.preventDefault(); var pt = local(e); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), pt.x, pt.y); }
    function key(e) {
      var stepPx = 60 / cam.z;
      if (e.key === 'ArrowLeft') cam.x -= stepPx; else if (e.key === 'ArrowRight') cam.x += stepPx;
      else if (e.key === 'ArrowUp') cam.y -= stepPx; else if (e.key === 'ArrowDown') cam.y += stepPx;
      else if (e.key === '+' || e.key === '=') { zoomAt(1.25); return; } else if (e.key === '-') { zoomAt(0.8); return; }
      else return;
      e.preventDefault(); clampCam(); invalidate();
    }
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', function () { if (hover) { hover = null; invalidate(); } });
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('keydown', key);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) invalidate(); });

    function resize() {
      var r = canvas.getBoundingClientRect();
      W = Math.max(50, Math.round(r.width)); H = Math.max(50, Math.round(r.height));
      dpr = Math.min(2, root.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      invalidate();
    }
    rebuild(); resize();

    return {
      setState: function (s) { state = s; rebuild(); schedule(); },
      setInsets: function (i) { insets = { left: i.left || 0, right: i.right || 0, top: i.top || 0, bottom: i.bottom || 0 }; invalidate(); },
      resize: resize, render: render, invalidate: invalidate,
      flyTo: flyTo, focus: focus, fitAll: fitAll, fitLit: fitLit, zoomBy: function (f) { zoomAt(f); },
      select: function (kind, id) { selected = kind ? { kind: kind, id: id } : null; invalidate(); },
      setTint: function (v) { tint = !!v; invalidate(); },
      setPartner: function (list) { partner = list && list.length ? list : null; rebuild(); schedule(); },
      celebrate: function (ids) { var t = performance.now(); ids.forEach(function (id, i) { born[id] = t + i * 420; }); schedule(); },
      posOf: function (kind, id) { var it = find(kind, id); return it ? it.pos : null; },
      hits: function () { return hits.slice(); },
      camera: function () { return { x: cam.x, y: cam.y, z: cam.z }; },
      setReduced: function (v) { reduced = !!v; },
      destroy: function () { destroyed = true; if (timer) clearTimeout(timer); if (raf) cancelAnimationFrame(raf); }
    };
  }

  root.HZWorld = { create: create };
})(typeof self !== 'undefined' ? self : this);
