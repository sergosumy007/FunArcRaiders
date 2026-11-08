(function () {
  'use strict';

  var LANGS = ['ru', 'pl', 'en'];
  var KINDS = ['item', 'quest', 'arc', 'bp', 'key'];
  var BOUNDS = [[0, 0], [1000, 1000]];
  var PAGE = 70;
  var FAR = window.FAR;
  var CORE = FAR.core;

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };
  var fold = function (s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ё/g, 'е').replace(/ł/g, 'l');
  };

  // Scripts rather than fetch(): fetch is blocked on file://, script tags are not.
  var loaded = {};
  function need(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise(function (ok, no) {
        var s = document.createElement('script');
        s.src = src;
        s.onload = ok;
        s.onerror = function () { delete loaded[src]; no(new Error('load failed: ' + src)); };
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }

  var S = { lang: null, kind: null, id: null, map: null, floor: 'top', off: {} };
  var ENT = {
    item: CORE.items.filter(function (x) { return !x.bp; }),
    bp: CORE.items.filter(function (x) { return x.bp; }),
    quest: CORE.quests,
    arc: CORE.arcs,
    key: CORE.items.filter(function (x) { return x.d; }).map(function (x) { return { id: x.id, t: x.t, r: x.r, c: x.d }; })
  };
  var BY = {};
  CORE.items.forEach(function (x) { BY['item:' + x.id] = x; BY['bp:' + x.id] = x; });
  CORE.quests.forEach(function (x) { BY['quest:' + x.id] = x; });
  CORE.arcs.forEach(function (x) { BY['arc:' + x.id] = x; });
  ENT.key.forEach(function (x) { BY['key:' + x.id] = x; });

  var T = function () { return FAR.i18n[S.lang]; };
  var U = function (k) { return T().ui[k] || k; };
  var NAME = function (group, id) { return T().names[group][id] || String(id).split('/').pop(); };
  var group = function (kind) { return kind === 'bp' || kind === 'key' ? 'item' : kind; };
  var nameOf = function (kind, id) { return NAME(group(kind), id); };
  var DET = function (g) { return FAR.details[g] || {}; };
  var hasPts = function (l) { return l.pts.length; };
  var isOff = function (l) { return l.key in S.off ? !!S.off[l.key] : !!l.hide; };
  var icon = function (kind, id) { return kind === 'arc' ? 'img/arcs/' + id + '.webp' : 'img/items/' + id + '.webp'; };
  var LI = function () { return LANGS.indexOf(S.lang); };
  var hide = 'onerror="this.style.visibility=\'hidden\'"';

  /* ---------- map engine ---------- */

  // Point markers drawn on Leaflet's canvas; thousands stay smooth this way.
  L.Canvas.include({
    _updateGlyph: function (m) {
      if (!this._drawing || m._empty()) return;
      var p = m._point, c = this._ctx, r = Math.max(m._radius, 1), g = m.options.glyph;
      c.beginPath();
      if (g === 'diamond') {
        c.moveTo(p.x, p.y - r - 1.5); c.lineTo(p.x + r + 1.5, p.y); c.lineTo(p.x, p.y + r + 1.5); c.lineTo(p.x - r - 1.5, p.y); c.closePath();
      } else if (g === 'tri') {
        c.moveTo(p.x, p.y - r - 1); c.lineTo(p.x + r + 1, p.y + r * 0.8); c.lineTo(p.x - r - 1, p.y + r * 0.8); c.closePath();
      } else {
        c.arc(p.x, p.y, r, 0, Math.PI * 2, false);
      }
      this._fillStroke(c, m);
      if (m.options.label) {
        c.fillStyle = '#15130e';
        c.font = '800 13px "Sofia Sans Extra Condensed", sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(m.options.label, p.x, p.y + 0.5);
      }
    }
  });
  var Glyph = L.CircleMarker.extend({ _updatePath: function () { this._renderer._updateGlyph(this); } });

  // Source coordinates run bottom-up (lat 1000 is the top edge of the image), tile rows top-down.
  var CRS = L.extend({}, L.CRS.Simple, { transformation: new L.Transformation(1, 0, -1, 1000) });
  var map = L.map('map', {
    crs: CRS, zoomControl: false, attributionControl: false, preferCanvas: true,
    minZoom: -5, maxZoom: 5, zoomSnap: 0, zoomDelta: 0.5, wheelPxPerZoomLevel: 110,
    maxBoundsViscosity: 1, renderer: L.canvas({ padding: 0.3, tolerance: 4 })
  });
  var tiles = null;
  var overlay = L.featureGroup().addTo(map);
  var labels = L.layerGroup().addTo(map);
  var popup = L.popup({ closeButton: false, autoPanPadding: [30, 30], offset: [0, -3], className: 'pop', maxWidth: 260 });
  var layerSet = [];
  var labelLayers = [];

  // getBoundsZoom clamps to minZoom, so the floor has to be lifted before measuring.
  function floorZoom(box) {
    map.options.minZoom = -5;
    map.options.minZoom = map.getBoundsZoom(box, false);
  }

  // The whole map in view, held inside the image so zooming can never land on empty black.
  var autoFit = true, fitting = false;
  function fit() {
    var box = L.latLngBounds(BOUNDS);
    var size = map.invalidateSize({ pan: false }).getSize();
    if (!size.x || !size.y) return;
    fitting = true;
    floorZoom(box);
    map.setMaxBounds(box);
    map.fitBounds(box, { animate: false });
    fitting = false;
    autoFit = true;
  }

  // Until the reader moves the map it keeps filling the panel at any window size.
  function boxChanged() {
    if (!S.map || !tiles) { map.invalidateSize(); return; }
    if (autoFit) { fit(); return; }
    map.invalidateSize();
    floorZoom(L.latLngBounds(BOUNDS));
    if (map.getZoom() < map.getMinZoom()) map.setZoom(map.getMinZoom(), { animate: false });
  }
  map.on('zoomstart dragstart', function () { if (!fitting) autoFit = false; });

  function mapInfo(id) { return CORE.maps.filter(function (m) { return m.id === id; })[0]; }

  function setTiles() {
    var info = mapInfo(S.map);
    var dir = info.floors ? S.map + '-' + S.floor : S.map;
    $('#backdrop').style.backgroundImage = 'url(img/maps/' + S.map + '.webp)';
    if (tiles) map.removeLayer(tiles);
    tiles = L.tileLayer('tiles/' + dir + '/{z}/{x}/{y}.webp', {
      tileSize: 512, minNativeZoom: 0, maxNativeZoom: info.native, noWrap: true,
      bounds: BOUNDS, keepBuffer: 3, updateWhenZooming: false, minZoom: -5, maxZoom: 5
    }).addTo(map);
  }

  function pointTitle(m) {
    var o = m.options.meta, l = layerSet[o.l], out = '<h4>' + esc(o.title || l.label) + '</h4>';
    if (o.sub) out += '<p>' + esc(o.sub) + '</p>';
    if (l.note) out += '<p>' + esc(l.note) + '</p>';
    if (o.low) out += '<p>' + esc(U('lower')) + '</p>';
    if (l.conf) out += '<span class="stamp ' + l.conf + '">' + esc(U('conf_' + l.conf)) + '</span>';
    return out;
  }

  overlay.on('click', function (e) {
    var m = e.sourceTarget || e.layer;
    if (!m.options.meta) return;
    popup.setLatLng(m.getLatLng()).setContent(pointTitle(m)).openOn(map);
  });
  overlay.on('mouseover', function (e) { var m = e.sourceTarget || e.layer; if (m.setRadius && m.options.meta) m.setRadius(m.options.radius + 2.5); });
  overlay.on('mouseout', function (e) { var m = e.sourceTarget || e.layer; if (m.setRadius && m.options.meta) m.setRadius(m.options.r0); });

  function drawLayers() {
    overlay.clearLayers();
    popup.remove();
    var mode = S.kind === 'quest' ? 'route' : null;
    layerSet.forEach(function (l, li) {
      if (isOff(l)) return;
      if (l.ring) L.circle(l.ring.c, { radius: l.ring.r, color: l.color, weight: 2, dashArray: '6 6', fillColor: l.color, fillOpacity: .12, interactive: false }).addTo(overlay);
      if (l.lines) l.lines.forEach(function (pts) {
        L.polyline(pts, { color: '#2fa594', weight: 3, dashArray: '2 7', lineCap: 'round', interactive: false }).addTo(overlay);
      });
      for (var i = 0; i < l.pts.length; i++) {
        var p = l.pts[i], r = l.r;
        var g = new Glyph([p.y, p.x], {
          radius: r, r0: r, color: l.stroke || '#15130e', weight: 1.4, fillColor: l.color, fillOpacity: 1,
          glyph: l.glyph, label: p.n || null, bubblingMouseEvents: false,
          meta: { l: li, title: p.t, sub: p.s, low: p.f === 1, step: p.n }
        });
        overlay.addLayer(g);
      }
    });
    layerSet.forEach(function (l, li) {
      if (!l.ring || isOff(l)) return;
      overlay.addLayer(new Glyph(l.ring.c, { radius: 10, r0: 10, color: '#15130e', weight: 1.4, fillColor: l.color, fillOpacity: 1, glyph: 'dot', label: l.ring.n, bubblingMouseEvents: false, meta: { l: li } }));
    });
    return mode;
  }

  /* ---------- layers for the current selection ---------- */

  var PALETTE = ['#e2a21a', '#7fc6e6', '#eb7a4f', '#a6d36b', '#d58fe0', '#f2d675', '#5fd0bd', '#f2a7a0', '#b7b2a6', '#9fb4ff'];

  function arcPoints(md, arcId, wantFloor) {
    var raw = md.A[arcId] || [], out = [];
    for (var i = 0; i < raw.length; i += 4) {
      var f = raw[i + 2], flags = raw[i + 3];
      if (wantFloor !== null && f !== wantFloor) continue;
      var mv = ['static', 'patrol', 'slots', 'patrol'][(flags >> 1) & 3];
      var sub = U(mv);
      if (flags & 1) sub = U('escort') + ', ' + sub;
      out.push({ x: raw[i], y: raw[i + 1], f: f, s: sub });
    }
    return out;
  }

  function flatPoints(raw, wantFloor) {
    var out = [];
    if (!raw) return out;
    for (var i = 0; i < raw.length; i += 3) {
      if (wantFloor !== null && raw[i + 2] !== wantFloor) continue;
      out.push({ x: raw[i], y: raw[i + 1], f: raw[i + 2] });
    }
    return out;
  }

  var TREES = { lemon: 1, apricot: 1, olives: 1 };
  var HOT_R = 16, HOT_MAX = 3, HOT_MIN = 4, HOT_COLORS = ['#e2a21a', '#7fc6e6', '#a6d36b'];

  function hotSpots(all) {
    var left = all.slice(), out = [];
    var near = function (a, b, d) { return a.f === b.f && (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) <= d * d; };
    while (out.length < HOT_MAX && left.length >= HOT_MIN) {
      var best = null, bestN = 0;
      left.forEach(function (p) {
        var n = 0;
        for (var i = 0; i < left.length; i++) if (near(p, left[i], HOT_R)) n++;
        if (n > bestN) { bestN = n; best = p; }
      });
      if (bestN < HOT_MIN) break;
      var group = left.filter(function (q) { return near(best, q, HOT_R); });
      var cx = group.reduce(function (s, q) { return s + q.x; }, 0) / group.length;
      var cy = group.reduce(function (s, q) { return s + q.y; }, 0) / group.length;
      var mid = { x: cx, y: cy, f: best.f };
      out.push({ x: cx, y: cy, pts: group });
      left = left.filter(function (q) { return !near(mid, q, HOT_R * 2); });
    }
    return out;
  }

  function itemLayers(md, D, id, wf) {
    var ls = [], i = 0;
    if (md.K[id]) ls.push({ key: 'k', label: U('conf_exact'), glyph: 'diamond', color: '#ffffff', r: 6, conf: 'exact', pts: flatPoints(md.K[id], wf) });
    if (md.N[id]) ls.push({ key: 'n', label: nameOf('item', id), glyph: 'tri', color: '#8fd16b', r: 4.5, conf: 'fixed', note: TREES[id] ? U('tree_note') : '', pts: flatPoints(md.N[id], wf) });
    (D.fix || []).forEach(function (q) {
      var text = ((T().text.quest || {})[q.q] || {}).o || [];
      var pts = (md.Q[q.q] || []).filter(function (p) { return (wf === null || p[4] === wf) && (!q.s || q.s.indexOf(p[2]) >= 0); }).map(function (p) {
        return { x: p[0], y: p[1], f: p[4], o: p[2], t: NAME('quest', q.q), s: p[2] === null || p[2] === undefined ? '' : (text[p[2]] || '') };
      });
      var oneStep = pts.length > 1 && pts.every(function (p) { return p.o === pts[0].o; });
      if (pts.length) ls.push({ key: 'q:' + q.q, label: NAME('quest', q.q), glyph: 'diamond', color: '#2fa594', stroke: '#fff', r: 8, conf: 'quest', note: oneStep ? U('any_of_n').replace('{n}', pts.length) : '', pts: pts });
    });
    (D.cont || []).forEach(function (c) {
      var raw = md.C[c.s];
      if (!raw) return;
      var note = (c.ev || []).map(function (ev) { return NAME('cond', ev); }).join(', ');
      ls.push({ key: 'c:' + c.s, label: NAME('cont', c.s), glyph: 'dot', color: PALETTE[i++ % PALETTE.length], r: 3.6, conf: 'cont', note: note ? U('only') + ': ' + note : '', pts: flatPoints(raw, wf) });
    });
    (D.drop || []).forEach(function (a) {
      if (md.A[a]) ls.push({ key: 'a:' + a, label: NAME('arc', a), glyph: 'tri', color: '#d9512c', stroke: '#fff4', r: 5, conf: 'drop', pts: arcPoints(md, a, wf) });
    });
    var conts = ls.filter(function (l) { return l.conf === 'cont'; });
    if (ls.some(function (l) { return l.conf === 'quest' || l.conf === 'fixed' || l.conf === 'exact'; })) {
      conts.forEach(function (l) { l.hide = true; });
    } else {
      var pool = [];
      (D.cont || []).forEach(function (c) { if (!(c.ev && c.ev.length) && md.C[c.s]) pool = pool.concat(flatPoints(md.C[c.s], wf)); });
      var hot = hotSpots(pool);
      if (hot.length) {
        conts.forEach(function (l) { l.hide = true; });
        ls = hot.map(function (h, k) {
          return { key: 'h:' + k, label: U('hot_n').replace('{n}', k + 1), glyph: 'dot', color: HOT_COLORS[k], stroke: '#fff', r: 5, conf: 'hot', note: U('hot_note').replace('{n}', h.pts.length), pts: h.pts, ring: { c: [h.y, h.x], r: HOT_R * 1.2, n: String(k + 1) } };
        }).concat(ls);
      }
    }
    (D.best || []).forEach(function (b, n) {
      if (b.m === S.map && md.B[b.a]) ls.push({ key: 'b:' + b.a, label: NAME('area', S.map + '/' + b.a), glyph: 'diamond', color: '#e2a21a', stroke: '#fff', r: 7, conf: 'cont', note: U('best'), pts: [{ x: md.B[b.a][0], y: md.B[b.a][1], f: 0 }] });
    });
    return ls;
  }

  function questLayers(md, id, wf) {
    var raw = md.Q[id] || [], groups = {}, order = [], free = [];
    raw.forEach(function (p) {
      if (wf !== null && p[4] !== wf) return;
      var pt = { x: p[0], y: p[1], f: p[4] };
      if (p[2] === null || p[2] === undefined) { free.push(pt); return; }
      if (!groups[p[2]]) { groups[p[2]] = []; order.push(p[2]); }
      groups[p[2]].push(pt);
    });
    order.sort(function (a, b) { return a - b; });
    var ls = [], line = [], stepNames = (T().text.quest[id] || {}).o || [];
    order.forEach(function (st) {
      var g = groups[st], label = String(st + 1);
      g.forEach(function (p) { p.n = label; p.t = U('step') + ' ' + label; p.s = stepNames[st] || ''; if (g.length > 1) p.s += ' (' + U('any_of') + ')'; });
      if (g.length <= 4) line.push(g);
      ls.push({ key: 's:' + st, label: U('step') + ' ' + label, glyph: 'dot', color: '#2fa594', stroke: '#eadfc6', r: 9.5, pts: g });
    });
    var chain = [], prev = null;
    line.forEach(function (g) {
      var best = g[0], bd = 1e12;
      if (prev) g.forEach(function (p) { var d = Math.pow(p.x - prev.x, 2) + Math.pow(p.y - prev.y, 2); if (d < bd) { bd = d; best = p; } });
      chain.push([best.y, best.x]);
      prev = best;
    });
    if (ls.length && chain.length > 1) ls[0].lines = [chain];
    if (free.length) ls.push({ key: 'free', label: U('order_unknown'), glyph: 'dot', color: '#7fc6e6', stroke: '#eadfc6', r: 6, conf: null, pts: free });
    return ls;
  }

  function arcLayers(md, id, wf) {
    var pts = arcPoints(md, id, wf);
    return pts.length ? [{ key: 'a', label: nameOf('arc', id), glyph: 'tri', color: '#d9512c', stroke: '#eadfc6', r: 6.5, pts: pts }] : [];
  }

  function keyLayers(md, id, wf) {
    var pts = flatPoints(md.K[id], wf);
    return pts.length ? [{ key: 'd', label: U('door'), glyph: 'diamond', color: '#b98ae0', stroke: '#ffffff', r: 8, conf: 'exact', pts: pts }] : [];
  }

  function buildLayers(md) {
    var info = mapInfo(S.map), wf = info.floors ? (S.floor === 'top' ? 0 : 1) : null, id = S.id;
    if (S.kind === 'quest') return questLayers(md, id, wf);
    if (S.kind === 'arc') return arcLayers(md, id, wf);
    if (S.kind === 'key') return keyLayers(md, id, wf);
    return itemLayers(md, DET('items')[id] || {}, id, wf);
  }

  /* ---------- painting ---------- */

  function paintLegend() {
    var box = $('#legend');
    var shown = layerSet.filter(function (l) { return l.pts.length; });
    if (shown.length < 2 || S.kind === 'quest') { box.hidden = true; box.innerHTML = ''; return; }
    var rest = shown.filter(function (l) { return l.hide; }), restOn = rest.some(function (l) { return !isOff(l); });
    var rows = shown.filter(function (l) { return !l.hide; });
    if (rest.length) rows = rows.concat([{ key: '__conts', label: U('all_conts'), glyph: 'dot', color: '#b7b2a6', hide: !restOn, pts: { length: rest.reduce(function (s, l) { return s + l.pts.length; }, 0) } }], restOn ? rest : []);
    box.hidden = false;
    box.innerHTML = '<h3><span>' + esc(U('legend')) + '</span><button type="button" data-all="1">' + esc(U(shown.some(function (l) { return !isOff(l); }) ? 'layer_none' : 'layer_all')) + '</button></h3>' +
      rows.map(function (l) {
        var shape = l.glyph === 'diamond' ? 'square' : l.glyph === 'tri' ? 'tri' : '';
        return '<label><input type="checkbox" data-key="' + esc(l.key) + '"' + (isOff(l) ? '' : ' checked') + '><i class="swatch ' + shape + '" style="background:' + l.color + '"></i><span>' + esc(l.label) + '</span><small>' + l.pts.length + '</small></label>';
      }).join('');
  }

  function paintGear() {
    var box = $('#gear');
    if (S.kind !== 'quest' || !S.map || !lit(S.map)) { box.hidden = true; return; }
    var D = DET('quests')[S.id] || {};
    var chip = function (r) { return '<button type="button" class="chip" data-go="item:' + esc(r.i) + '"><img src="' + icon('item', r.i) + '" alt="" ' + hide + '>' + esc(NAME('item', r.i)) + (r.q > 1 ? ' <b>×' + r.q + '</b>' : '') + '</button>'; };
    var bring = (D.req || []).filter(function (r) { return !r.qi; }).concat(D.tools || []);
    var found = (D.req || []).filter(function (r) { return r.qi; });
    var html = '<div class="group"><h3>' + esc(U('bring')) + '</h3>' + (bring.length ? bring.map(chip).join('') : '<span>' + esc(U('no_gear')) + '</span>') + '</div>';
    if (found.length) html += '<div class="group"><h3>' + esc(U('found_in_quest')) + '</h3>' + found.map(chip).join('') + '</div>';
    box.innerHTML = html;
    box.hidden = false;
  }

  function lit(mapId) {
    var e = S.kind && BY[S.kind + ':' + S.id];
    return !!(e && e.c && e.c[mapId]);
  }

  function paintCards() {
    var n = 0;
    $('#cards').innerHTML = CORE.maps.map(function (m) {
      var on = lit(m.id), e = S.kind && BY[S.kind + ':' + S.id], cnt = on ? e.c[m.id] : 0;
      return '<li><button type="button" class="card' + (on ? ' lit' : '') + (S.map === m.id ? ' open' : '') + '" data-map="' + m.id + '" style="--i:' + (on ? n++ : 0) + '" aria-pressed="' + (S.map === m.id) + '">' +
        '<img src="img/maps/' + m.id + '.webp" alt=""><span><span class="nm">' + esc(NAME('map', m.id)) + '</span>' +
        (cnt > 0 ? '<span class="cnt">' + cnt + '</span>' : '') + '</span><i class="bulb"></i></button></li>';
    }).join('');
  }

  function paintStatus() {
    var box = $('#status');
    if (S.kind && !anyLit()) { box.textContent = U('no_map'); box.hidden = false; return; }
    if (S.kind && (!S.map || !lit(S.map))) { box.textContent = U('pick_map'); box.hidden = false; return; }
    if (S.kind && FAR.mapdata[S.map] && !layerSet.some(hasPts)) {
      box.textContent = U(mapInfo(S.map).floors && otherFloorHas() ? 'no_points_floor' : S.kind === 'key' ? 'door_no_point' : 'no_points');
      box.hidden = false;
      return;
    }
    var itemish = S.kind && S.kind !== 'quest' && S.kind !== 'arc' && S.kind !== 'key' && FAR.mapdata[S.map], sel = layerSet.filter(hasPts);
    if (itemish && sel.some(function (l) { return l.conf === 'hot'; })) { box.textContent = U('status_random'); box.hidden = false; return; }
    if (itemish && sel.some(function (l) { return l.conf === 'quest' || l.conf === 'fixed'; })) { box.textContent = U('status_fixed'); box.hidden = false; return; }
    box.hidden = true;
  }
  function otherFloorHas() {
    var f = S.floor;
    S.floor = f === 'top' ? 'bottom' : 'top';
    var yes = buildLayers(FAR.mapdata[S.map]).some(hasPts);
    S.floor = f;
    return yes;
  }
  function anyLit() {
    var e = S.kind && BY[S.kind + ':' + S.id];
    return !!(e && e.c && Object.keys(e.c).length);
  }

  function paintCtrl() {
    var info = S.map && mapInfo(S.map), html = '';
    if (info && info.floors) {
      html += info.floors.map(function (f) {
        return '<button type="button" data-floor="' + f + '" aria-pressed="' + (S.floor === f) + '" title="' + esc(U('floor_' + f)) + '">' + (f === 'top' ? '▲' : '▼') + '</button>';
      }).join('');
    }
    html += '<button type="button" data-zoom="1" aria-label="+">+</button><button type="button" data-zoom="-1" aria-label="-">−</button><button type="button" data-reset="1" title="' + esc(U('reset')) + '">⌖</button>';
    $('#ctrl').innerHTML = html;
  }

  function paintLabels() {
    labels.clearLayers();
    labelLayers = [];
    var md = S.map && FAR.mapdata[S.map];
    if (!md) return;
    var names = (T().labels || {})[S.map] || [];
    md.L.forEach(function (l, i) {
      if (!names[i]) return;
      var m = L.marker([l[1], l[0]], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: null, html: '<div class="lab lab-' + l[2] + '">' + esc(names[i]) + '</div>' }) });
      m.isRegion = l[2] === 'r';
      labelLayers.push(m);
    });
    syncLabels();
  }
  function syncLabels() {
    var z = map.getZoom();
    labelLayers.forEach(function (m) {
      var show = m.isRegion ? z >= -1 : z >= 1;
      if (show && !labels.hasLayer(m)) labels.addLayer(m);
      if (!show && labels.hasLayer(m)) labels.removeLayer(m);
    });
  }
  map.on('zoomend', syncLabels);

  function sweep() {
    var s = $('#sweep');
    s.classList.remove('go');
    void s.offsetWidth;
    s.classList.add('go');
  }

  // A request for new tiles survives a newer repaint that overtakes it while the data loads.
  var token = 0, baseDue = false;
  function paintMap(newBase, seekFloor) {
    var mine = ++token;
    baseDue = baseDue || !!newBase;
    if (!S.map) { paintStatus(); return Promise.resolve(); }
    return need('data/map.' + S.map + '.js').then(function () {
      if (mine !== token) return;
      var md = FAR.mapdata[S.map];
      if (seekFloor && S.kind === 'key' && lit(S.map) && mapInfo(S.map).floors) {
        var here = flatPoints(md.K[S.id], S.floor === 'top' ? 0 : 1).length;
        if (!here && flatPoints(md.K[S.id], null).length) { S.floor = S.floor === 'top' ? 'bottom' : 'top'; baseDue = true; }
      }
      if (baseDue) { baseDue = false; setTiles(); paintLabels(); sweep(); }
      layerSet = (S.kind && lit(S.map)) ? buildLayers(md) : [];
      drawLayers();
      paintLegend();
      paintGear();
      paintStatus();
      paintCtrl();
    });
  }

  function openMap(id) {
    var changed = S.map !== id;
    S.map = id;
    S.floor = 'top';
    if (changed) { S.off = {}; }
    $('#hello').hidden = true;
    paintCards();
    writeHash();
    setPane('map');
    return paintMap(true, true).then(function () { if (changed) fit(); });
  }

  /* ---------- dossier ---------- */

  function chipItem(id, q) {
    var kind = (BY['item:' + id] || {}).bp ? 'bp' : 'item';
    return '<button type="button" class="chip" data-go="' + kind + ':' + esc(id) + '"><img src="' + icon('item', id) + '" alt="" ' + hide + '>' + esc(NAME('item', id)) + (q > 1 ? ' <b>×' + q + '</b>' : '') + '</button>';
  }
  function chipQuest(id) { return '<button type="button" class="chip" data-go="quest:' + esc(id) + '">' + esc(NAME('quest', id)) + '</button>'; }
  function chipArc(id) { return '<button type="button" class="chip" data-go="arc:' + esc(id) + '"><img src="' + icon('arc', id) + '" alt="" ' + hide + '>' + esc(NAME('arc', id)) + '</button>'; }
  function dc(title, body) { return body ? '<section class="dc"><h3>' + esc(title) + '</h3>' + body + '</section>' : ''; }
  function chips(list) { return list && list.length ? '<div class="chips">' + list.join('') + '</div>' : ''; }

  function head(src, title, meta, rarity) {
    var style = rarity ? ' style="--rar:var(--' + rarity.toLowerCase() + ')"' : '';
    return '<header' + style + '>' + (src ? '<img src="' + src + '" alt="" ' + hide + '>' : '<span></span>') + '<div><h2>' + esc(title) + '</h2><div class="meta">' + meta + '</div></div></header>';
  }
  function typeMeta(e) {
    var parts = [];
    if (e.t && T().types[e.t]) parts.push(T().types[e.t]);
    if (e.r && T().rarity[e.r]) parts.push(T().rarity[e.r]);
    return esc(parts.join(' · '));
  }

  function whereHTML(D) {
    var out = '';
    if (D.best && D.best.length) {
      out += dc(U('best'), '<ul class="rows">' + D.best.map(function (b) {
        var zones = (b.z || []).map(function (z) { return T().zones[z] || z; }).join(', ');
        return '<li><button type="button" class="linky" data-area="' + esc(b.m + '|' + b.a) + '">' + esc(NAME('area', b.m + '/' + b.a)) + '</button><em>' + esc(NAME('map', b.m)) + (zones ? ' · ' + esc(zones) : '') + '</em></li>';
      }).join('') + '</ul>');
    }
    if (D.fix && D.fix.length) out += dc(U('fix_where'), '<span class="stamp quest">' + esc(U('conf_quest')) + '</span>' + chips(D.fix.map(function (q) { return chipQuest(q.q); })));
    if (D.cont && D.cont.length) {
      out += dc(U('cont'), '<ul class="rows">' + D.cont.map(function (c) {
        var ev = (c.ev || []).map(function (x) { return NAME('cond', x); }).join(', ');
        return '<li>' + esc(NAME('cont', c.s)) + (ev ? '<em>' + esc(U('only')) + ': ' + esc(ev) + '</em>' : '') + '</li>';
      }).join('') + '</ul>');
    }
    out += dc(U('drop'), chips((D.drop || []).map(chipArc)));
    out += dc(U('reward'), chips((D.rew || []).map(chipQuest)));
    if (D.vend && D.vend.length) out += dc(U('trader'), '<ul class="rows">' + D.vend.map(function (v) { return '<li>' + esc(v) + '</li>'; }).join('') + '</ul>');
    if (D.trials) out += dc(U('trials'), '<p style="margin:0">✓</p>');
    return out;
  }

  function dossierItem(e, D) {
    var html = head(icon('item', e.id), NAME('item', e.id), typeMeta(e), e.r);
    var desc = (T().text.item || {})[e.id];
    if (desc) html += '<p>' + esc(desc) + '</p>';
    if (e.bp) {
      if (D.unlocks) html += dc(U('unlocks'), chips([chipItem(D.unlocks, 1)]));
      if (D.hints && D.hints.length) {
        var hints = (T().hints || {})[e.id] || [];
        html += dc(U('hints'), '<span class="stamp hint">' + esc(U('conf_hint')) + '</span><ul class="rows" style="margin-top:6px">' + hints.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul>');
      }
    }
    var where = whereHTML(D);
    html += where || '';
    if (!where && !anyLit()) html += dc(U('where'), '<p style="margin:0">' + esc(U('no_map')) + '</p>');
    if (D.craft) html += dc(U('craft'), chips(Object.keys(D.craft).map(function (k) { return chipItem(k, D.craft[k]); })));
    return html;
  }

  function dossierQuest(e, D) {
    var tx = (T().text.quest || {})[e.id] || {};
    var meta = D.trader ? esc(U('giver')) + ': ' + esc(D.trader) : '';
    var html = head(null, NAME('quest', e.id), meta);
    if (tx.d) html += '<p>' + esc(tx.d) + '</p>';
    if (tx.o && tx.o.length) {
      html += dc(U('steps'), '<ol class="steps">' + tx.o.map(function (o, i) { return '<li data-step="' + i + '">' + esc(o) + '</li>'; }).join('') + '</ol>');
    }
    if (D.video && /^https:\/\//.test(D.video)) html += '<p><a class="linky" href="' + esc(D.video) + '" target="_blank" rel="noopener">' + esc(U('video')) + '</a></p>';
    html += dc(U('rewards'), chips((D.rew || []).map(function (r) { return chipItem(r.i, r.q); })));
    html += dc(U('prev'), chips((D.prev || []).map(chipQuest)));
    html += dc(U('next'), chips((D.next || []).map(chipQuest)));
    return html;
  }

  function dossierArc(e, D) {
    var tx = (T().text.arc || {})[e.id] || {};
    var html = head(icon('arc', e.id), NAME('arc', e.id), '<span class="stamp th-' + esc(e.th) + '">' + esc(U('threat')) + ': ' + esc(T().threats[e.th] || e.th) + '</span>');
    if (tx.about) html += '<p>' + esc(tx.about) + '</p>';
    if (tx.weak) html += dc(U('weak'), '<p style="margin:0">' + esc(tx.weak) + '</p>');
    if (tx.tactic) html += dc(U('tactic'), '<ol class="tacs">' + tx.tactic.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ol>');
    if (D.weapons && D.weapons.length) html += dc(U('weapons'), chips(D.weapons.map(function (w) { return chipItem(w, 1); })));
    if (D.gear && D.gear.length) html += dc(U('gadgets'), chips(D.gear.map(function (w) { return chipItem(w, 1); })));
    if (D.loot && D.loot.length) html += dc(U('loot'), chips(D.loot.map(function (w) { return chipItem(w, 1); })));
    return html;
  }

  function dossierKey(e, D) {
    var html = head(icon('item', e.id), NAME('item', e.id), typeMeta(e), e.r);
    var desc = (T().text.item || {})[e.id];
    if (desc) html += '<p>' + esc(desc) + '</p>';
    var maps = Object.keys(e.c || {});
    html += dc(U('door_where'), maps.length ? '<ul class="rows">' + maps.map(function (m) {
      return '<li><button type="button" class="linky" data-map="' + esc(m) + '">' + esc(NAME('map', m)) + '</button>' + (e.c[m] < 0 ? '<em>' + esc(U('door_no_point')) + '</em>' : '') + '</li>';
    }).join('') + '</ul>' : '<p style="margin:0">' + esc(U('no_door')) + '</p>');
    return html + whereHTML(D);
  }

  function paintDossier() {
    var box = $('#dossier');
    if (!S.kind) { box.innerHTML = ''; return; }
    var e = BY[S.kind + ':' + S.id], html, D;
    if (S.kind === 'quest') { D = DET('quests')[e.id] || {}; html = dossierQuest(e, D); }
    else if (S.kind === 'arc') { D = DET('arcs')[e.id] || {}; html = dossierArc(e, D); }
    else if (S.kind === 'key') { D = DET('items')[e.id] || {}; html = dossierKey(e, D); }
    else { D = DET('items')[e.id] || {}; html = dossierItem(e, D); }
    box.innerHTML = '<article class="sheet">' + html + '</article>';
    box.scrollTop = 0;
  }

  /* ---------- selectors ---------- */

  var INDEX = {};
  function buildIndex() {
    KINDS.forEach(function (k) {
      var coll = window.Intl && Intl.Collator ? new Intl.Collator(S.lang) : null;
      INDEX[k] = ENT[k].map(function (e) {
        var n = nameOf(k, e.id);
        return { e: e, n: n, hay: fold(n + ' ' + ((T().en || {})[group(k) + ':' + e.id] || '')), m: e.c && Object.keys(e.c).length ? 0 : 1 };
      }).sort(function (a, b) { return a.m - b.m || (coll ? coll.compare(a.n, b.n) : a.n.localeCompare(b.n)); });
    });
  }

  function subOf(k, e) {
    if (k === 'quest') return e.tr || '';
    if (k === 'arc') return T().threats[e.th] || '';
    if (k === 'key') return Object.keys(e.c || {}).map(function (m) { return NAME('map', m); }).join(', ');
    return T().types[e.t] || '';
  }
  function rowHTML(k, r) {
    var e = r.e, img = k === 'quest' ? '<span></span>' : '<img loading="lazy" src="' + icon(k, e.id) + '" alt="" ' + hide + '>';
    var rar = e.r ? ' style="--rar:var(--' + e.r.toLowerCase() + ')"' : '';
    return '<li role="option" data-id="' + esc(e.id) + '"' + rar + '>' + img + '<span class="nm">' + esc(r.n) + '<small>' + esc(subOf(k, e)) + '</small></span><i class="lamp' + (r.m ? '' : ' lit') + '"></i></li>';
  }

  var openList = null;
  function closeList() {
    if (openList) { openList.el.remove(); $('input', openList.root).setAttribute('aria-expanded', 'false'); openList = null; }
  }
  function moreRows() {
    var o = openList;
    if (!o) return;
    var next = o.rows.slice(o.done, o.done + PAGE);
    o.el.insertAdjacentHTML('beforeend', next.map(function (r) { return rowHTML(o.kind, r); }).join(''));
    o.done += next.length;
  }
  function showList(root, kind, query) {
    closeList();
    var q = fold(query.trim());
    var rows = q ? INDEX[kind].filter(function (r) { return r.hay.indexOf(q) >= 0; }) : INDEX[kind];
    var el = document.createElement('ul');
    el.className = 'list';
    el.id = 'list-' + kind;
    el.setAttribute('role', 'listbox');
    $('.field', root).appendChild(el);
    openList = { el: el, root: root, kind: kind, rows: rows, done: 0, active: -1 };
    if (!rows.length) el.innerHTML = '<li class="note">' + esc(U('nothing')) + '</li>';
    moreRows();
    el.style.maxHeight = Math.max(170, Math.min(440, window.innerHeight - el.getBoundingClientRect().top - 12)) + 'px';
    el.addEventListener('scroll', function () { if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) moreRows(); });
    $('input', root).setAttribute('aria-expanded', 'true');
  }
  function moveActive(d) {
    var o = openList;
    if (!o) return;
    var items = $$('li[data-id]', o.el);
    if (!items.length) return;
    if (o.active >= 0 && items[o.active]) items[o.active].removeAttribute('aria-selected');
    o.active = Math.max(0, Math.min(items.length - 1, o.active + d));
    items[o.active].setAttribute('aria-selected', 'true');
    items[o.active].scrollIntoView({ block: 'nearest' });
    if (o.active > items.length - 5) moreRows();
  }

  function buildSelectors() {
    $('#selectors').innerHTML = KINDS.map(function (k, i) {
      return '<div class="sel" data-kind="' + k + '" style="--c:var(--' + k + ');--i:' + i + '"><div class="no">0' + (i + 1) + '</div><div class="box">' +
        '<label for="in-' + k + '">' + esc(U('sel_' + k)) + '</label><div class="field"><input id="in-' + k + '" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="list-' + k + '" autocomplete="off" spellcheck="false" placeholder="' + esc(U('ph_' + k)) + '"><button type="button" class="x" aria-label="' + esc(U('clear')) + '" hidden>×</button></div></div></div>';
    }).join('');
    $$('.sel').forEach(function (root) {
      var kind = root.dataset.kind, input = $('input', root);
      input.addEventListener('focus', function () { input.select(); showList(root, kind, ''); });
      input.addEventListener('input', function () { showList(root, kind, input.value); });
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); if (!openList) showList(root, kind, input.value); moveActive(1); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveActive(-1); }
        else if (ev.key === 'Enter') {
          ev.preventDefault();
          if (!openList) return;
          var items = $$('li[data-id]', openList.el), pick = items[Math.max(openList.active, 0)];
          if (pick) { choose(kind, pick.dataset.id); input.blur(); }
        } else if (ev.key === 'Escape') { closeList(); syncInputs(); input.blur(); }
      });
      $('.x', root).addEventListener('click', function () { clearSel(); });
      root.addEventListener('mousedown', function (ev) {
        var li = ev.target.closest && ev.target.closest('li[data-id]');
        if (li) { ev.preventDefault(); choose(kind, li.dataset.id); input.blur(); }
      });
    });
    syncInputs();
  }

  function syncInputs() {
    $$('.sel').forEach(function (root) {
      var k = root.dataset.kind, on = S.kind === k, input = $('input', root);
      root.classList.toggle('on', on);
      input.value = on ? nameOf(k, S.id) : '';
      $('.x', root).hidden = !on;
    });
  }

  function clearSel() {
    S.kind = S.id = null;
    delete document.body.dataset.kind;
    syncInputs();
    paintDossier();
    paintCards();
    paintMap(false);
    writeHash();
    $('#gear').hidden = true;
    $('#hello').hidden = !!S.map;
  }

  function choose(kind, id) {
    closeList();
    S.kind = kind;
    S.id = id;
    S.off = {};
    document.body.dataset.kind = kind;
    $('#hello').hidden = true;
    syncInputs();
    var src = 'data/details.' + (kind === 'quest' ? 'quests' : kind === 'arc' ? 'arcs' : 'items') + '.js';
    return need(src).then(function () {
      paintDossier();
      paintCards();
      paintStatus();
      paintMap(false, true);
      writeHash();
      setPane(lit(S.map) ? 'map' : (anyLit() ? 'right' : 'left'));
    });
  }

  /* ---------- language, hash, chrome ---------- */

  function writeHash() {
    var parts = ['', S.lang, S.kind || '-', S.id || '-', S.map || '-'];
    var h = '#' + parts.join('/');
    if (location.hash !== h) history.replaceState(null, '', h);
  }
  function readHash() {
    var p = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    var out = {};
    if (LANGS.indexOf(p[0]) >= 0) out.lang = p[0];
    if (KINDS.indexOf(p[1]) >= 0 && BY[p[1] + ':' + p[2]]) { out.kind = p[1]; out.id = p[2]; }
    if (p[3] && mapInfo(p[3])) out.map = p[3];
    return out;
  }

  function setPane(p) {
    document.body.dataset.pane = p;
    $$('#tabs button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.pane === p); });
    if (p === 'map') setTimeout(function () { map.invalidateSize(); }, 30);
  }

  function chrome() {
    document.documentElement.lang = S.lang;
    document.title = 'FunArcRaiders · ' + U('tag');
    $('#tag').textContent = U('tag');
    $('#mapsTitle').textContent = U('maps');
    $('#hello').innerHTML = '<h2>' + esc(U('hello_t')) + '</h2><p>' + esc(U('hello')) + '</p>';
    $('#credit').innerHTML = esc(U('unofficial')) + ' ' + esc(U('data_date')) + ' ' + esc(CORE.built) + '. ' + esc(U('sources')) + ': <a href="https://metaforge.app/arc-raiders" target="_blank" rel="noopener">MetaForge</a>, <a href="https://arctracker.io" target="_blank" rel="noopener">ARC Tracker</a>, <a href="https://github.com/RaidTheory/arcraiders-data" target="_blank" rel="noopener">RaidTheory</a>, <a href="https://arcraiders.wiki" target="_blank" rel="noopener">Wiki</a>, <a href="https://t.me/duckraiders" target="_blank" rel="noopener">ARC Raiders HUB</a>. © Embark Studios.';
    $$('#lang button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.lang === S.lang); });
    var tabs = $$('#tabs button');
    tabs[0].textContent = U('where');
    tabs[1].textContent = U('legend');
    tabs[2].textContent = U('maps');
    tabs[0].textContent = U('sel_item').slice(0, 0) + '⌕';
    tabs[1].textContent = '◎';
    tabs[2].textContent = U('maps');
  }

  function setLang(lang) {
    return need('data/i18n.' + lang + '.js').then(function () {
      S.lang = lang;
      store.set('far-lang', lang);
      closeList();
      buildIndex();
      buildSelectors();
      chrome();
      paintDossier();
      paintCards();
      paintLabels();
      return paintMap(false);
    }).then(writeHash);
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var go = t.closest && t.closest('[data-go]');
    if (go) { var p = go.dataset.go.split(':'); choose(p[0], p[1]); return; }
    var area = t.closest && t.closest('[data-area]');
    if (area) {
      var a = area.dataset.area.split('|');
      openMap(a[0]).then(function () { var b = FAR.mapdata[a[0]].B[a[1]]; if (b) map.flyTo([b[1], b[0]], 2.5, { duration: 0.6 }); });
      return;
    }
    var card = t.closest && t.closest('[data-map]');
    if (card) { openMap(card.dataset.map); return; }
    var lang = t.closest && t.closest('[data-lang]');
    if (lang) { setLang(lang.dataset.lang); return; }
    var pane = t.closest && t.closest('[data-pane]');
    if (pane && pane.tagName === 'BUTTON') { setPane(pane.dataset.pane); return; }
    var floor = t.closest && t.closest('[data-floor]');
    if (floor) { S.floor = floor.dataset.floor; paintMap(true); return; }
    var zoom = t.closest && t.closest('[data-zoom]');
    if (zoom) { map.setZoom(map.getZoom() + Number(zoom.dataset.zoom)); return; }
    if (t.closest && t.closest('[data-reset]')) { fit(); return; }
    var all = t.closest && t.closest('[data-all]');
    if (all) {
      var anyOn = layerSet.some(function (l) { return !isOff(l); });
      layerSet.forEach(function (l) { S.off[l.key] = anyOn ? 1 : 0; });
      drawLayers(); paintLegend();
      return;
    }
    if (openList && !(t.closest && t.closest('.sel'))) { closeList(); syncInputs(); }
  });
  $('#legend').addEventListener('change', function (ev) {
    var k = ev.target.dataset.key;
    if (!k) return;
    if (k === '__conts') { layerSet.forEach(function (l) { if (l.hide) S.off[l.key] = ev.target.checked ? 0 : 1; }); drawLayers(); paintLegend(); return; }
    S.off[k] = ev.target.checked ? 0 : 1;
    drawLayers();
    paintLegend();
  });
  $('#dossier').addEventListener('mouseover', function (ev) {
    var li = ev.target.closest && ev.target.closest('[data-step]');
    if (!li) return;
    var st = String(Number(li.dataset.step) + 1);
    overlay.eachLayer(function (m) {
      if (m.options && m.options.meta) m.setRadius(m.options.meta.step === st ? m.options.r0 + 4 : m.options.r0);
    });
  });
  $('#dossier').addEventListener('mouseleave', function () {
    overlay.eachLayer(function (m) { if (m.options && m.options.meta) m.setRadius(m.options.r0); });
  });
  if (window.ResizeObserver) new ResizeObserver(boxChanged).observe($('#map'));
  else window.addEventListener('resize', boxChanged);
  window.addEventListener('hashchange', function () {
    var h = readHash();
    if (h.lang && h.lang !== S.lang) setLang(h.lang);
    if (h.kind && (h.kind !== S.kind || h.id !== S.id)) choose(h.kind, h.id);
    if (h.map && h.map !== S.map) openMap(h.map);
  });

  function browserLang() {
    var saved = store.get('far-lang');
    if (LANGS.indexOf(saved) >= 0) return saved;
    var nav = (navigator.languages || [navigator.language || 'en']).map(function (l) { return String(l).slice(0, 2).toLowerCase(); });
    for (var i = 0; i < nav.length; i++) if (LANGS.indexOf(nav[i]) >= 0) return nav[i];
    return nav.some(function (l) { return ['uk', 'be', 'kk'].indexOf(l) >= 0; }) ? 'ru' : 'en';
  }

  FAR.api = { choose: choose, openMap: openMap, setLang: setLang, clear: clearSel, state: S, map: map, layers: function () { return layerSet; } };

  var boot = readHash();
  setLang(boot.lang || browserLang()).then(function () {
    S.map = boot.map || CORE.maps[0].id;
    paintCards();
    return paintMap(true).then(fit);
  }).then(function () {
    $('#hello').hidden = !!boot.kind;
    setPane('left');
    if (boot.kind) return choose(boot.kind, boot.id);
  }).then(function () {
    LANGS.forEach(function (l, i) { if (l !== S.lang) setTimeout(function () { need('data/i18n.' + l + '.js'); }, 1500 + i * 400); });
  }).catch(function (err) {
    $('#hello').innerHTML = '<h2>Error</h2><p>' + esc(err.message) + '</p>';
    $('#hello').hidden = false;
  });
})();
