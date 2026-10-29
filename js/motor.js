"use strict";
// RE-visión (VialAG): motor de lectura, dibujo, alineación y comparación de planos.
// Sale del Comparador de Planos A·B v19, sin cambios de criterio.
// ---------- constants ----------
const INK_THRESHOLD = 215;          // luminance below this counts as drawn ink
const COL_MATCH = [150, 156, 163];  // gray for matching linework
const COL_DIFF = [237, 65, 51];     // red (#ed4133)
const LEGEND = [[COL_MATCH, "Coincide"], [COL_DIFF, "Diferencia"]];
const NO_MATCH = 20;                // below this % of matching linework, A and B are treated as different plans
const MAX_ZOOM = 32;                // screen px per overview px
const DETAIL_BUDGET = 14e6;         // max pixels of the sharp detail render
const HATCH_MIN_MM = 4;             // PDF: a filled area at least this long (on paper) counts as hatch
const TOL = 1;                      // px a line may shift without counting as a change
const RES = 4500;                   // long side of the comparison image, px
const PDF_RES = 12000;              // long side of the comparison in the downloaded PDF, px (redrawn from the plans in tiles)
const PDF_TILE = 2000;              // tile side for that redraw, px
const $ = (id) => document.getElementById(id);
const DPR = () => Math.min(2, window.devicePixelRatio || 1);
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

// ---------- small affine helpers ----------
const mul = (m, n) => [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
const apply = (m, x, y) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
const scaleOf = (m) => Math.hypot(m[0], m[1]);
const I = [1, 0, 0, 1, 0, 0];
const inv = (m) => { const d = m[0] * m[3] - m[1] * m[2]; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]; };

// ---------- HATCH entities (dxf-parser 1.1.2 skips them) ----------
// Boundary loops and pattern lines, in the entity's own coordinates (OCS).
class HatchHandler {
  constructor() { this.ForEntityName = "HATCH"; }
  parseEntity(sc, g) {
    const t = [];
    for (g = sc.next(); !sc.isEOF() && g.code !== 0; g = sc.next()) t.push([g.code, g.value]);
    return parseHatch(t);
  }
}
function parseHatch(t) {
  const e = { type: "HATCH", loops: [], lines: [], solid: false };
  let i = 0;
  const at = (c) => i < t.length && t[i][0] === c;
  const val = () => t[i++][1];
  while (i < t.length && !at(91)) {
    const [c, v] = t[i++];
    if (c === 8) e.layer = v; else if (c === 60) e.visible = v === 0; else if (c === 67) e.inPaperSpace = v !== 0;
    else if (c === 2) e.pattern = v; else if (c === 70) e.solid = v === 1; else if (c === 230) e.extrusionDirectionZ = v;
  }
  if (i >= t.length) return e;
  const nLoops = val();
  for (let L = 0; L < nLoops && i < t.length; L++) {
    while (i < t.length && !at(92)) i++;
    if (i >= t.length) break;
    const flag = val();
    if (flag & 2) { // polyline loop: 72 has bulge, 73 closed, 93 count, then 10/20/[42]
      while (i < t.length && !at(93)) i++;
      const nv = i < t.length ? val() : 0, vs = [];
      for (let k = 0; k < nv && at(10); k++) { const x = val(), y = at(20) ? val() : 0, b = at(42) ? val() : 0; vs.push({ x, y, bulge: b }); }
      e.loops.push({ poly: vs });
    } else { // edge loop: lines, arcs, elliptic arcs and splines
      const ne = at(93) ? val() : 0, edges = [];
      for (let k = 0; k < ne && at(72); k++) {
        const type = val();
        if (type === 4) {
          const ed = { type, deg: 3, knots: [], cp: [] };
          while (i < t.length && [94, 73, 74, 95, 96].includes(t[i][0])) { const [c, v] = t[i++]; if (c === 94) ed.deg = v; }
          while (at(40)) ed.knots.push(val());
          while (at(10)) { const x = val(), y = at(20) ? val() : 0; if (at(42)) i++; ed.cp.push({ x, y }); }
          if (at(97)) { // fit data, unless this 97 already counts the loop's source objects
            const save = i, n = val();
            if (at(11) || at(12) || (n === 0 && at(97))) { while (at(11) || at(21) || at(12) || at(22) || at(13) || at(23)) i++; } else i = save;
          }
          edges.push(ed);
        } else {
          const m = {};
          while (i < t.length && ![72, 97, 92, 75].includes(t[i][0])) { const [c, v] = t[i++]; m[c] = v; }
          edges.push({ type, m });
        }
      }
      e.loops.push({ edges });
    }
    if (at(97)) { const n = val(); for (let k = 0; k < n && at(330); k++) i++; }
  }
  while (i < t.length) {
    const [c, v] = t[i];
    if (c === 78) { // pattern lines: angle, base point, offset, dashes (already scaled and rotated)
      i++;
      for (let q = 0; q < v && at(53); q++) {
        const ln = { a: val() };
        ln.bx = at(43) ? val() : 0; ln.by = at(44) ? val() : 0; ln.ox = at(45) ? val() : 0; ln.oy = at(46) ? val() : 0;
        const nd = at(79) ? val() : 0; ln.d = [];
        for (let r = 0; r < nd && at(49); r++) ln.d.push(val());
        e.lines.push(ln);
      }
      continue;
    }
    if (c === 450 && v === 1) e.solid = true; // gradient fills are drawn as solid
    i++;
  }
  return e;
}

// ---------- sources: draw a plan with any transform (raster px -> canvas px) ----------
let liveTasks = [];
function cancelRenders() { for (const t of liveTasks) { try { t.cancel(); } catch {} } liveTasks = []; }

// ---------- annotation elements ("Elementos de anotación" switch) ----------
// What is not part of the drawn building: axes and their bubbles, dimensions, texts, level marks,
// section and elevation marks, tags. Switched off, they are neither drawn nor compared.
// By name: DXF layers, DXF blocks and PDF layers (the layer's own name, also inside a bound xref "XREF$0$COTAS").
const ANNOT_WORDS = new Set(("eje ejes axis axes grid grids grilla grillas iden cota cotas acotacion acotaciones dim dims dimension dimensions dimensiones " +
  "texto textos text texts anno anot anota anotacion anotaciones annotation annotations nota notas note notes nplt " +
  "levl npt symb simb simbolo simbolos simbologia symbol symbols tag tags etiqueta etiquetas").split(" "));
const LEVEL_WORDS = new Set("nivel niveles level levels".split(" ")); // only in names without numbers ("NIVEL 1" holds a floor's walls)
const CUT_WORDS = new Set("corte cortes seccion secciones section sections sect elev elevacion elevaciones elevation elevations".split(" "));
const MARK_WORDS = new Set("linea lineas line lines marca marcas mark marks simb symb simbolo head cabeza tail flecha".split(" "));
const BLOCK_WORDS = new Set("level levels grid grids nivel niveles npt eje ejes burbuja burbujas cota cotas tag tags etiqueta etiquetas callout spot".split(" "));
const AXIS_LT = /grid|eje/i; // DXF linetypes of axes
const nameWords = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
function annotLayer(name) {
  const s = String(name || "").split("$0$").pop(), w = nameWords(s);
  if (!w.length) return false;
  if (w.some((x) => ANNOT_WORDS.has(x))) return true;
  if (!/\d/.test(s) && w.some((x) => LEVEL_WORDS.has(x))) return true;
  // "CORTES" alone holds the section lines and heads; "MURO CORTE" holds the cut walls
  if (w.every((x) => CUT_WORDS.has(x))) return true;
  return w.some((x) => CUT_WORDS.has(x)) && w.some((x) => MARK_WORDS.has(x));
}
// Revit names blocks "Family - Type-<id>-<view>"; the view ("NIVEL PISO 3") says nothing of the block
function annotBlock(name) {
  const s = String(name || "").replace(/-V?\d+-(?!.*-V?\d+-).*$/, ""), w = nameWords(s);
  if (w.some((x) => BLOCK_WORDS.has(x))) return true;
  return w.some((x) => CUT_WORDS.has(x)) && w.some((x) => MARK_WORDS.has(x));
}

// PDFs without layers: annotation is told apart by its shape around the texts.
// pdf.js builds each path between two beginPath() calls and then strokes or fills it. Paths are numbered
// in that order and their subpaths (each moveTo or rect) by place: the same numbers on every render of a
// page with the same layers hidden, at any zoom.
const TAP = ["beginPath", "moveTo", "lineTo", "bezierCurveTo", "quadraticCurveTo", "rect", "closePath", "stroke", "fill"];
function untap(ctx) { if (ctx.__tap) { for (const [k, f] of ctx.__tap) { if (f) ctx[k] = f; else delete ctx[k]; } ctx.__tap = null; } }
function tap(ctx, hooks) {
  untap(ctx);
  const saved = [];
  for (const k of TAP) {
    if (!hooks[k]) continue;
    const own = Object.prototype.hasOwnProperty.call(ctx, k) ? ctx[k] : null, inner = ctx[k], h = hooks[k];
    saved.push([k, own]);
    ctx[k] = function (...a) { return h.call(this, inner, a); };
  }
  ctx.__tap = saved;
}
// Record every painted path of a render: [{pid, subs:[{pts, closed}], s, f, lw, col, dash}], canvas px.
function tapRecord(ctx, out) {
  let pid = 0, subs = [], cur = null, t = null, last = null;
  const dev = (x, y) => [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
  const start = (c, x, y) => { t = c.getTransform(); cur = { pts: [dev(x, y)], closed: false }; subs.push(cur); };
  const paint = (c, kind) => {
    if (!subs.length) return;
    if (last && last.pid === pid) { last[kind] = true; if (kind === "s") { last.col = c.strokeStyle; last.lw = lwOf(c); last.dash = c.getLineDash().length > 0; } return; }
    last = { pid, subs, s: kind === "s", f: kind === "f", lw: kind === "s" ? lwOf(c) : 0, col: kind === "s" ? c.strokeStyle : c.fillStyle, dash: kind === "s" && c.getLineDash().length > 0, prim: c.__prim };
    out.push(last);
  };
  const lwOf = (c) => { const m = c.getTransform(); return c.lineWidth * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)); };
  tap(ctx, {
    beginPath(inner, a) { pid++; subs = []; cur = null; return inner.apply(this, a); },
    moveTo(inner, a) { start(this, a[0], a[1]); return inner.apply(this, a); },
    lineTo(inner, a) { if (cur) cur.pts.push(dev(a[0], a[1])); else start(this, a[0], a[1]); return inner.apply(this, a); },
    bezierCurveTo(inner, a) {
      if (cur) {
        const [px, py] = cur.pts[cur.pts.length - 1], c1 = dev(a[0], a[1]), c2 = dev(a[2], a[3]), e = dev(a[4], a[5]);
        for (let i = 1; i <= 8; i++) { const u = i / 8, v = 1 - u; cur.pts.push([v * v * v * px + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * e[0], v * v * v * py + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * e[1]]); }
        cur.curve = true;
      }
      return inner.apply(this, a);
    },
    quadraticCurveTo(inner, a) { if (cur) { cur.pts.push(dev(a[2], a[3])); cur.curve = true; } return inner.apply(this, a); },
    rect(inner, a) {
      const [x, y, w, h] = a; t = this.getTransform();
      subs.push({ pts: [dev(x, y), dev(x + w, y), dev(x + w, y + h), dev(x, y + h), dev(x, y)], closed: true }); cur = null;
      return inner.apply(this, a);
    },
    closePath(inner, a) { if (cur) cur.closed = true; return inner.apply(this, a); },
    stroke(inner, a) { if (!(a[0] instanceof Path2D)) paint(this, "s"); return inner.apply(this, a); },
    fill(inner, a) { if (!(a[0] instanceof Path2D)) paint(this, "f"); return inner.apply(this, a); },
  });
}
// Leave out the marked subpaths (marks: pid -> Set of subpath numbers) of a render.
// A path with some marked subpaths is built again, at paint time, with the others only.
function tapFilter(ctx, marks) {
  const P = CanvasRenderingContext2D.prototype;
  let pid = 0, set = null, buf = null, cur = null, t = null;
  const dev = (x, y) => [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
  const start = (c, x, y) => { t = c.getTransform(); cur = [["M", ...dev(x, y)]]; buf.push(cur); };
  // false: nothing of the path is left to paint
  const rebuild = (c) => {
    const keep = buf.filter((s, i) => !set.has(i)); if (!keep.length) return false;
    if (keep.length === buf.length) return true;
    const m = c.getTransform().invertSelf(), L = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
    P.beginPath.call(c);
    for (const s of keep) for (const o of s) {
      if (o[0] === "M") P.moveTo.call(c, ...L(o[1], o[2]));
      else if (o[0] === "L") P.lineTo.call(c, ...L(o[1], o[2]));
      else if (o[0] === "C") P.bezierCurveTo.call(c, ...L(o[1], o[2]), ...L(o[3], o[4]), ...L(o[5], o[6]));
      else if (o[0] === "Q") P.quadraticCurveTo.call(c, ...L(o[1], o[2]), ...L(o[3], o[4]));
      else P.closePath.call(c);
    }
    return true;
  };
  tap(ctx, {
    beginPath(inner, a) { pid++; set = marks.get(pid) || null; buf = set ? [] : null; cur = null; return inner.apply(this, a); },
    moveTo(inner, a) { if (buf) start(this, a[0], a[1]); return inner.apply(this, a); },
    lineTo(inner, a) { if (buf) { if (cur) cur.push(["L", ...dev(a[0], a[1])]); else start(this, a[0], a[1]); } return inner.apply(this, a); },
    bezierCurveTo(inner, a) { if (buf && cur) cur.push(["C", ...dev(a[0], a[1]), ...dev(a[2], a[3]), ...dev(a[4], a[5])]); return inner.apply(this, a); },
    quadraticCurveTo(inner, a) { if (buf && cur) cur.push(["Q", ...dev(a[0], a[1]), ...dev(a[2], a[3])]); return inner.apply(this, a); },
    rect(inner, a) {
      if (buf) { const [x, y, w, h] = a; t = this.getTransform(); buf.push([["M", ...dev(x, y)], ["L", ...dev(x + w, y)], ["L", ...dev(x + w, y + h)], ["L", ...dev(x, y + h)], ["Z"]]); cur = null; }
      return inner.apply(this, a);
    },
    closePath(inner, a) { if (buf && cur) cur.push(["Z"]); return inner.apply(this, a); },
    stroke(inner, a) { if (buf && !(a[0] instanceof Path2D) && !rebuild(this)) return; return inner.apply(this, a); },
    fill(inner, a) { if (buf && !(a[0] instanceof Path2D) && !rebuild(this)) return; return inner.apply(this, a); },
  });
}

// Annotation of a PDF page without layers for it, found once per page and scale (overview px).
// oc: the layers hidden in the render, so paths are numbered as in the render.
// A canvas of 8 x 8 px that tells pdf.js it has the page's size: pdf.js leaves out fills it believes
// fall outside the canvas, and the paths are only recorded, not drawn.
function tinyCanvas(vp) {
  const c = document.createElement("canvas"); c.width = c.height = 8;
  const W = Math.ceil(vp.width), H = Math.ceil(vp.height);
  Object.defineProperty(c, "width", { get: () => W, set: () => {} }); Object.defineProperty(c, "height", { get: () => H, set: () => {} });
  return c;
}
// DXF lines on drawing layers that still are annotation (a level mark drawn with lines beside its text):
// found by the same shapes as in a PDF, on the overview. Marked primitives get "as".
function dxfAnnots(D) {
  const key = D.prims.length + "|" + D.k + "|" + D.pad + "|" + D.bb.join(",");
  if (D.annot && D.annot.key === key && D.annot.prims === D.prims) return D.annot; // a redraw builds new primitives
  const c = tinyCanvas({ width: D.W, height: D.H }), ctx = c.getContext("2d"), paths = [], texts = [];
  ctx.fillText = ctx.strokeText = () => {};
  for (const p of D.prims) p.as = false;
  tapRecord(ctx, paths);
  try { drawPrims(ctx, D, I, texts, false, true, true); } finally { untap(ctx); }
  // the layers already give the dimensions, axes, tags and their bubbles: look only for level marks drawn on
  // other layers (height marks, level triangles) and the lines that start at them
  const r = annotFind(paths, texts, false, { pre: (s) => !!(s.p.prim && s.p.prim.an), noDims: true, levelsOnly: true });
  for (const P of paths) {
    const set = r.marks.get(P.pid), q = P.prim;
    if (set && q && !q.an && (q.t === "p" || (q.t === "h" && q.solid)) && set.size >= P.subs.length) q.as = true;
  }
  D.annot = { key, prims: D.prims, n: r.n, kinds: r.kinds };
  return D.annot;
}
// A DXF hatch exploded into lines (LINE entities, no HATCH): the same families of parallel lines as in a PDF.
// A DXF has no paper scale: the overview (about 4500 px across) is read as a sheet about a meter wide.
const DXF_PX_PER_MM = 4.5;
function dxfHatch(D) {
  const key = D.prims.length + "|" + D.k + "|" + D.pad + "|" + D.bb.join(",");
  if (D.hl && D.hl.key === key && D.hl.prims === D.prims) return D.hl;
  const c = tinyCanvas({ width: D.W, height: D.H }), ctx = c.getContext("2d"), paths = [];
  ctx.fillText = ctx.strokeText = () => {};
  for (const p of D.prims) p.hl = false;
  tapRecord(ctx, paths);
  try { drawPrims(ctx, D, I, null, false, true, true); } finally { untap(ctx); }
  const r = lineHatch(paths, DXF_PX_PER_MM);
  let n = 0;
  for (const P of paths) { const set = r.marks.get(P.pid), q = P.prim; if (set && q && q.t === "p" && !q.fill && set.size >= P.subs.length) { q.hl = true; n++; } }
  D.hl = { key, prims: D.prims, n };
  return D.hl;
}
// The page's paths as pdf.js draws them, recorded once per set of hidden layers (the path numbers
// depend on it): what pdfAnnots and pdfHatch read.
async function pdfRecord(D, oc, hidden) {
  const key = D.page + "|" + D.scale + "|" + hidden;
  if (D.rec && D.rec.key === key) return D.rec;
  const page = await D.pdf.getPage(D.page), vp = page.getViewport({ scale: D.scale });
  const c = tinyCanvas(vp), ctx = c.getContext("2d"), paths = [];
  ctx.fillText = ctx.strokeText = () => {};
  tapRecord(ctx, paths);
  const task = page.render({ canvasContext: ctx, viewport: vp, optionalContentConfigPromise: oc });
  liveTasks.push(task);
  try { await task.promise; } finally { liveTasks = liveTasks.filter((t) => t !== task); untap(ctx); }
  D.rec = { key, paths, annot: null, hatch: null };
  return D.rec;
}
async function pdfAnnots(D, oc, hidden = "annot") {
  const R = await pdfRecord(D, oc, hidden);
  if (!R.annot) {
    let texts = [];
    try { texts = await pdfTexts(D); } catch {}
    const r = annotFind(R.paths, texts);
    R.annot = { marks: r.marks, n: r.n, kinds: r.kinds };
  }
  D.annot = R.annot;
  return R.annot;
}
async function pdfHatch(D, oc, hidden) {
  const R = await pdfRecord(D, oc, hidden);
  if (!R.hatch) R.hatch = lineHatch(R.paths, D.scale * 72 / 25.4);
  return R.hatch;
}

// Hatch drawn as lines. CAD programs print a hatch pattern as one stroke per line, already cut at the
// hatch's boundary, all drawn one after another. A family of them: at least HL_MIN lines of the same
// style and angle drawn in a row, at a regular spacing (HL_MIN_MM to HL_MAX_MM on paper, most of them
// one spacing from the next) and in step (two
// hatches drawn one after the other may be out of step with each other: each is a family of its own),
// whose ends meet the boundary at a slant. That last test leaves out stair treads, railing bars, louvres
// and the like: their ends meet the stringer or the rail square, all at the same place along the lines.
// A family of under 2 × HL_MIN lines must be spaced at most HL_TIGHT_MM (the steps of a stand are spaced wider).
// Returns marks (pid -> Set of subpaths) like annotFind, and the number of families.
const HL_MIN = 10, HL_MIN_MM = 0.4, HL_MAX_MM = 6, HL_TIGHT_MM = 2.2;
function lineHatch(paths, pxPerMm, dbg = null) {
  const marks = new Map(), open = [], runs = [];
  let n = 0;
  for (const P of paths) {
    if (!P.s || P.f) continue;
    P.subs.forEach((sb, i) => {
      if (sb.pts.length !== 2) return;
      const [a, b] = sb.pts, dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 0.5) return;
      let th = Math.atan2(dy, dx); if (th < 0) th += Math.PI; if (th >= Math.PI) th -= Math.PI;
      const tol = Math.max(0.005, 0.3 / len); // a short line's angle is less sure (coordinates are rounded)
      let run = null;
      for (let k = open.length - 1; k >= 0; k--) {
        const r = open[k];
        if (P.pid - r.last > 6) { open.splice(k, 1); continue; }
        const d = Math.abs(r.th - th);
        if (r.col === P.col && r.dash === P.dash && Math.abs(r.lw - P.lw) < 0.05 && Math.min(d, Math.PI - d) < tol) { run = r; break; }
      }
      if (!run) { run = { col: P.col, dash: P.dash, lw: P.lw, th, ls: [] }; open.push(run); runs.push(run); }
      if (len >= 20 && !run.sure) { run.th = th; run.sure = true; } // the angle of a long line stands for the run
      run.ls.push({ P, i, a, b }); run.last = P.pid;
    });
  }
  // a run whose first long line was a little off splits one hatch in two (a 50 px line may be 0.3° off):
  // a run of the same style that goes on right after the previous one at nearly its angle joins it,
  // at the median angle of their long lines
  const median = (r) => {
    const long = r.ls.map((o) => { const dx = o.b[0] - o.a[0], dy = o.b[1] - o.a[1]; let t = Math.atan2(dy, dx); t -= Math.PI * Math.round((t - r.th) / Math.PI); return { t, len: Math.hypot(dx, dy) }; }).filter((o) => o.len >= 20).map((o) => o.t).sort((x, y) => x - y);
    return long.length ? long[long.length >> 1] : r.th;
  };
  for (let k = runs.length - 1; k > 0; k--) {
    const r = runs[k], q = runs[k - 1], first = r.ls[0].P.pid;
    if (r.col !== q.col || r.dash !== q.dash || Math.abs(r.lw - q.lw) >= 0.05 || first > q.last + 6 || first < q.ls[0].P.pid) continue;
    const d = Math.abs(median(r) - median(q)); if (Math.min(d, Math.PI - d) > 0.012) continue;
    q.ls.push(...r.ls); q.last = Math.max(q.last, r.last); q.joined = true; runs.splice(k, 1);
  }
  for (const r of runs) {
    if (r.ls.length < HL_MIN) continue;
    if (r.joined) r.th = median(r);
    const why = (w, x = {}) => { if (dbg) { const xs = r.ls.flatMap((o) => [o.a[0], o.b[0]]), ys = r.ls.flatMap((o) => [o.a[1], o.b[1]]); dbg.push({ why: w, n: r.ls.length, deg: +(r.th * 180 / Math.PI).toFixed(1), pids: r.ls[0].P.pid + "-" + r.ls[r.ls.length - 1].P.pid, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round), lw: r.lw, ...x }); } };
    // offset across the lines and the two ends along them, all at the run's angle
    const ux = Math.cos(r.th), uy = Math.sin(r.th);
    const ls = r.ls.map((o) => { const sa = o.a[0] * ux + o.a[1] * uy, sb = o.b[0] * ux + o.b[1] * uy; return { o, off: (-(o.a[0] + o.b[0]) * uy + (o.a[1] + o.b[1]) * ux) / 2, s0: Math.min(sa, sb), s1: Math.max(sa, sb) }; }).sort((x, y) => x.off - y.off);
    // one row per distinct offset (a line may be cut in pieces by an island): its two ends along the lines
    const rows = [];
    for (const l of ls) {
      const w = rows[rows.length - 1];
      if (w && l.off - w.off <= 0.3) { w.s0 = Math.min(w.s0, l.s0); w.s1 = Math.max(w.s1, l.s1); w.ls.push(l.o); }
      else rows.push({ off: l.off, s0: l.s0, s1: l.s1, ls: [l.o] });
    }
    if (rows.length < HL_MIN) { why("rows", { rows: rows.length }); continue; }
    // spacing: the most common gap between neighbouring rows
    const gaps = []; for (let k = 1; k < rows.length; k++) gaps.push(rows[k].off - rows[k - 1].off);
    let sp = 0, best = 0;
    const spMin = Math.max(1.5, HL_MIN_MM * pxPerMm); // closer lines are a grey fill, or details that only look regular
    for (const g of gaps) { if (g < spMin || g > HL_MAX_MM * pxPerMm) continue; const c = gaps.filter((h) => Math.abs(h - g) <= Math.max(0.3, 0.08 * g)).length; if (c > best) { best = c; sp = g; } }
    if (!sp) { why("spacing"); continue; }
    const near = gaps.filter((h) => Math.abs(h - sp) <= Math.max(0.3, 0.08 * sp)).sort((x, y) => x - y); sp = near[near.length >> 1];
    // families in step: rows grouped by their place within the spacing (two hatches may be out of step)
    const tol = Math.max(0.35, 0.12 * sp), phase = (x) => ((x % sp) + sp) % sp;
    const byPh = rows.map((w) => ({ w, ph: phase(w.off) })).sort((x, y) => x.ph - y.ph), groups = [];
    for (const e of byPh) { const g = groups[groups.length - 1]; if (g && e.ph - g.last <= tol) { g.rows.push(e.w); g.last = e.ph; } else groups.push({ rows: [e.w], first: e.ph, last: e.ph }); }
    if (groups.length > 1) { const g0 = groups[0], gz = groups[groups.length - 1]; if (g0.first + sp - gz.last <= tol) { g0.rows.push(...gz.rows); groups.pop(); } } // wraps around
    for (const g of groups) {
      const rw = g.rows.sort((x, y) => x.off - y.off);
      if (rw.length < HL_MIN) continue;
      // regular: neighbours one to four spacings apart (a missing line is a hole in the hatch)
      let regular = 0, next = 0, slant = 0;
      for (let k = 1; k < rw.length; k++) {
        const d = rw[k].off - rw[k - 1].off, m = Math.round(d / sp);
        if (m >= 1 && m <= 4 && Math.abs(d - m * sp) <= tol * Math.max(1, m / 2)) { regular++; if (m === 1) next++; }
        // ends meeting the boundary at a slant move along the lines from one line to the next
        if (Math.abs(rw[k].s0 - rw[k - 1].s0) > 0.3 * d + 0.3 || Math.abs(rw[k].s1 - rw[k - 1].s1) > 0.3 * d + 0.3) slant++;
      }
      if (regular < 0.75 * (rw.length - 1) || next < 0.6 * (rw.length - 1)) { why("irregular", { sp, rows: rw.length, reg: regular / (rw.length - 1) }); continue; }
      if (slant < 0.5 * (rw.length - 1)) { why("square", { sp, rows: rw.length, slant: slant / (rw.length - 1) }); continue; }
      // a short family spaced wide may be the steps of a stand: a hatch that small is spaced tight
      if (rw.length < 2 * HL_MIN && sp > HL_TIGHT_MM * pxPerMm) { why("few", { sp, rows: rw.length }); continue; }
      why("hatch", { sp, rows: rw.length });
      n++;
      for (const w of rw) for (const o of w.ls) { let set = marks.get(o.P.pid); if (!set) marks.set(o.P.pid, set = new Set()); set.add(o.i); }
    }
  }
  return { marks, n };
}

// A number as dimensions write it ("130", "2,40", "d=150", "Ø50", "R=25 cm")
const DIM_RE = /^\s*(?:[a-zA-ZøØ∅]{1,3}\s*[=:]?\s*)?[±+]?\s*\d{1,6}(?:[.,]\d{1,3})?\s*(?:mm|cm|m)?\s*$/;
// Level texts: "NPT ±0.00", "NIVEL 5310", "H9 ALTURA 39.40M", "+2,50"
const LEVEL_RE = /^\s*(?:(?:n\.?\s?p\.?\s?[tsn]|n\.?\s?s\.?\s?l|nivel|level|niv)\.?(?:[^a-z].{0,22})?|(?:\S{1,4}\s+)?(?:altura|cota)\b.{0,24}|[±+-]\s*\d+(?:[.,]\d+)?\s*m?)\s*$/i;

// Shapes around texts that are annotation: bubbles and tags with a text inside (axes, section and
// elevation heads, door and window tags), the marks of level texts and the line under them, the lines
// that start at those symbols (axes, section lines, level lines) with their dashes, and dimension lines
// under a number with their ticks, dots and extension lines. A circle may come as one path or as dozens
// of one-segment paths (AutoCAD). Returns marks (pid -> Set of subpaths).
// a light color (a white mask behind a view, a pale fill): no ink
const lightCol = (c) => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c || ""); return !!m && 0.3 * parseInt(m[1], 16) + 0.59 * parseInt(m[2], 16) + 0.11 * parseInt(m[3], 16) > 215; };
// the letter of a section cut: A, B', A1, CC'
const CUT_RE = /^[A-Z]{1,2}\d{0,2}['’´`]{0,2}$/;
const MIN_TEXT = 3; // px: smaller texts (a key plan at 1:500) are too small to tell their symbols from the drawing
function annotFind(paths, texts, debug = false, opt = {}) {
  const subs = [];
  for (const p of paths) p.subs.forEach((s, i) => {
    const pts = s.pts; if (!pts.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pts) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
    if (!isFinite(x0)) return;
    const a = pts[0], b = pts[pts.length - 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const closed = s.closed || (pts.length > 2 && len < 0.75);
    let straight = !closed && len > 0.5;
    const ux = len ? (b[0] - a[0]) / len : 1, uy = len ? (b[1] - a[1]) / len : 0;
    if (straight && pts.length > 2) for (const q of pts) if (Math.abs((q[0] - a[0]) * uy - (q[1] - a[1]) * ux) > 0.6) { straight = false; break; }
    subs.push({ p, i, pts, closed, straight, curve: !!s.curve, bb: [x0, y0, x1, y1], size: Math.max(x1 - x0, y1 - y0), a, b, len, ux, uy, an: false });
  });
  if (opt.pre) for (const s of subs) if (opt.pre(s)) s.an = true; // already known (a DXF annotation layer)
  // grid of the subpaths along their segments
  const G = 32, grid = new Map();
  subs.forEach((s, n) => {
    const cells = new Set(), pts = s.pts;
    const add = (x, y) => cells.add(Math.floor(x / G) * 65536 + Math.floor(y / G));
    add(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], m = Math.ceil(Math.hypot(bx - ax, by - ay) / (G / 2));
      for (let j = 1; j <= m; j++) add(ax + (bx - ax) * j / m, ay + (by - ay) * j / m);
    }
    for (const k of cells) { let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(n); }
  });
  let stamp = 0; const seen = new Uint32Array(subs.length);
  const near = (x0, y0, x1, y1) => {
    stamp++; const out = [];
    for (let i = Math.floor(x0 / G); i <= Math.floor(x1 / G); i++) for (let j = Math.floor(y0 / G); j <= Math.floor(y1 / G); j++) {
      const l = grid.get(i * 65536 + j); if (!l) continue;
      for (const n of l) if (seen[n] !== stamp) { seen[n] = stamp; out.push(subs[n]); }
    }
    return out;
  };
  const kinds = { bubble: 0, level: 0, line: 0, dim: 0 };
  const marks = new Map(); let nMarked = 0, why = "";
  let src = null;
  const mark = (s) => { if (s.an) return; s.an = true; nMarked++; if (debug) { s.why = why; s.src = src; } let set = marks.get(s.p.pid); if (!set) marks.set(s.p.pid, set = new Set()); set.add(s.i); };
  const segDist = (px, py, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
    return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
  };
  const polyDist = (px, py, pts) => { let d = Infinity; for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(px, py, pts[i - 1], pts[i])); return pts.length > 1 ? d : Math.hypot(px - pts[0][0], py - pts[0][1]); };
  const boxGap = (b, c) => Math.max(0, b[0] - c[2], c[0] - b[2], b[1] - c[3], c[1] - b[3]);
  // a segment crossing a box (not only its bounding box: a long diagonal passing by a corner)
  const segInBox = (a, b, box) => {
    let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - box[0]], [dx, box[2] - a[0]], [-dy, a[1] - box[1]], [dy, box[3] - a[1]]]) {
      if (p === 0) { if (q < 0) return false; continue; }
      const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return true;
  };
  const within = (b, box) => b[0] >= box[0] && b[1] >= box[1] && b[2] <= box[2] && b[3] <= box[3];
  // a shape (one closed subpath, or a loop of pieces): its points, box, corners and roundness
  const shape = (members, own = null) => {
    const pts = own || (members.length === 1 ? members[0].pts : members.flatMap((m) => m.pts));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pts) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rs = pts.map((q) => Math.hypot(q[0] - cx, q[1] - cy)), rm = rs.reduce((a, b) => a + b, 0) / rs.length;
    const v = [];
    if (members.length === 1 || own) { for (const q of pts) if (!v.some((w) => Math.abs(w[0] - q[0]) < 0.6 && Math.abs(w[1] - q[1]) < 0.6)) v.push(q); }
    else if (members.every((m) => m.straight)) for (const m of members) for (const q of [m.a, m.b]) if (!v.some((w) => Math.abs(w[0] - q[0]) < 0.6 && Math.abs(w[1] - q[1]) < 0.6)) v.push(q);
    const round = rm > 0 && (Math.max(...rs) - Math.min(...rs)) / rm < 0.12 && (members.length > 6 || pts.length > 12 || members.some((m) => m.curve));
    return { members, pts, bb: [x0, y0, x1, y1], size: Math.max(x1 - x0, y1 - y0), cx, cy, round, nv: round ? 0 : v.length, v, col: members[0].p.col };
  };
  // closed loops among open pieces: the 2-core of the graph of their segments joined end to end, so that a
  // circle can close on the middle of a polyline (a bubble drawn in one stroke with the start of its axis)
  const loops = (pieces) => {
    const segs = [];
    for (const s of pieces) for (let i = 1; i < s.pts.length; i++) { const a = s.pts[i - 1], b = s.pts[i]; if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) > 0.05) segs.push({ s, a, b }); }
    if (segs.length < 3) return [];
    const node = new Map(), par = [], find = (i) => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
    const key = (q) => { const x = Math.round(q[0] * 2), y = Math.round(q[1] * 2); let id = node.get(x + "," + y); if (id !== undefined) return id; id = par.length; par.push(id); node.set(x + "," + y, id);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const o = node.get((x + dx) + "," + (y + dy)); if (o !== undefined && o !== id) { const r1 = find(o), r2 = find(id); if (r1 !== r2) par[r2] = r1; } }
      return id; };
    const ends = segs.map((g) => [key(g.a), key(g.b)]);
    const E = ends.map(([a, b]) => [find(a), find(b)]), deg = new Map(), alive = segs.map(() => true);
    E.forEach(([a, b], i) => { if (a === b) { alive[i] = false; return; } deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1); });
    for (let changed = true; changed;) {
      changed = false;
      E.forEach(([a, b], i) => { if (alive[i] && (deg.get(a) < 2 || deg.get(b) < 2)) { alive[i] = false; deg.set(a, deg.get(a) - 1); deg.set(b, deg.get(b) - 1); changed = true; } });
    }
    const comp = new Map(), cp = [], cf = (i) => { while (cp[i] !== i) i = cp[i] = cp[cp[i]]; return i; };
    E.forEach(([a, b], i) => { if (!alive[i]) return; for (const n of [a, b]) if (!comp.has(n)) { comp.set(n, cp.length); cp.push(cp.length); } const r1 = cf(comp.get(a)), r2 = cf(comp.get(b)); if (r1 !== r2) cp[r2] = r1; });
    const groups = new Map();
    E.forEach(([a], i) => { if (!alive[i]) return; const r = cf(comp.get(a)); let g = groups.get(r); if (!g) groups.set(r, g = []); g.push(segs[i]); });
    const out = [];
    for (const g of groups.values()) {
      if (g.length < 3) continue; // a line drawn twice
      const members = [...new Set(g.map((x) => x.s))], pts = [];
      for (const x of g) pts.push(x.a, x.b);
      const y = shape(members, pts);
      if (Math.min(y.bb[2] - y.bb[0], y.bb[3] - y.bb[1]) > 1) out.push(y);
    }
    return out;
  };
  // shapes around a box: closed subpaths and loops of open pieces, all of them inside lim
  const shapesIn = (lim, maxSize) => {
    const cand = near(lim[0], lim[1], lim[2], lim[3]).filter((s) => !s.an && s.size <= maxSize && within(s.bb, lim));
    const open = cand.filter((s) => !s.closed), curvy = open.filter((s) => s.curve || s.pts.length > 12);
    // a circle drawn in arcs: its own loop too, apart from the lines touching it
    return cand.filter((s) => s.closed || (s.p.f && !s.straight)).map((s) => shape([s])).concat(loops(open), curvy.length < open.length ? loops(curvy) : []);
  };
  // a point surrounded by a shape: its points go all the way round
  const around = (y, x, yy) => {
    if (slantTag(y)) { // a slanted tag: the point is inside it (its corners alone leave wide gaps)
      const v = ring(y.v); let inside = false;
      for (let i = 0, j = v.length - 1; i < v.length; j = i++) if ((v[i][1] > yy) !== (v[j][1] > yy) && x < (v[j][0] - v[i][0]) * (yy - v[i][1]) / (v[j][1] - v[i][1]) + v[i][0]) inside = !inside;
      return inside;
    }
    const ang = y.pts.map((q) => Math.atan2(q[1] - yy, q[0] - x)).sort((a, b) => a - b);
    let gap = ang[0] + 2 * Math.PI - ang[ang.length - 1];
    for (let i = 1; i < ang.length; i++) gap = Math.max(gap, ang[i] - ang[i - 1]);
    return gap < 1.75;
  };
  // texts with their own frame: origin at the bottom-left of the box, u along the baseline, v up
  const T = [], raw = new Set(texts.map((q) => q.s));
  for (const t of texts.concat(textLines(texts).filter((l) => !raw.has(l.s)))) {
    const s = (t.s || "").trim(); if (!s || !t.h) continue;
    const [p0, p1, p2, p3] = t.c, W = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1, Hh = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) || 1;
    const xs = t.c.map((q) => q[0]), ys = t.c.map((q) => q[1]);
    T.push({ s, h: t.h, p0, u: [(p1[0] - p0[0]) / W, (p1[1] - p0[1]) / W], v: [(p3[0] - p0[0]) / Hh, (p3[1] - p0[1]) / Hh], W, Hh,
      cx: (p0[0] + p1[0] + p2[0] + p3[0]) / 4, cy: (p0[1] + p1[1] + p2[1] + p3[1]) / 4, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
  }
  const fx = (t, q) => (q[0] - t.p0[0]) * t.u[0] + (q[1] - t.p0[1]) * t.u[1], fy = (t, q) => (q[0] - t.p0[0]) * t.v[0] + (q[1] - t.p0[1]) * t.v[1];
  // a bubble holds its texts and little else: lines of its own color inside it (the dividers of a tag or a
  // section head), up to two other lines, or a pattern of one other color passing under it (floor tiles);
  // a room of a small key plan holds more
  const empty = (y) => {
    const m = 0.15 * y.size, box = [y.bb[0] + m, y.bb[1] + m, y.bb[2] - m, y.bb[3] - m], own = new Set(y.members), tol = Math.max(1, 0.05 * y.size);
    const lim = [y.bb[0] - tol, y.bb[1] - tol, y.bb[2] + tol, y.bb[3] + tol];
    const others = near(box[0], box[1], box[2], box[3]).filter((s) => !own.has(s) && boxGap(s.bb, box) === 0 && (!s.straight || segInBox(s.a, s.b, box)) && s.size >= 0.15 * y.size && !(s.p.col === y.col && within(s.bb, lim)));
    return others.length <= 2 || others.every((s) => s.p.col === others[0].p.col && s.p.col !== y.col);
  };
  // a circle split by a line through its middle: a section or elevation head, drawn over anything
  const divided = (y) => {
    if (!y.round) return false;
    const tol = Math.max(1, 0.05 * y.size), lim = [y.bb[0] - tol, y.bb[1] - tol, y.bb[2] + tol, y.bb[3] + tol];
    return near(lim[0], lim[1], lim[2], lim[3]).some((s) => s.straight && s.len >= 0.85 * y.size && within(s.bb, lim) && segDist(y.cx, y.cy, s.a, s.b) <= 0.1 * y.size);
  };
  const sameStyle = (a, b) => a.p.col === b.p.col && a.p.dash === b.p.dash && b.p.lw <= 1.45 * a.p.lw + 0.05 && a.p.lw <= 1.45 * b.p.lw + 0.05;
  // the end of a leader or arrow: a small dot or arrowhead (filled or closed, maybe cut in half by a wall)
  // on the line's end, of the line's color
  const termAt = (q, h, line) => {
    const r = Math.max(1.2, 0.12 * h), out = [];
    for (const d of near(q[0] - r, q[1] - r, q[0] + r, q[1] + r)) {
      if (d.an || d.straight || !(d.closed || d.p.f) || d.size > 1.6 * h || d.size < Math.min(1.5, 0.12 * h) || (line && d.p.col !== line.p.col)) continue;
      if (boxGap(d.bb, [q[0], q[1], q[0], q[1]]) <= r) out.push(d);
    }
    return out;
  };
  // a line drawn twice, and the end of a line that touches nothing else (a line of the drawing meets others)
  const dupOf = (n, l) => n.straight && ((Math.hypot(n.a[0] - l.a[0], n.a[1] - l.a[1]) <= 1 && Math.hypot(n.b[0] - l.b[0], n.b[1] - l.b[1]) <= 1) || (Math.hypot(n.a[0] - l.b[0], n.a[1] - l.b[1]) <= 1 && Math.hypot(n.b[0] - l.a[0], n.b[1] - l.a[1]) <= 1));
  const free = (q, chain) => near(q[0] - 1, q[1] - 1, q[0] + 1, q[1] + 1).every((n) => n.size < 1 || chain.includes(n) || chain.some((l) => dupOf(n, l)) || polyDist(q[0], q[1], n.pts) > 1);
  // corners in order around their middle (a loop of pieces lists them in any order)
  const ring = (v) => { const cx = v.reduce((a, q) => a + q[0], 0) / v.length, cy = v.reduce((a, q) => a + q[1], 0) / v.length; return v.slice().sort((p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx)); };
  // a tag drawn as a slanted parallelogram (a level or finish tag): four corners, none square
  const slantTag = (y) => !y.round && y.nv === 4 && ring(y.v).every((q, i, v) => {
    const a = v[(i + 3) % 4], b = v[(i + 1) % 4], ax = a[0] - q[0], ay = a[1] - q[1], bx = b[0] - q[0], by = b[1] - q[1];
    const c = Math.abs(ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    return c > 0.15 && c < 0.95;
  });
  const syms = [];
  const symbol = (y, kind) => { if (y.members.some((m) => m.an)) return; y.kind = kind; for (const m of y.members) mark(m); syms.push(y); kinds[kind]++; };
  // 1. bubbles and tags: a closed shape a little bigger than a text, around the text's middle
  why = "bubble";
  for (const t of T) {
    if (t.h < MIN_TEXT) continue;
    const r = 5 * t.h;
    for (const y of shapesIn([t.cx - r, t.cy - r, t.cx + r, t.cy + r], 6.5 * t.h)) {
      const w = y.bb[2] - y.bb[0], h = y.bb[3] - y.bb[1], g = 0.2 * t.h, slant = slantTag(y);
      if (opt.levelsOnly && !slant) continue; // in a DXF the layers give the bubbles
      if (y.size < 1.0 * t.h || y.size > (y.round ? 6.5 : slant ? 7 : 4.5) * t.h || Math.min(w, h) < 0.25 * y.size) continue; // a section head is a big circle
      if (t.bb[0] < y.bb[0] - g || t.bb[1] < y.bb[1] - g || t.bb[2] > y.bb[2] + g || t.bb[3] > y.bb[3] + g) continue;
      if (Math.abs(t.cx - y.cx) > 0.3 * w || Math.abs(t.cy - y.cy) > 0.3 * h || !around(y, t.cx, t.cy) || !(empty(y) || divided(y))) continue;
      symbol(y, "bubble"); t.held = true;
    }
  }
  // 2. level texts: the triangle, diamond or circle beside them, and the line under them
  const anchors = [];
  why = "level";
  // a triangle, a circle, or a diamond (sides of about the same length, none level): a rotated plan's small
  // rectangles are not level marks
  // in the text's frame: a triangle has a side along the text and the other two alike; a diamond's corners
  // point along the text and across it
  const levelMark = (y, t) => {
    if (y.round) return true;
    if (y.nv !== 3 && y.nv !== 4) return false;
    const v = ring(y.v), n = v.length, e = v.map((q, i) => Math.hypot(v[(i + 1) % n][0] - q[0], v[(i + 1) % n][1] - q[1]));
    const along = (p, q) => Math.abs((q[0] - p[0]) * t.u[0] + (q[1] - p[1]) * t.u[1]) / (Math.hypot(q[0] - p[0], q[1] - p[1]) || 1);
    if (n === 3) {
      const k = [0, 1, 2].find((i) => along(v[i], v[(i + 1) % 3]) > 0.98); if (k === undefined) return false;
      const e1 = e[(k + 1) % 3], e2 = e[(k + 2) % 3]; if (Math.max(e1, e2) > 1.3 * Math.min(e1, e2)) return false;
    } else {
      if (Math.max(...e) > 1.6 * Math.min(...e)) return false;
      const d1 = along(v[0], v[2]), d2 = along(v[1], v[3]);
      if (Math.max(d1, d2) < 0.97 || Math.min(d1, d2) > 0.25) return false;
    }
    // long lines ending at its corners: at most the level line (one or two pieces in line); more is a corner of the drawing
    const att = [];
    for (const q of v) for (const s of near(q[0] - 1.5, q[1] - 1.5, q[0] + 1.5, q[1] + 1.5)) {
      if (!s.straight || s.len <= 1.5 * y.size || y.members.includes(s) || att.includes(s)) continue;
      if (Math.min(Math.hypot(s.a[0] - q[0], s.a[1] - q[1]), Math.hypot(s.b[0] - q[0], s.b[1] - q[1])) <= 1.5) att.push(s);
    }
    return att.length <= 2 && att.every((s) => Math.abs(s.ux * att[0].ux + s.uy * att[0].uy) > 0.998);
  };
  for (const t of T) {
    if (t.h < MIN_TEXT || !LEVEL_RE.test(t.s)) continue;
    const h = t.h, r = 6.5 * h;

    for (const y of shapesIn([t.bb[0] - r, t.bb[1] - r, t.bb[2] + r, t.bb[3] + r], 4.2 * h)) if (y.size >= 0.3 * h && boxGap(y.bb, t.bb) <= 2.5 * h && levelMark(y, t)) { y.h = h; y.holds = t.cx > y.bb[0] && t.cx < y.bb[2] && t.cy > y.bb[1] && t.cy < y.bb[3]; y.tiny = y.size < 0.75 * h; symbol(y, "level"); }
    // the line under the text: from its mark, or with a free end; a floor or slab line under the text touches neither
    const near2 = syms.filter((y) => y.kind === "level" && boxGap(y.bb, t.bb) <= 2.5 * h); // its marks, also those another text found first
    const byMark = (s) => near2.some((y) => segDist(y.cx, y.cy, s.a, s.b) <= 0.5 * y.size || y.members.some((m) => Math.min(polyDist(s.a[0], s.a[1], m.pts), polyDist(s.b[0], s.b[1], m.pts)) <= 1.5));
    for (const s of near(t.bb[0] - h, t.bb[1] - h, t.bb[2] + h, t.bb[3] + h)) {
      if (!s.straight || s.an || Math.abs(s.ux * t.u[0] + s.uy * t.u[1]) < 0.999) continue;
      const ya = fy(t, s.a), yb = fy(t, s.b), xa = fx(t, s.a), xb = fx(t, s.b);
      if (!free(s.a, [s]) && !free(s.b, [s]) && !byMark(s)) continue;
      if (Math.max(ya, yb) <= 0.35 * h && Math.min(ya, yb) >= -1.0 * h && Math.max(xa, xb) >= -0.5 * h && Math.min(xa, xb) <= t.W + 0.5 * h) { mark(s); anchors.push(s); s.level = true; s.hh = h; s.home = [t.bb[0] - 3 * h, t.bb[1] - 3 * h, t.bb[2] + 3 * h, t.bb[3] + 3 * h]; kinds.level++; }
    }
  }
  // 3. small shapes of the symbol's color touching it (the arrow of a section head), and short lines inside a bubble
  why = "part";
  for (const y of syms.slice()) {
    const tol = Math.max(1, 0.1 * y.size), lim = [y.bb[0] - tol, y.bb[1] - tol, y.bb[2] + tol, y.bb[3] + tol];
    for (const s of near(lim[0] - y.size, lim[1] - y.size, lim[2] + y.size, lim[3] + y.size)) {
      if (s.an || boxGap(s.bb, y.bb) > tol) continue;
      if (!s.straight && (s.closed || s.p.f) && s.size <= 1.2 * y.size && s.size >= 0.2 * y.size && s.p.col === y.col && (y.round || y.kind === "level")) mark(s);
      else if (s.straight && y.round && y.kind === "level" && s.len <= 1.8 * y.size && Math.hypot((s.a[0] + s.b[0]) / 2 - y.cx, (s.a[1] + s.b[1]) / 2 - y.cy) <= 0.3 * y.size && segDist(y.cx, y.cy, s.a, s.b) <= 0.15 * y.size) mark(s); // the cross of a height mark, past its circle
      else if (s.straight && (y.kind === "bubble" || y.round) && s.len <= 1.05 * y.size && within(s.bb, lim) && (!y.round || [s.a, s.b].every((e) => Math.hypot(e[0] - y.cx, e[1] - y.cy) <= 0.5 * y.size + tol))) mark(s);
    }
    // the arrow of a section or elevation head: pieces joined to the circle, close around it
    if (y.kind !== "bubble" || !y.round) continue;
    const S0 = y.size, ext = [y.bb[0] - 0.5 * S0, y.bb[1] - 0.5 * S0, y.bb[2] + 0.5 * S0, y.bb[3] + 0.5 * S0], got = y.members.slice();
    const pool = near(ext[0], ext[1], ext[2], ext[3]).filter((s) => !s.an && !s.closed && s.len >= 0.1 * S0 && within(s.bb, ext)), add = [];
    for (let more = true; more && add.length <= 12;) {
      more = false;
      for (const s of pool) if (!got.includes(s) && [s.a, s.b].some((e) => got.some((g) => polyDist(e[0], e[1], g.pts) <= tol))) { got.push(s); add.push(s); more = true; }
    }
    if (add.length <= 12) for (const s of add) mark(s); // more is a drawing (a fixture) touching the circle
  }
  // 4. lines starting at a symbol: axes (pointing at a bubble's center), section lines, level lines (through a corner of the mark)
  why = "anchor";
  for (const y of syms) {
    if (y.kind === "level" && (y.round || y.tiny || y.holds)) continue; // a height mark (circle with a cross) has no line of its own, the dot of a leader neither
    if (y.kind === "bubble" && !y.round) continue; // a tag in a box has none either: axes and section lines start at circles
    const S0 = y.size, tol = Math.max(1.5, 0.12 * S0);
    const dist = (q) => Math.min(...y.members.map((m) => polyDist(q[0], q[1], m.pts)));
    const far = y.round ? 0.6 * S0 : tol; // an axis may start a little away from its bubble, in line with its center
    for (const s of near(y.bb[0] - far, y.bb[1] - far, y.bb[2] + far, y.bb[3] + far)) {
      if (!s.straight || s.an) continue;
      let hit = false;
      const d0 = Math.min(dist(s.a), dist(s.b)), off = Math.abs((y.cx - s.a[0]) * s.uy - (y.cy - s.a[1]) * s.ux);
      if (d0 <= tol) hit = !y.round || off <= 0.3 * S0;
      else if (y.round && d0 <= far && off <= 0.08 * S0) { const r = (q) => Math.hypot(q[0] - y.cx, q[1] - y.cy); hit = Math.max(r(s.a), r(s.b)) > 0.5 * S0 + s.len * 0.9; }
      if (!hit && y.kind === "level" && !y.round && s.len >= S0) hit = y.v.some((q) => segDist(q[0], q[1], s.a, s.b) <= tol);
      if (hit) { src = y.members[0]; mark(s); src = null; anchors.push(s); if (y.kind === "level") { s.level = true; s.hh = y.h; } s.home = [y.bb[0] - 2 * S0, y.bb[1] - 2 * S0, y.bb[2] + 2 * S0, y.bb[3] + 2 * S0]; kinds.line++; }
    }
  }
  // 4b. section cuts: a short thick bar by the section's letter (A, B', A1...) and the thin line leaving its end.
  // The bar is a narrow four-sided shape (a fill or its outline; some PDFs fill its box through a clip) or a thick stroke.
  why = "cut";
  const cutLines = [];
  const axis = (v) => { let best = null, bl = 0; for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) { const dx = v[j][0] - v[i][0], dy = v[j][1] - v[i][1], l = Math.hypot(dx, dy); if (!best || Math.abs(l - sides(v)[1]) < Math.abs(bl - sides(v)[1])) { best = [dx / l, dy / l]; bl = l; } } return best; }; // direction of the long sides
  const sides = (v) => { const d = []; for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) d.push(Math.hypot(v[i][0] - v[j][0], v[i][1] - v[j][1])); d.sort((a, b) => a - b); return [d[0], d[2]]; }; // a rectangle's width and length
  for (const t of T) {
    if (t.h < MIN_TEXT || t.held || !CUT_RE.test(t.s)) continue; // a tag's letters (T1 in a bubble) name no cut
    const h = t.h, r = 1.2 * h, bars = [];
    const cand = near(t.bb[0] - r, t.bb[1] - r, t.bb[2] + r, t.bb[3] + r).filter((b) => !b.an && boxGap(b.bb, t.bb) <= r);
    const narrow = (v) => { const [W, L] = sides(v); return L >= 0.4 * h && L <= 4 * h && W <= 0.45 * L && W >= 0.06 * h ? L : 0; };
    for (const b of cand) {
      if (!b.straight && b.p.f && b.pts.length >= 4 && b.pts.length <= 6) { const y = shape([b]), L = y.nv === 4 && narrow(y.v); if (L) bars.push({ members: [b], v: y.v, bb: y.bb, L, ax: axis(y.v) }); }
      else if (b.straight && b.p.s && b.p.lw >= Math.max(2.5, 0.12 * h) && b.len >= 0.4 * h && b.len <= 4 * h) bars.push({ members: [b], v: [b.a, b.b], bb: b.bb, L: b.len, ax: [b.ux, b.uy] });
    }
    for (const y of loops(cand.filter((b) => b.straight && b.len <= 4 * h))) { const L = y.nv === 4 && narrow(y.v); if (L) bars.push({ members: y.members, v: y.v, bb: y.bb, L, ax: axis(y.v) }); }
    for (const bar of bars) {
      if (bar.members.some((m) => m.an)) continue;
      const L = bar.L, tol = Math.max(1.5, 0.08 * L), box = [bar.bb[0] - tol, bar.bb[1] - tol, bar.bb[2] + tol, bar.bb[3] + tol];
      const lines = near(box[0], box[1], box[2], box[3]).filter((s) => !bar.members.includes(s) && !s.an);
      const thin = lines.filter((s) => s.straight && s.len >= L && !within(s.bb, box) && bar.v.some((q) => Math.min(Math.hypot(s.a[0] - q[0], s.a[1] - q[1]), Math.hypot(s.b[0] - q[0], s.b[1] - q[1])) <= tol));
      // one line (maybe drawn twice), across the bar; nothing else touches the bar (a wall drawn thick meets other walls)
      if (!thin.length || !thin.every((s) => dupOf(s, thin[0])) || Math.abs(thin[0].ux * bar.ax[0] + thin[0].uy * bar.ax[1]) > 0.35) continue;
      const poly = bar.v.length === 4 ? ring(bar.v) : bar.v;
      const edge = (q) => poly.some((c, i) => segDist(q[0], q[1], c, poly[(i + 1) % poly.length]) <= tol);
      const touch = lines.filter((s) => s.straight && !thin.includes(s) && !within(s.bb, box) && (edge(s.a) || edge(s.b))); // lines ending at it (lines passing by are drawing under it)
      if (touch.length) continue;
      for (const m of bar.members) mark(m);
      kinds.line++;
      const col = bar.members[0].p.col;
      for (const s of lines) if (within(s.bb, box) && s.size <= L + 2 * tol && (s.p.col === col || s.p.f)) mark(s); // its outline, its fill
      for (const s of thin) { mark(s); anchors.push(s); cutLines.push(s); s.home = [bar.bb[0] - 2 * L, bar.bb[1] - 2 * L, bar.bb[2] + 2 * L, bar.bb[3] + 2 * L]; }
    }
  }
  // a stepped cut bends by a letter of its own (A1 ... A2): the piece joined to the cut line there
  const cutTexts = T.filter((t) => t.h >= MIN_TEXT && CUT_RE.test(t.s));
  for (const c of cutLines.slice()) for (const e of [c.a, c.b]) {
    if (!cutTexts.some((t) => boxGap([e[0], e[1], e[0], e[1]], t.bb) <= 1.5 * t.h)) continue;
    for (const n of near(e[0] - 1, e[1] - 1, e[0] + 1, e[1] + 1)) {
      if (n.an || !n.straight || !sameStyle(c, n) || Math.min(Math.hypot(n.a[0] - e[0], n.a[1] - e[1]), Math.hypot(n.b[0] - e[0], n.b[1] - e[1])) > 1) continue;
      mark(n); anchors.push(n); cutLines.push(n); n.home = c.home;
    }
  }
  // a level line may bend near its mark (an elbow): the lines joined end to end with it, same style, two joints at
  // most; a line across it only if it ends in a dot or arrowhead (a leader to the floor it measures)
  why = "elbow";
  const chainEnd = [];
  for (const a of anchors.filter((s) => s.level)) {
    const h = a.hh || 8;
    let front = [a];
    chainEnd.push([a, h]);
    for (let depth = 0; depth < 2 && front.length; depth++) {
      const next = [];
      for (const f of front) for (const e of [f.a, f.b]) for (const s of near(e[0] - 2, e[1] - 2, e[0] + 2, e[1] + 2)) {
        if (s.an || !s.straight || !sameStyle(f, s)) continue;
        const da = Math.hypot(s.a[0] - e[0], s.a[1] - e[1]), db = Math.hypot(s.b[0] - e[0], s.b[1] - e[1]);
        if (Math.min(da, db) > 1) continue;
        const tm = termAt(da < db ? s.b : s.a, h, s);
        if (!tm.length && (Math.abs(s.ux * f.ux + s.uy * f.uy) < 0.3 || (depth && s.len > 8 * h))) continue; // a line across it, or a long one past a bend: the drawing
        src = f; mark(s); src = null; anchors.push(s); next.push(s); s.home = f.home; s.hh = h; kinds.line++;
        chainEnd.push([s, h]);
      }
      front = next;
    }
  }
  why = "term";
  for (const [s, h] of chainEnd) for (const e of [s.a, s.b]) for (const d of termAt(e, h, s)) mark(d);
  // 4c. leaders and slope arrows: a line leaving a text (from its end, or running under it) that ends, maybe after
  // one or two bends, in a dot or an arrowhead. Its start and its bends touch nothing else: a line of the drawing
  // meets other lines at its ends.
  why = "leader";
  if (!opt.levelsOnly) for (const t of T) {
    if (t.h < MIN_TEXT) continue;
    const h = t.h, g = 0.6 * h, pt = (q) => [q[0], q[1], q[0], q[1]];
    for (const s of near(t.bb[0] - g, t.bb[1] - g, t.bb[2] + g, t.bb[3] + g)) {
      if (!s.straight || s.an || s.len > 25 * h || s.len < 0.8 * h) continue;
      const ga = boxGap(pt(s.a), t.bb), gb = boxGap(pt(s.b), t.bb), starts = []; // [far end, near end]
      if (ga <= g && gb > ga + h) starts.push([s.b, s.a]);
      else if (gb <= g && ga > gb + h) starts.push([s.a, s.b]);
      else if (Math.abs(s.ux * t.u[0] + s.uy * t.u[1]) > 0.999) { // under the text, along it
        const ya = fy(t, s.a), yb = fy(t, s.b), xa = fx(t, s.a), xb = fx(t, s.b);
        if (Math.max(ya, yb) <= 0.2 * h && Math.min(ya, yb) >= -0.8 * h && Math.min(xa, xb) <= 0.5 * t.W && Math.max(xa, xb) >= 0.5 * t.W) starts.push([s.a, s.b], [s.b, s.a]);
      }
      for (const [e0, e1] of starts) {
        if (!free(e1, [s])) continue;
        // depth-first along the bends: [lines, far end], three lines at most
        const stack = [[[s], e0]];
        let got = null;
        while (stack.length) {
          const [chain, e] = stack.pop(), last = chain[chain.length - 1], tm = termAt(e, h, last);
          if (tm.length) { got = [chain, tm]; break; }
          if (chain.length >= 3) continue;
          for (const n of near(e[0] - 1, e[1] - 1, e[0] + 1, e[1] + 1)) {
            if (n.an || !n.straight || chain.includes(n) || chain.some((l) => dupOf(n, l)) || !sameStyle(last, n) || n.len > 25 * h) continue;
            const da = Math.hypot(n.a[0] - e[0], n.a[1] - e[1]), db = Math.hypot(n.b[0] - e[0], n.b[1] - e[1]);
            if (Math.min(da, db) <= 1 && free(e, [last, n])) stack.push([chain.concat([n]), da < db ? n.b : n.a]);
          }
        }
        if (!got) continue;
        for (const x of got[0]) { mark(x); for (const n of near(x.bb[0] - 1, x.bb[1] - 1, x.bb[2] + 1, x.bb[3] + 1)) if (dupOf(n, x)) mark(n); }
        why = "term"; for (const d of got[1]) mark(d); why = "leader";
        kinds.line++;
        break;
      }
    }
  }
  // 5. the rest of those lines: same line, same style (dashes drawn one by one), up to a gap
  why = "collinear";
  const lines = new Map(), DEG = Math.PI / 180, NB = Math.round(180 / 0.25);
  const lineKey = (s) => { let th = Math.atan2(s.uy, s.ux); if (th < 0) th += Math.PI; if (th >= Math.PI - 0.125 * DEG) th -= Math.PI; return [th, -s.a[0] * Math.sin(th) + s.a[1] * Math.cos(th)]; };
  for (const s of subs) if (s.straight && s.p.s) { const [th, rho] = lineKey(s); s.th = th; s.rho = rho; const k = Math.round(th / (0.25 * DEG)) * 1e6 + Math.round(rho / 1.5); let l = lines.get(k); if (!l) lines.set(k, l = []); l.push(s); }
  let ext = 100; for (const s of subs) ext = Math.max(ext, s.bb[2], s.bb[3]);
  const maxGap = 0.025 * ext;
  for (const a of anchors) {
    if (a.th === undefined) continue;
    src = a;
    const ka = Math.round(a.th / (0.25 * DEG)), ko = Math.round(a.rho / 1.5), cand = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      let kk = ka + i, flip = 1; if (kk < 0) { kk += NB; flip = -1; } else if (kk >= NB) { kk -= NB; flip = -1; }
      for (const s of lines.get(kk * 1e6 + flip * ko + j) || []) if (s !== a && sameStyle(a, s) && Math.abs(Math.sin(s.th - a.th)) < 0.45 * DEG && Math.abs(Math.abs(s.rho) - Math.abs(a.rho)) <= Math.max(1, a.p.lw)) cand.push(s);
    }
    if (!cand.length) continue;
    const pos = (q) => q[0] * a.ux + q[1] * a.uy, span = (s) => { const p = pos(s.a), q = pos(s.b); return [Math.min(p, q), Math.max(p, q)]; };
    const all = cand.map((s) => ({ s, r: span(s) })).sort((x, y) => x.r[0] - y.r[0]);
    let [lo, hi] = span(a);
    // a level line goes on only through loose pieces (its dashes): a piece of a floor or slab meets walls at its ends
    const own = new Set(cand.concat([a])), loose = (o) => !a.level || [o.s.a, o.s.b].every((q) => near(q[0] - 1, q[1] - 1, q[0] + 1, q[1] + 1).every((n) => n.size < 1 || own.has(n) || n.an || polyDist(q[0], q[1], n.pts) > 1));
    // pieces that go on past the ends: a line lying on top of an axis is drawing, not the axis, unless it
    // is by the symbol (the bar of a level head drawn over the level line)
    for (const o of all) if (!o.s.an && a.home && o.r[0] >= lo && o.r[1] <= hi && within(o.s.bb, a.home)) { mark(o.s); kinds.line++; }
    for (const o of all) if (o.r[0] >= lo - 1 && o.r[1] > hi + 0.5 && o.r[0] - hi <= maxGap && loose(o)) { hi = o.r[1]; if (!o.s.an) { mark(o.s); kinds.line++; } }
    for (const o of all.slice().sort((x, y) => y.r[1] - x.r[1])) if (o.r[1] <= hi + 1 && o.r[0] < lo - 0.5 && lo - o.r[1] <= maxGap && loose(o)) { lo = o.r[0]; if (!o.s.an) { mark(o.s); kinds.line++; } }
  }
  if (opt.noDims) return debug ? { marks, n: nMarked, kinds, subs, T, dbg: [] } : { marks, n: nMarked, kinds };
  // 6. dimensions: a line parallel to a number, just under it, with ticks, dots or arrows centered on its
  // ends or extension lines crossing them. Its length must agree with the number at the scale that most
  // dimensions of the sheet agree on (a viewport's scale), which leaves out furniture and walls near a number.
  const val = (s) => { const m = s.replace(",", ".").match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
  // ends of a dimension line: ticks, dots or arrows centered on the line near its end, or extension lines
  // crossing it there and stopping just past it. The line itself may run a little past them, so the length
  // the number measures is the distance between the two terminators.
  // an extension line stands free: no other line meets its ends at an angle (a wall's ends meet other walls)
  const loose = (d, c, h) => {
    for (const q of [d.a, d.b]) for (const s of near(q[0] - 1, q[1] - 1, q[0] + 1, q[1] + 1)) {
      if (s === d || s === c || !s.straight || Math.abs(s.ux * d.ux + s.uy * d.uy) > 0.9) continue;
      const k = Math.abs(s.ux * c.ux + s.uy * c.uy); if (s.len <= 2.5 * h && k > 0.55 && k < 0.85) continue; // a tick
      if (Math.min(Math.hypot(s.a[0] - q[0], s.a[1] - q[1]), Math.hypot(s.b[0] - q[0], s.b[1] - q[1])) <= 1) return false;
    }
    return true;
  };
  const terminators = (c, h) => {
    const tol = Math.max(1.5, 0.3 * h), Z = Math.min(1.2 * h, 0.3 * c.len), nx = -c.uy, ny = c.ux, found = [], pos = [];
    const along = (q) => (q[0] - c.a[0]) * c.ux + (q[1] - c.a[1]) * c.uy, perp = (q) => (q[0] - c.a[0]) * nx + (q[1] - c.a[1]) * ny;
    let strong = 0, cross = 0;
    for (const [e, sgn] of [[c.a, 1], [c.b, -1]]) {
      let st = false, ex = false; const at = [];
      const inward = (u) => (sgn > 0 ? u : c.len - u);
      for (const d of near(e[0] - 3 * h, e[1] - 3 * h, e[0] + 3 * h, e[1] + 3 * h)) {
        if (d === c) continue; // a line already taken (an axis) can still end a dimension
        if (d.straight) {
          const cos = Math.abs(d.ux * c.ux + d.uy * c.uy), mid = [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2];
          if (d.len <= 2.5 * h && cos > 0.55 && cos < 0.85) {
            const u = along(mid), w = inward(u);
            if (Math.abs(perp(mid)) <= 0.25 * d.len + tol && w >= -tol - 0.25 * d.len && w <= Z) { found.push(d); st = true; at.push(u); }
          } else if (cos < 0.035 && d.p.col === c.p.col && d.len <= 8 * h) { // a long line there is a wall the dimension measures to
            const sa = perp(d.a), sb = perp(d.b);
            if (sa * sb >= 0) continue;
            const q = [d.a[0] + (d.b[0] - d.a[0]) * sa / (sa - sb), d.a[1] + (d.b[1] - d.a[1]) * sa / (sa - sb)], u = along(q), w = inward(u);
            const over = Math.min(Math.abs(sa), Math.abs(sb));
            if (w >= -tol && w <= Z && over >= 0.1 * h && over <= 2.5 * h && loose(d, c, h)) { found.push(d); ex = true; at.push(u); }
          }
        } else if ((d.closed || d.p.f) && d.size <= 1.5 * h) {
          const m = [(d.bb[0] + d.bb[2]) / 2, (d.bb[1] + d.bb[3]) / 2], u = along(m), w = inward(u);
          if (Math.abs(perp(m)) <= Math.max(tol, 0.6 * d.size) && w >= -tol - 0.5 * d.size && w <= Z) { found.push(d); st = true; at.push(d.curve || d.pts.length > 6 ? u : sgn > 0 ? Math.max(0, u - 0.5 * d.size) : Math.min(c.len, u + 0.5 * d.size)); } // a dot sits on the extension line, an arrow's tip touches it
        }
      }
      strong += st; cross += ex;
      if (at.length) { at.sort((x, y) => x - y); pos.push(at[at.length >> 1]); }
    }
    if (!(strong || cross === 2)) return null;
    return { f: found, len: pos.length === 2 && pos[1] - pos[0] > 0.5 * c.len ? pos[1] - pos[0] : c.len };
  };
  const dims = [], dbg = [];
  for (const t of T) {
    if (t.h < MIN_TEXT || !DIM_RE.test(t.s)) continue;
    const v = val(t.s); if (!(v > 0)) continue;
    const h = t.h, r = 2 * h, cs = [];
    for (const c of near(t.bb[0] - r, t.bb[1] - r, t.bb[2] + r, t.bb[3] + r)) {
      if (!c.straight || Math.abs(c.ux * t.u[0] + c.uy * t.u[1]) < 0.9994) continue;
      const ya = fy(t, c.a), yb = fy(t, c.b), xa = fx(t, c.a), xb = fx(t, c.b);
      if (Math.max(ya, yb) > 0.8 * t.Hh || Math.min(ya, yb) < -1.8 * h || Math.max(xa, xb) < -0.5 * h || Math.min(xa, xb) > t.W + 0.5 * h) continue;
      cs.push({ c, gap: Math.abs((ya + yb) / 2 + 0.25 * h) });
    }
    cs.sort((a, b) => a.gap - b.gap);
    let nf = 0;
    for (const { c } of cs.slice(0, 4)) { const r = terminators(c, h); if (r) { nf++; dims.push({ t, c, v, len: r.len, k: v / r.len, f: r.f }); } }
    if (debug) dbg.push({ s: t.s, h: +t.h.toFixed(1), at: t.bb.map(Math.round), u: t.u.map((q) => +q.toFixed(3)), cand: cs.length, withTerm: nf, lens: cs.slice(0, 4).map((o) => +o.c.len.toFixed(1)), ks: dims.filter((d) => d.t === t).map((d) => +d.k.toFixed(3)) });
  }
  // scales: ratios (number per pixel) shared by at least three numbers; a number with a decimal part or
  // under 20 says little about the scale on its own
  const ref = dims.filter((d) => d.v >= 20).map((d) => d.k).sort((a, b) => a - b);
  const count = (lo, hi) => { let a = 0, b = ref.length; while (a < b) { const m = (a + b) >> 1; if (ref[m] < lo) a = m + 1; else b = m; } let n = 0; for (let i = a; i < ref.length && ref[i] <= hi; i++) n++; return n; };
  const taken = new Set();
  why = "dim";
  for (const d of dims) {
    if (taken.has(d.t)) continue;
    const e = Math.max(0.55, 0.012 * d.v), lo = (d.v - e) / d.len, hi = (d.v + e) / d.len;
    if (count(lo, hi) - (d.v >= 20 ? 1 : 0) < 2) continue;
    taken.add(d.t); mark(d.c); kinds.dim++;
    why = "term"; for (const x of d.f) mark(x); why = "dim";
  }
  return debug ? { marks, n: nMarked, kinds, subs, T, dbg } : { marks, n: nMarked, kinds };
}

// fixed: draw the overview with the fill decisions already in D.keepFills (after reconcileFills)
// noHatch: leave hatch out even when the switch is on (the Plano A / Plano B views)
async function renderSource(D, T, w, h, withText = false, fixed = false, noHatch = false, all = false) {
  const hatch = S.hatch && !noHatch, showAnnot = S.annot || all;
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  // annotation off: letters are neither drawn nor copied (PDF text drawn as lines, as some CAD programs export it, stays)
  const prepText = () => { if (withText) c.text = captureText(ctx); if (!showAnnot) ctx.fillText = ctx.strokeText = () => {}; };
  prepText();
  if (D.kind === "pdf") {
    const page = await D.pdf.getPage(D.page);
    const vp = page.getViewport({ scale: D.scale }), overview = T === I;
    const minPx = HATCH_MIN_MM * 72 / 25.4 * D.scale * scaleOf(T);
    const hide = showAnnot ? [] : D.ocAnnot || [];
    const oc = hide.length ? D.pdf.getOptionalContentConfig().then((cfg) => { for (const id of hide) cfg.setVisibility(id, false); return cfg; }) : undefined;
    // annotation off: also the bubbles, dimensions and level marks found by their shape;
    // hatch off: also the hatch printed as lines
    const hidden = hide.join(",");
    const am = showAnnot ? null : (await pdfAnnots(D, oc, hidden)).marks, hm = hatch ? null : (await pdfHatch(D, oc, hidden)).marks;
    let marks = am || hm;
    if (am && hm && hm.size) { marks = new Map(am); for (const [k, v] of hm) marks.set(k, new Set([...(am.get(k) || []), ...v])); }
    const draw = async (keep) => {
      const fills = watchFills(ctx, minPx, !hatch, keep, inv(T));
      if (marks && marks.size) tapFilter(ctx, marks);
      const task = page.render({ canvasContext: ctx, viewport: vp, transform: T, optionalContentConfigPromise: oc });
      liveTasks.push(task);
      try { await task.promise; } finally { liveTasks = liveTasks.filter((t) => t !== task); untap(ctx); }
      return fills;
    };
    if (overview && !hatch && !fixed) {
      // First pass without the large dark fills, to see which of them have no line along their edge.
      // Those are shapes on their own (a pillar drawn only as a black fill): the page is drawn again with
      // them, by pdf.js itself, so each keeps its place, clip and painting order.
      const fills = await draw(null);
      D.fills = loneFills(ctx, fills.skipped, D.scale * 72 / 25.4); D.keepFills = keepMap(D.fills);
      if (D.keepFills.size) {
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        prepText();
        await draw(D.keepFills);
      }
      for (const f of D.fills) f.drawn = f.lone;
    } else await draw(D.keepFills || new Map());
  } else {
    if (!showAnnot) dxfAnnots(D);
    if (!hatch) dxfHatch(D);
    drawPrims(ctx, D, T, null, false, hatch, all);
  }
  return c;
}

// Copy every letter drawn into a separate canvas, so that inside the box of a text that only
// changed typeface the changes are ignored where letters are drawn and nowhere else
// (a line or symbol under the label still counts).
function captureText(ctx) {
  const P = CanvasRenderingContext2D.prototype, t = document.createElement("canvas");
  t.width = ctx.canvas.width; t.height = ctx.canvas.height;
  const x = t.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, t.width, t.height);
  const copy = (src, how, a) => {
    x.setTransform(src.getTransform()); x.font = src.font; x.textAlign = src.textAlign; x.textBaseline = src.textBaseline; x.direction = src.direction;
    x.fillStyle = x.strokeStyle = "#000"; x.lineWidth = src.lineWidth; x[how](...a);
  };
  ctx.fillText = function (...a) { copy(this, "fillText", a); return P.fillText.apply(this, a); };
  ctx.strokeText = function (...a) { copy(this, "strokeText", a); return P.strokeText.apply(this, a); };
  return t;
}

// A PDF has no hatch entity: hatch, wall poché and filled regions arrive as filled paths.
// Count the dark ones at least minPx long and, when skip is set, leave them out (except the keys in keep).
// Light fills never count as ink, and lines and text are not fills, so they are kept.
// Without keep, each left-out fill is returned with its outline in canvas pixels and the clip that
// was active, so loneFills() can check whether a line runs along its edge.
// A fill is identified by its box in the path's own units plus its box in overview pixels (Ti maps
// this canvas back to the overview), so the same shape placed twice with another transform is
// still two fills, at every zoom.
function watchFills(ctx, minPx, skip, keep, Ti = I) {
  const P = CanvasRenderingContext2D.prototype, st = { n: 0, skipped: [] }, record = skip && !keep;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, polys = [], cur = null, m = null, clip = null;
  const clips = [];
  const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  const dev = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  const dark = (c) => {
    if (typeof c !== "string") return true; // pattern or gradient fill
    let r, g, b;
    if (c[0] === "#") { r = parseInt(c.slice(1, 3), 16); g = parseInt(c.slice(3, 5), 16); b = parseInt(c.slice(5, 7), 16); }
    else { const m = c.match(/[\d.]+/g); if (!m) return true; [r, g, b] = m.map(Number); if (m.length > 3 && +m[3] < 0.3) return false; }
    return 0.299 * r + 0.587 * g + 0.114 * b < INK_THRESHOLD;
  };
  // box of the current path in canvas pixels (or, with pre, in the pixels pre maps them to)
  const box = (c, pre = null) => {
    let t = c.getTransform(); let a = Infinity, b = Infinity, cc = -Infinity, d = -Infinity;
    if (pre) { const q = mul(pre, [t.a, t.b, t.c, t.d, t.e, t.f]); t = { a: q[0], b: q[1], c: q[2], d: q[3], e: q[4], f: q[5] }; }
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
      const X = t.a * x + t.c * y + t.e, Y = t.b * x + t.d * y + t.f;
      a = Math.min(a, X); cc = Math.max(cc, X); b = Math.min(b, Y); d = Math.max(d, Y);
    }
    return [a, b, cc, d];
  };
  ctx.beginPath = function () { x0 = y0 = Infinity; x1 = y1 = -Infinity; polys = []; cur = null; return P.beginPath.call(this); };
  ctx.moveTo = function (x, y) { add(x, y); if (record) { m = this.getTransform(); cur = [dev(x, y)]; polys.push(cur); } return P.moveTo.call(this, x, y); };
  ctx.lineTo = function (x, y) { add(x, y); if (cur) cur.push(dev(x, y)); return P.lineTo.call(this, x, y); };
  ctx.bezierCurveTo = function (a, b, c, d, x, y) {
    add(a, b); add(c, d); add(x, y);
    if (cur) {
      const [px, py] = cur[cur.length - 1], c1 = dev(a, b), c2 = dev(c, d), e = dev(x, y);
      for (let t = 1; t <= 8; t++) { const u = t / 8, v = 1 - u; cur.push([v * v * v * px + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * e[0], v * v * v * py + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * e[1]]); }
    }
    return P.bezierCurveTo.call(this, a, b, c, d, x, y);
  };
  ctx.rect = function (x, y, w, h) {
    add(x, y); add(x + w, y + h);
    if (record) { m = this.getTransform(); polys.push([dev(x, y), dev(x + w, y), dev(x + w, y + h), dev(x, y + h), dev(x, y)]); cur = null; }
    return P.rect.call(this, x, y, w, h);
  };
  ctx.closePath = function () { if (cur && cur.length) cur.push(cur[0]); return P.closePath.call(this); };
  if (record) {
    // follow the clip (as a box) so that only the visible part of an edge is checked
    ctx.save = function () { clips.push(clip); return P.save.call(this); };
    ctx.restore = function () { if (clips.length) clip = clips.pop(); return P.restore.call(this); };
    ctx.clip = function (...a) {
      if (!(a[0] instanceof Path2D) && x0 !== Infinity) { const r = box(this); clip = clip ? [Math.max(clip[0], r[0]), Math.max(clip[1], r[1]), Math.min(clip[2], r[2]), Math.min(clip[3], r[3])] : r; }
      return P.clip.apply(this, a);
    };
  } else { delete ctx.save; delete ctx.restore; delete ctx.clip; }
  ctx.fill = function (...args) {
    if (!(args[0] instanceof Path2D) && x0 !== Infinity && dark(this.fillStyle)) {
      const r = box(this);
      if (Math.max(r[2] - r[0], r[3] - r[1]) >= minPx) {
        st.n++;
        if (skip) {
          const key = [x0, y0, x1, y1].map((v) => v.toFixed(2)).join(",");
          // a fill closes its open subpaths, so their closing edge is checked too
          if (record) { st.skipped.push({ key, ob: r, polys: polys.map((p) => p.length > 1 && (p[0][0] !== p[p.length - 1][0] || p[0][1] !== p[p.length - 1][1]) ? [...p, p[0]] : p), clip }); return; }
          const list = keep.get(key); if (!list) return;
          const o = box(this, Ti);
          if (!list.some((q) => Math.abs(q[0] - o[0]) < 1.5 && Math.abs(q[1] - o[1]) < 1.5 && Math.abs(q[2] - o[2]) < 1.5 && Math.abs(q[3] - o[3]) < 1.5)) return;
        }
      }
    }
    return P.fill.apply(this, args);
  };
  return st;
}
// A left-out fill with no line drawn along its edge is a shape on its own (for example a pillar
// drawn only as a black fill), not hatch or poché inside outlined walls: it is compared.
const LONE_EDGE = 0.75; // a fill with less than this share of its edge over other ink counts as lone
function inkNear(ctx) {
  const W = ctx.canvas.width, H = ctx.canvas.height, d = ctx.getImageData(0, 0, W, H).data;
  return (x, y) => {
    x = Math.round(x); y = Math.round(y);
    for (let yy = Math.max(0, y - 2); yy <= Math.min(H - 1, y + 2); yy++) for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) {
      const j = (yy * W + xx) * 4; if (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2] < INK_THRESHOLD) return true;
    }
    return false;
  };
}
// share of an outline (list of closed or open point lists, canvas px) that runs over ink, counting
// only what lies on the canvas and inside clip. The clip gets 1 px of slack: PDF writers often clip
// a fill to its own outline, which then lies on the clip border give or take rounding.
// An edge that is all clipped away counts as lone.
function edgeInk(near, polys, W, H, clip = null) {
  let len = 0; for (const P of polys) for (let i = 1; i < P.length; i++) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
  const step = Math.max(2, len / 400); let n = 0, hit = 0;
  for (const P of polys) for (let i = 1; i < P.length; i++) {
    const [ax, ay] = P[i - 1], [bx, by] = P[i], m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let j = 0; j < m; j++) {
      const x = ax + (bx - ax) * j / m, y = ay + (by - ay) * j / m;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (clip && (x < clip[0] - 1 || y < clip[1] - 1 || x > clip[2] + 1 || y > clip[3] + 1)) continue;
      n++; if (near(x, y)) hit++;
    }
  }
  return n ? hit / n : clip ? 0 : 1;
}
// A small compact solid fill (a column or pillar in plan) is an element, not hatch: it stays when
// hatch is off even with a line along its edge. DXF columns usually come outlined and PDF ones often
// not, so without this the same pillar was kept in one format and dropped in the other.
// Each outline (canvas px) must be compact (4πA/P² ≥ PILLAR_ROUND: square 0.79, 1:2 rectangle 0.70)
// and between PILLAR_MM[0] (side of an equal-area square) and PILLAR_MM[1] (longest side) on paper.
const PILLAR_ROUND = 0.62, PILLAR_MM = [1.2, 15];
function pillar(polys, pxPerMm) {
  const P = polys.filter((p) => p.length > 3);
  if (!P.length || P.length > 64) return false;
  return P.every((p) => {
    let a = 0, per = 0;
    for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; per += Math.hypot(r[0] - q[0], r[1] - q[1]); }
    a = Math.abs(a) / 2;
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]), big = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    return per > 0 && 4 * Math.PI * a / (per * per) >= PILLAR_ROUND && Math.sqrt(a) >= PILLAR_MM[0] * pxPerMm && big <= PILLAR_MM[1] * pxPerMm;
  });
}
// Left-out fills with their edge share e; lone (no line along the edge) ones and pillars are compared.
// lone0 is the plan's own decision; reconcileFills() may change lone to match the other plan.
function loneFills(ctx, list, pxPerMm) {
  if (!list.length) return [];
  const near = inkNear(ctx), W = ctx.canvas.width, H = ctx.canvas.height;
  return list.map((f) => { const e = edgeInk(near, f.polys, W, H, f.clip), pil = pillar(f.polys, pxPerMm), l = pil || e < LONE_EDGE; return { key: f.key, ob: f.ob, e, pil, lone0: l, lone: l }; });
}
// key -> overview boxes of the fills to draw
function keepMap(fills) {
  const keep = new Map();
  for (const f of fills) if (f.lone) { if (!keep.has(f.key)) keep.set(f.key, []); keep.get(f.key).push(f.ob); }
  return keep;
}
// The same wall can land just under the lone threshold in one delivery and just over it in the
// other, and would then be drawn in one plan only. Left-out fills at the same place in A and B
// (once aligned) get one decision, from their mean edge share. Plans whose decisions changed are
// drawn again. Returns false when a newer run took over.

// Drawing units from the DXF header ($INSUNITS), as millimetres per unit; null when not set.
function mmPerUnit(dxf) {
  const u = dxf.header && dxf.header["$INSUNITS"];
  return { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 7: 1e6, 9: 0.0254, 10: 914.4, 14: 100 }[u] || null;
}

// DXF -> list of primitives in world coordinates (times f)
function dxfPrims(dxf, f = 1) {
  const out = [];
  const layers = (dxf.tables && dxf.tables.layer && dxf.tables.layer.layers) || {};
  const hidden = (l) => { const L = layers[l]; return L && (L.visible === false || L.frozen === true); };
  const ap = (m, p) => apply(m, p.x, p.y);
  const arcPts = (cx, cy, r, a0, sweep) => { const n = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI * 2) * 96)); const pts = []; for (let i = 0; i <= n; i++) { const a = a0 + sweep * i / n; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); } return pts; };
  function polyWithBulge(vs, closed) {
    const pts = []; const n = vs.length;
    for (let i = 0; i < n; i++) {
      const p = vs[i], q = vs[(i + 1) % n];
      pts.push({ x: p.x, y: p.y });
      if (i === n - 1 && !closed) break;
      const b = p.bulge || 0;
      if (b && q) {
        const dx = q.x - p.x, dy = q.y - p.y, c = Math.hypot(dx, dy); if (!c) continue;
        const th = 4 * Math.atan(b), r = c / (2 * Math.sin(th / 2)), h = r * Math.cos(th / 2);
        const cx = (p.x + q.x) / 2 - dy / c * h, cy = (p.y + q.y) / 2 + dx / c * h;
        const a0 = Math.atan2(p.y - cy, p.x - cx);
        const arc = arcPts(cx, cy, Math.abs(r), a0, th); arc.shift(); arc.pop(); pts.push(...arc);
      }
    }
    if (closed && pts.length) pts.push({ ...pts[0] });
    return pts;
  }
  function bspline(e) {
    const cp = e.controlPoints || [], k = e.knotValues || [], d = e.degreeOfSplineCurve || 3;
    if (e.fitPoints && e.fitPoints.length > 1 && (!cp.length || !k.length)) return e.fitPoints;
    if (cp.length < 2 || k.length !== cp.length + d + 1) return cp;
    const lo = k[d], hi = k[cp.length], n = cp.length * 10, pts = [];
    for (let s = 0; s <= n; s++) {
      const t = Math.min(lo + (hi - lo) * s / n, hi - 1e-9);
      let i = d; while (i < cp.length - 1 && t >= k[i + 1]) i++;
      const v = []; for (let j = 0; j <= d; j++) v.push({ x: cp[i - d + j].x, y: cp[i - d + j].y });
      for (let r = 1; r <= d; r++) for (let j = d; j >= r; j--) {
        const den = k[i + 1 + j - r] - k[i - d + j]; const a = den ? (t - k[i - d + j]) / den : 0;
        v[j] = { x: (1 - a) * v[j - 1].x + a * v[j].x, y: (1 - a) * v[j - 1].y + a * v[j].y };
      }
      pts.push(v[d]);
    }
    return pts;
  }
  // \U+XXXX is how AutoCAD (and our own export) writes characters outside the drawing's code page
  const uni = (s) => (s || "").replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const cleanMtext = (s) => uni(s).replace(/\\P/g, "\n").replace(/\\[ACFHQTWfhcqtwpL][^;\\]*;?/g, "").replace(/\\[LlOoKk]/g, "").replace(/[{}]/g, "").replace(/%%[cC]/g, "Ø").replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±");
  const cleanText = (s) => uni(s).replace(/%%[cC]/g, "Ø").replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±").replace(/%%[uUoO]/g, "");

  // hatch boundary edges -> points, following ezdxf: clockwise arcs store 360° minus their angles
  function edgePts(ed) {
    const m = ed.m || {};
    if (ed.type === 1) return [{ x: m[10], y: m[20] }, { x: m[11], y: m[21] }];
    if (ed.type === 2 || ed.type === 3) {
      const ccw = m[73] !== 0, s = (m[50] || 0) * Math.PI / 180, en = (m[51] ?? 360) * Math.PI / 180;
      let a0, sw;
      if (ccw) { a0 = s; sw = en - s; if (sw <= 0) sw += Math.PI * 2; } else { a0 = -s; sw = s - en; if (sw >= 0) sw -= Math.PI * 2; }
      if (ed.type === 2) return arcPts(m[10], m[20], m[40], a0, sw);
      const mx = m[11], my = m[21], r = m[40] || 1, n = 64, pts = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + sw * i / n, p = Math.atan2(Math.sin(a) / r, Math.cos(a)), c = Math.cos(p), sn = Math.sin(p) * r;
        pts.push({ x: m[10] + c * mx - sn * my, y: m[20] + c * my + sn * mx });
      }
      return pts;
    }
    if (ed.type === 4) return bspline({ controlPoints: ed.cp, knotValues: ed.knots, degreeOfSplineCurve: ed.deg });
    return [];
  }

  const OCS = new Set(["INSERT", "ARC", "CIRCLE", "LWPOLYLINE", "POLYLINE", "SOLID", "TEXT", "HATCH"]);
  // lay: layer that entities on layer "0" take (the block's); pan: inside an annotation block or dimension
  const annL = new Map(), annotL = (l) => { let v = annL.get(l); if (v === undefined) annL.set(l, v = annotLayer(l)); return v; };
  function walk(ents, mp, depth, lay = null, pan = false) {
    if (depth > 12) return;
    for (const e of ents || []) {
      if (e.inPaperSpace || hidden(e.layer)) continue;
      const L = !e.layer || e.layer === "0" ? lay ?? e.layer : e.layer;
      const an = pan || annotL(L) || AXIS_LT.test(e.lineType || "") || (e.type === "INSERT" && annotBlock(e.name));
      const n0 = out.length;
      // entities with extrusion (0,0,-1) are drawn mirrored (common for mirrored blocks)
      const ez = e.extrusionDirection ? e.extrusionDirection.z : e.extrusionDirectionZ;
      const m = ez < 0 && OCS.has(e.type) ? mul(mp, [-1, 0, 0, 1, 0, 0]) : mp;
      const line = (pts, closed, fill) => { if (pts && pts.length > 1) out.push({ t: "p", pts: pts.map((p) => ap(m, p)), closed, fill }); };
      switch (e.type) {
        case "LINE": line(e.vertices); break;
        case "LWPOLYLINE": case "POLYLINE": if (e.vertices) line(polyWithBulge(e.vertices, !!e.shape), false); break;
        case "CIRCLE": line(arcPts(e.center.x, e.center.y, e.radius, 0, Math.PI * 2)); break;
        case "ARC": { const s = e.startAngle; let sw = e.endAngle - s; if (sw <= 0) sw += Math.PI * 2; line(arcPts(e.center.x, e.center.y, e.radius, s, sw)); break; }
        case "ELLIPSE": {
          const mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y, ra = Math.hypot(mx, my), rb = ra * e.axisRatio, rot = Math.atan2(my, mx);
          const s = e.startAngle || 0, en = e.endAngle == null ? Math.PI * 2 : e.endAngle; let sw = en - s; if (sw <= 0) sw += Math.PI * 2;
          const n = 96, pts = []; for (let i = 0; i <= n; i++) { const a = s + sw * i / n, x = ra * Math.cos(a), y = rb * Math.sin(a); pts.push({ x: e.center.x + x * Math.cos(rot) - y * Math.sin(rot), y: e.center.y + x * Math.sin(rot) + y * Math.cos(rot) }); }
          line(pts); break;
        }
        case "SPLINE": line(bspline(e)); break;
        case "SOLID": case "3DFACE": if (e.points && e.points.length >= 3) { const p = e.points; const q = p.length === 4 && e.type === "SOLID" ? [p[0], p[1], p[3], p[2]] : p; line([...q, q[0]], true, true); } break;
        case "TEXT": case "ATTRIB": {
          if (!e.text) break;
          const useEnd = (e.halign || e.valign) && e.endPoint;
          const p = useEnd ? e.endPoint : e.startPoint; if (!p) break;
          out.push({ t: "x", p: ap(m, p), h: (e.textHeight || 2.5) * scaleOf(m), rot: (e.rotation || 0) * Math.PI / 180 + Math.atan2(m[1], m[0]), s: cleanText(e.text), ha: [0, 1, 2, 0, 1, 0][e.halign || 0] ?? 0, va: e.valign || 0 });
          break;
        }
        case "MTEXT": {
          if (!e.text || !e.position) break;
          const a1 = e.attachmentPoint || 1;
          const rot = e.directionVector ? Math.atan2(e.directionVector.y, e.directionVector.x) : (e.rotation || 0) * Math.PI / 180;
          out.push({ t: "x", p: ap(m, e.position), h: (e.height || 2.5) * scaleOf(m), rot: rot + Math.atan2(m[1], m[0]), s: cleanMtext(e.text), ha: (a1 - 1) % 3, va: [3, 2, 1][Math.floor((a1 - 1) / 3)], multi: true });
          break;
        }
        case "INSERT": {
          const b = dxf.blocks && dxf.blocks[e.name]; if (!b || !e.position) break;
          const sx = e.xScale ?? 1, sy = e.yScale ?? 1, r = (e.rotation || 0) * Math.PI / 180, bp = b.position || { x: 0, y: 0 };
          const T = [Math.cos(r) * sx, Math.sin(r) * sx, -Math.sin(r) * sy, Math.cos(r) * sy, e.position.x, e.position.y];
          walk(b.entities, mul(m, mul(T, [1, 0, 0, 1, -bp.x, -bp.y])), depth + 1, L, an);
          break;
        }
        case "DIMENSION": { const b = dxf.blocks && dxf.blocks[e.block]; if (b) walk(b.entities, m, depth + 1, L, true); break; }
        case "HATCH": {
          const loops = [];
          for (const L of e.loops) {
            const pts = L.poly ? polyWithBulge(L.poly, true) : L.edges.flatMap(edgePts);
            if (pts.length > 2 && pts.every((p) => isFinite(p.x) && isFinite(p.y))) loops.push(pts.map((p) => ap(m, p)));
          }
          if (!loops.length) break;
          const o = ap(m, { x: 0, y: 0 }), vec = (x, y) => { const q = ap(m, { x, y }); return [q[0] - o[0], q[1] - o[1]]; };
          const lines = e.solid ? [] : e.lines.map((l) => { const a = l.a * Math.PI / 180; return { b: ap(m, { x: l.bx, y: l.by }), u: vec(Math.cos(a), Math.sin(a)), o: vec(l.ox, l.oy), d: l.d }; });
          const xs = loops.flat().map((p) => p[0]), ys = loops.flat().map((p) => p[1]);
          out.push({ t: "h", loops, solid: !lines.length, lines, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
          break;
        }
      }
      if (an && e.type !== "INSERT" && e.type !== "DIMENSION") for (let i = n0; i < out.length; i++) out[i].an = true;
    }
  }
  walk(dxf.entities, [f, 0, 0, f, 0, 0], 0);
  return out;
}

function primBounds(prims) {
  const xs = [], ys = [];
  for (const p of prims) {
    if (p.t === "h") continue; // the frame does not depend on whether hatch is drawn
    if (p.t === "p") for (const q of p.pts) { xs.push(q[0]); ys.push(q[1]); }
    else { xs.push(p.p[0]); ys.push(p.p[1]); }
  }
  if (!xs.length) return null;
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
  // trim far outliers (stray objects far from the sheet) without cutting a normal drawing
  let x0 = q(xs, 0.002), x1 = q(xs, 0.998), y0 = q(ys, 0.002), y1 = q(ys, 0.998);
  const w = x1 - x0 || 1, h = y1 - y0 || 1;
  x0 = Math.max(xs[0], x0 - w * 0.25); x1 = Math.min(xs[xs.length - 1], x1 + w * 0.25);
  y0 = Math.max(ys[0], y0 - h * 0.25); y1 = Math.min(ys[ys.length - 1], y1 + h * 0.25);
  return [x0, y0, x1, y1];
}

// Draw DXF primitives. World -> raster px uses D.bb/D.k/D.pad; T maps raster px -> canvas px.
// When `texts` is an array, each drawn text line's box (raster px corners) is pushed to it.
function drawPrims(ctx, D, T, texts, overview = false, hatch = S.hatch, all = false) {
  const { prims, bb, k, pad } = D, st = scaleOf(T), skip = (p) => !all && !shown(p);
  ctx.save();
  ctx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  ctx.strokeStyle = "#000"; ctx.fillStyle = "#000"; ctx.lineWidth = 1.25 / st; ctx.lineJoin = "round"; ctx.lineCap = "round";
  const X = (x) => (x - bb[0]) * k + pad, Y = (y) => (bb[3] - y) * k + pad;
  let vis = null;
  if (overview && !hatch) for (const p of prims) if (p.t === "h") p.keep = false; // decided again below
  for (const p of prims) {
    if (skip(p) || (!hatch && p.hl)) continue; // hatch off: also the hatch exploded into lines
    ctx.__prim = p;
    if (p.t === "h") {
      if (!hatch && !p.keep) continue;
      if (!vis) { const iv = inv(T), w = ctx.canvas.width, h = ctx.canvas.height, c = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => apply(iv, x, y)); vis = [Math.min(...c.map((q) => q[0])), Math.min(...c.map((q) => q[1])), Math.max(...c.map((q) => q[0])), Math.max(...c.map((q) => q[1]))]; }
      drawHatch(ctx, p, X, Y, k, st, vis);
      continue;
    }
    if (p.t === "p") {
      ctx.beginPath(); ctx.moveTo(X(p.pts[0][0]), Y(p.pts[0][1]));
      for (let i = 1; i < p.pts.length; i++) ctx.lineTo(X(p.pts[i][0]), Y(p.pts[i][1]));
      if (p.fill) ctx.fill(); else ctx.stroke();
    } else {
      const px = p.h * k; if (px * st < 1.5 && !texts) continue;
      const ox = X(p.p[0]), oy = Y(p.p[1]), cs = Math.cos(-p.rot), sn = Math.sin(-p.rot);
      ctx.save(); ctx.translate(ox, oy); ctx.rotate(-p.rot);
      ctx.font = px.toFixed(2) + "px Arial, Helvetica, sans-serif";
      ctx.textAlign = ["left", "center", "right"][p.ha] || "left";
      const lines = p.s.split("\n"), lh = px * 1.4;
      let y0 = 0;
      if (p.multi) { ctx.textBaseline = "top"; const tot = lh * lines.length; y0 = p.va === 3 ? 0 : p.va === 2 ? -tot / 2 : -tot; }
      else ctx.textBaseline = ["alphabetic", "bottom", "middle", "top"][p.va] || "alphabetic";
      lines.forEach((s, i) => {
        const ly = y0 + i * lh;
        if (px * st >= 1.5) ctx.fillText(s, 0, ly);
        if (texts && s.trim()) {
          const m = ctx.measureText(s);
          const l = -m.actualBoundingBoxLeft, r = m.actualBoundingBoxRight, t = ly - m.actualBoundingBoxAscent, b = ly + m.actualBoundingBoxDescent;
          const loc = [[l, b], [r, b], [r, t], [l, t]];
          texts.push({ s, h: px, c: loc.map(([x, y]) => [ox + x * cs - y * sn, oy + x * sn + y * cs]), p });
        }
      });
      ctx.restore();
    }
  }
  // left-out solid hatch with no line along its boundary is a shape on its own, and so is a small compact
  // one (a pillar): compare it. A pattern hatch never is: soil or concrete under a section has no outline
  // either, and goes with the switch.
  if (overview && !hatch) {
    const near = inkNear(ctx), W = ctx.canvas.width, H = ctx.canvas.height, vis = [0, 0, W, H], lone = [];
    for (const p of prims) {
      if (p.t !== "h" || !p.solid || skip(p)) continue;
      const polys = p.loops.map((L) => [...L, L[0]].map((q) => [X(q[0]), Y(q[1])]));
      if (pillar(polys, DXF_PX_PER_MM) || edgeInk(near, polys, W, H) < LONE_EDGE) lone.push(p);
    }
    for (const p of lone) { p.keep = true; drawHatch(ctx, p, X, Y, k, st, vis); }
  }
  ctx.restore();
}

// A DXF primitive the "Elementos de anotación" switch lets through (texts are always annotation)
const shown = (p) => S.annot || !(p.an || p.as || p.t === "x");

// One hatch: solid ones are filled; pattern ones draw their line families inside the boundary
// (only over the visible part). Families too dense to tell apart at this zoom are filled.
function drawHatch(ctx, p, X, Y, k, st, vis) {
  const r = [Math.max(vis[0], X(p.bb[0])), Math.max(vis[1], Y(p.bb[3])), Math.min(vis[2], X(p.bb[2])), Math.min(vis[3], Y(p.bb[1]))];
  if (r[0] >= r[2] || r[1] >= r[3]) return;
  ctx.beginPath();
  for (const L of p.loops) { ctx.moveTo(X(L[0][0]), Y(L[0][1])); for (let i = 1; i < L.length; i++) ctx.lineTo(X(L[i][0]), Y(L[i][1])); ctx.closePath(); }
  if (p.solid) { ctx.fill("evenodd"); return; }
  ctx.save(); ctx.clip("evenodd");
  const corners = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]], diag = Math.hypot(r[2] - r[0], r[3] - r[1]);
  for (const l of p.lines) {
    const B = [X(l.b[0]), Y(l.b[1])], U = [l.u[0] * k, -l.u[1] * k], O = [l.o[0] * k, -l.o[1] * k];
    const ul = Math.hypot(U[0], U[1]); if (!ul) continue;
    const ux = U[0] / ul, uy = U[1] / ul, sp = O[0] * -uy + O[1] * ux; // spacing between lines, raster px
    if (Math.abs(sp) * st < 1.5) { ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]); break; }
    const q = corners.map(([x, y]) => ((x - B[0]) * -uy + (y - B[1]) * ux) / sp), j0 = Math.ceil(Math.min(...q)), j1 = Math.floor(Math.max(...q));
    const dash = l.d.map((d) => d * ul), per = dash.reduce((a, d) => a + Math.abs(d), 0);
    const plain = !dash.some((d) => d < 0) || per * st < 4 || (j1 - j0 + 1) * (diag / per) * dash.length > 4e5;
    ctx.beginPath();
    for (let j = j0; j <= j1; j++) {
      const ox = B[0] + j * O[0], oy = B[1] + j * O[1];
      const ss = corners.map(([x, y]) => (x - ox) * ux + (y - oy) * uy), s0 = Math.min(...ss), s1 = Math.max(...ss);
      if (plain) { ctx.moveTo(ox + s0 * ux, oy + s0 * uy); ctx.lineTo(ox + s1 * ux, oy + s1 * uy); continue; }
      let s = Math.floor(s0 / per) * per;
      while (s < s1) for (const d of dash) {
        if (d >= 0) { const e = s + Math.max(d, 0.01); ctx.moveTo(ox + s * ux, oy + s * uy); ctx.lineTo(ox + e * ux, oy + e * uy); }
        s += Math.abs(d);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

// PDF text items -> boxes in raster px (corners: baseline-start, baseline-end, top-end, top-start)
async function pdfTexts(D) {
  const page = await D.pdf.getPage(D.page);
  const vp = page.getViewport({ scale: D.scale });
  const tc = await page.getTextContent();
  const out = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    const fs = Math.hypot(c, d) || Math.hypot(a, b); if (!fs) continue;
    const ux = a / Math.hypot(a, b), uy = b / Math.hypot(a, b), vx = c / fs, vy = d / fs;
    const w = it.width || fs * it.str.length * 0.5, desc = fs * 0.22, asc = fs * 0.9;
    const pts = [[e - vx * desc, f - vy * desc], [e + ux * w - vx * desc, f + uy * w - vy * desc], [e + ux * w + vx * asc, f + uy * w + vy * asc], [e + vx * asc, f + vy * asc]];
    out.push({ s: it.str, h: fs * D.scale, c: pts.map(([x, y]) => vp.convertToViewportPoint(x, y)) });
  }
  return out;
}

// Merge text fragments that sit on the same baseline into whole lines,
// so "DORMITORIO 1" matches even if one file splits it in two pieces.
function textLines(items) {
  const rows = items.map((t) => {
    const [p0, p1, , p3] = t.c;
    let ux = p1[0] - p0[0], uy = p1[1] - p0[1]; const L = Math.hypot(ux, uy) || 1; ux /= L; uy /= L;
    const ang = Math.round(Math.atan2(uy, ux) * 180 / Math.PI / 2) * 2;
    const nx = -uy, ny = ux;
    return { ...t, ux, uy, ang, perp: p0[0] * nx + p0[1] * ny, a0: p0[0] * ux + p0[1] * uy, a1: p1[0] * ux + p1[1] * uy };
  });
  rows.sort((p, q) => p.ang - q.ang || p.perp - q.perp);
  const lines = [];
  let i = 0;
  while (i < rows.length) {
    const band = [rows[i]]; let j = i + 1;
    while (j < rows.length && rows[j].ang === rows[i].ang && rows[j].perp - band[band.length - 1].perp < 0.3 * Math.max(rows[j].h, rows[i].h)) band.push(rows[j++]);
    band.sort((p, q) => p.a0 - q.a0);
    let cur = null;
    for (const r of band) {
      if (cur && r.a0 - cur.a1 < 0.9 * Math.max(r.h, cur.h) && r.h / cur.h < 1.6 && cur.h / r.h < 1.6) {
        cur.s += (r.a0 - cur.a1 > 0.15 * r.h ? " " : "") + r.s; cur.c[1] = r.c[1]; cur.c[2] = r.c[2]; cur.a1 = Math.max(cur.a1, r.a1); cur.h = Math.max(cur.h, r.h);
      } else { cur = { s: r.s, h: r.h, c: r.c.map((p) => p.slice()), a1: r.a1 }; lines.push(cur); }
    }
    i = j;
  }
  return lines;
}

// Find texts that say the same thing in the same place in A and B. Returns boxes (frame px)
// where differences only come from the typeface and should be shown as matching.
function matchTexts(tA, tB, M) {
  if (!tA || !tB || !tA.length || !tB.length) return [];
  const norm = (s) => s.toLowerCase().replace(/\s+/g, "");
  const box = (c) => { const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  const sB = scaleOf(M);
  const byKey = new Map();
  for (const t of tB) {
    const c = t.c.map((p) => apply(M, p[0], p[1])), bx = box(c);
    const item = { key: norm(t.s), h: t.h * sB, bx, cx: (bx[0] + bx[2]) / 2, cy: (bx[1] + bx[3]) / 2, used: false };
    if (!byKey.has(item.key)) byKey.set(item.key, []);
    byKey.get(item.key).push(item);
  }
  const out = [];
  for (const t of tA) {
    const cand = byKey.get(norm(t.s)); if (!cand) continue;
    const bx = box(t.c), cx = (bx[0] + bx[2]) / 2, cy = (bx[1] + bx[3]) / 2;
    let best = null, bd = Infinity;
    for (const c of cand) {
      if (c.used) continue;
      // compare both the centers and the start points, since a new font changes the width
      const d = Math.min(Math.hypot(c.cx - cx, c.cy - cy), Math.hypot(c.bx[0] - bx[0], c.bx[1] - bx[1]), Math.hypot(c.bx[2] - bx[2], c.bx[3] - bx[3]));
      if (d < bd) { bd = d; best = c; }
    }
    const h = Math.max(t.h, best ? best.h : 0);
    if (best && bd < 1.2 * h + 3 && best.h / t.h < 1.8 && t.h / best.h < 1.8) {
      best.used = true;
      const p = 0.15 * h;
      out.push([Math.min(bx[0], best.bx[0]) - p, Math.min(bx[1], best.bx[1]) - p, Math.max(bx[2], best.bx[2]) + p, Math.max(bx[3], best.bx[3]) + p]);
    }
  }
  return out;
}

// ---------- masks ----------
function inkMask(canvas, W, H, thr = INK_THRESHOLD) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, W, H).data, m = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < m.length; i++, j += 4) {
    const a = d[j + 3] / 255;
    const lum = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) * a + 255 * (1 - a);
    if (lum < thr) m[i] = 1;
  }
  return m;
}
function dilate(m, W, H, r) {
  if (r <= 0) return m.slice();
  const t = new Uint8Array(W * H), o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W; let cnt = 0;
    for (let x = 0; x < Math.min(r, W); x++) cnt += m[row + x];
    for (let x = 0; x < W; x++) {
      if (x + r < W) cnt += m[row + x + r];
      if (x - r - 1 >= 0) cnt -= m[row + x - r - 1];
      t[row + x] = cnt > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < W; x++) {
    let cnt = 0;
    for (let y = 0; y < Math.min(r, H); y++) cnt += t[y * W + x];
    for (let y = 0; y < H; y++) {
      if (y + r < H) cnt += t[(y + r) * W + x];
      if (y - r - 1 >= 0) cnt -= t[(y - r - 1) * W + x];
      o[y * W + x] = cnt > 0 ? 1 : 0;
    }
  }
  return o;
}
const clipRect = (r, W, H) => [Math.max(0, Math.floor(r[0])), Math.max(0, Math.floor(r[1])), Math.min(W, Math.ceil(r[2])), Math.min(H, Math.ceil(r[3]))];

// Classify every inked pixel: in both (gray), only in A, only in B.
// excl and neutral are rectangles in this canvas' pixels; gA and gB mark the letters drawn in A and B
// (null when the letters could not be told apart from the rest of the drawing).
function classify(mA, mB, W, H, tol, excl, neutral, gA = null, gB = null) {
  for (const r of excl) {
    const [x0, y0, x1, y1] = clipRect(r, W, H); if (x1 <= x0) continue;
    for (let y = y0; y < y1; y++) { mA.fill(0, y * W + x0, y * W + x1); mB.fill(0, y * W + x0, y * W + x1); }
  }
  const dA = dilate(mA, W, H, tol), dB = dilate(mB, W, H, tol);
  // Inside a solid area (a filled hatch, a thick wall) the tolerance would match every pixel near the other
  // plan's lines, so a thin line over a fill came out as a thick gray band. There a pixel matches only where
  // the other plan has ink at that very pixel; the tolerance still applies near the edges.
  const edge = (m) => { const o = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) o[i] = m[i] ? 0 : 1; return dilate(o, W, H, tol + 1); };
  const eA = tol > 0 ? edge(mA) : null, eB = tol > 0 ? edge(mB) : null;
  const rem = new Uint8Array(W * H), add = new Uint8Array(W * H), com = new Uint8Array(W * H);
  let nA = 0, nB = 0, nRem = 0, nAdd = 0;
  for (let i = 0; i < W * H; i++) {
    if (mA[i]) { nA++; if (!eA || eA[i] ? dB[i] : mB[i]) com[i] = 1; else { rem[i] = 1; nRem++; } }
    if (mB[i]) { nB++; if (!eB || eB[i] ? dA[i] : mA[i]) com[i] = 1; else { add[i] = 1; nAdd++; } }
  }
  // Same text in another typeface: inside the text's box, a change is ignored only on the letters
  // (A's letters for what A lost, B's for what B gained). Lines and symbols there stay a change.
  // Without the letters of both plans nothing is ignored: a typeface change in red is better than a hidden change.
  let fontFixed = 0;
  if (neutral.length && gA && gB) {
    const GA = dilate(gA, W, H, Math.max(1, tol)), GB = dilate(gB, W, H, Math.max(1, tol));
    for (const r of neutral) {
      const [x0, y0, x1, y1] = clipRect(r, W, H); let n = 0;
      for (let y = y0; y < y1; y++) for (let i = y * W + x0, e = y * W + x1; i < e; i++) {
        if (rem[i] && GA[i]) { rem[i] = 0; nRem--; n++; }
        if (add[i] && GB[i]) { add[i] = 0; nAdd--; n++; }
        // show B's lettering only, so two overlapping typefaces don't read as a smudge
        com[i] = (mB[i] && !add[i]) || (com[i] && !GA[i]) ? 1 : 0; // B's ink still red stays red (a fill over the text)
      }
      if (n > 2) fontFixed++;
    }
  }
  return { rem, add, com, nA, nB, nRem, nAdd, fontFixed };
}

// ---------- alignment ----------
function profiles(m, W, H) {
  const col = new Float64Array(W), row = new Float64Array(H);
  for (let y = 0; y < H; y++) { const r = y * W; let s = 0; for (let x = 0; x < W; x++) { const v = m[r + x]; s += v; col[x] += v; } row[y] = s; }
  return [col, row];
}
function bestShift(a, b, maxShift) {
  // shift s so that b[i - s] lines up with a[i]
  const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
  const A = a.map((v) => v - ma), B = b.map((v) => v - mb);
  let best = -Infinity, bestS = 0, zero = 0;
  for (let s = -maxShift; s <= maxShift; s++) {
    let acc = 0;
    const i0 = Math.max(0, s), i1 = Math.min(A.length, B.length + s);
    for (let i = i0; i < i1; i++) acc += A[i] * B[i - s];
    if (s === 0) zero = acc;
    if (acc > best) { best = acc; bestS = s; }
  }
  if (zero >= best * 0.985) return 0;
  return bestS;
}
// Positions of long straight lines (grid axes, walls, frames): strong local maxima of an ink profile.
function axisPeaks(prof, n) {
  let mx = 0; for (const v of prof) mx = Math.max(mx, v);
  const thr = mx * 0.2, out = [];
  for (let i = 0; i < prof.length; i++) {
    const v = prof[i]; if (v < thr || v === 0) continue;
    let top = true;
    for (let j = Math.max(0, i - 4); j <= Math.min(prof.length - 1, i + 4); j++) if (prof[j] > v || (prof[j] === v && j < i)) { top = false; break; }
    if (top) out.push({ p: i, v });
  }
  out.sort((a, b) => b.v - a.v);
  return out.slice(0, n).map((o) => o.p).sort((a, b) => a - b);
}
function nearestDist(sorted, x) {
  let lo = 0, hi = sorted.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m; else hi = m; }
  return Math.min(Math.abs(sorted[lo] - x), Math.abs(sorted[hi] - x));
}
const countHits = (pa, pb, s, t, tol) => { let n = 0; for (const b of pb) if (nearestDist(pa, s * b + t) < tol) n++; return n; };
// usual ratios between drawing scales (1:50 vs 1:100, 1:75 vs 1:100, ...)
const NICE = (() => { const sc = [10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 1000], r = []; for (const a of sc) for (const b of sc) r.push(b / a); return r; })();
const isNice = (s) => NICE.some((r) => Math.abs(s / r - 1) < 0.006);

// For one axis: every pair of lines in A against every pair in B proposes a scale and offset;
// keep the proposals under which most lines of B land on lines of A.
function axisProposals(pa, pb, len) {
  const tol = Math.max(2, len * 0.0015), out = [];
  for (let i = 0; i < pa.length; i++) for (let j = i + 1; j < pa.length; j++) {
    const da = pa[j] - pa[i]; if (da < len * 0.04) continue;
    for (let k = 0; k < pb.length; k++) for (let l = k + 1; l < pb.length; l++) {
      const db = pb[l] - pb[k]; if (db < len * 0.04) continue;
      const s = da / db; if (s < 0.2 || s > 5) continue;
      const t = pa[i] - s * pb[k];
      out.push({ s, t, n: countHits(pa, pb, s, t, tol) });
    }
  }
  out.sort((a, b) => b.n - a.n);
  return out;
}
function bestOffset(pa, pb, s, len) {
  const tol = Math.max(2, len * 0.0015); let best = { t: 0, n: -1 };
  for (const a of pa) for (const b of pb) { const t = a - s * b, n = countHits(pa, pb, s, t, tol); if (n > best.n) best = { t, n }; }
  return best;
}
// How well B (placed with m) lies on A: F-score of ink near ink, on masks 1/div of the size.
function overlapScorer(rA, rB, W, H, div = 2) {
  const w = Math.max(1, Math.round(W / div)), h = Math.max(1, Math.round(H / div));
  const half = (c, m) => { const o = document.createElement("canvas"); o.width = w; o.height = h; const x = o.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.setTransform(m[0] / div, m[1] / div, m[2] / div, m[3] / div, m[4] / div, m[5] / div); x.drawImage(c, 0, 0); return inkMask(o, w, h, 245); };
  const mA = half(rA, I), dA = dilate(mA, w, h, 2); let nA = 0; for (const v of mA) nA += v;
  return (m) => {
    const mB = half(rB, m), dB = dilate(mB, w, h, 2);
    let nB = 0, hitB = 0, hitA = 0;
    for (let i = 0; i < w * h; i++) { if (mB[i]) { nB++; if (dA[i]) hitB++; } if (mA[i] && dB[i]) hitA++; }
    const P = nB ? hitB / nB : 0, R = nA ? hitA / nA : 0;
    return P + R ? 2 * P * R / (P + R) : 0;
  };
}
// The same score, quick: ink points of each plan (on masks a quarter of the size, at most ~40000 of
// them) checked against the other's dilated mask. For sorting many proposals.
function quickScorer(rA, rB) {
  const div = 4;
  const prep = (c) => {
    const w = Math.max(1, Math.ceil(c.width / div)), h = Math.max(1, Math.ceil(c.height / div));
    const o = document.createElement("canvas"); o.width = w; o.height = h;
    const x = o.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.setTransform(1 / div, 0, 0, 1 / div, 0, 0); x.drawImage(c, 0, 0);
    const m = inkMask(o, w, h, 245), pts = [];
    let n = 0; for (const v of m) n += v;
    const step = Math.max(1, Math.round(n / 40000));
    for (let i = 0, k = 0; i < m.length; i++) if (m[i] && (k++ % step === 0)) pts.push((i % w) * div + div / 2, Math.floor(i / w) * div + div / 2);
    return { w, h, d: dilate(m, w, h, 2), pts };
  };
  const A = prep(rA), B = prep(rB);
  const hits = (src, dst, m) => {
    let n = 0; const P = src.pts;
    for (let i = 0; i < P.length; i += 2) {
      const x = Math.floor((m[0] * P[i] + m[2] * P[i + 1] + m[4]) / div), y = Math.floor((m[1] * P[i] + m[3] * P[i + 1] + m[5]) / div);
      if (x >= 0 && y >= 0 && x < dst.w && y < dst.h && dst.d[y * dst.w + x]) n++;
    }
    return P.length ? n / (P.length / 2) : 0;
  };
  return (m) => {
    const det = m[0] * m[3] - m[1] * m[2], inv = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
    const P = hits(B, A, m), R = hits(A, B, inv);
    return P + R ? 2 * P * R / (P + R) : 0;
  };
}
function autoAlign(rA, rB, W, H) {
  const mA = inkMask(padTo(rA, W, H), W, H), mB = inkMask(padTo(rB, W, H), W, H);
  const [cA, rwA] = profiles(mA, W, H), [cB, rwB] = profiles(mB, W, H);
  const shift = [1, 0, 0, 1, bestShift(cA, cB, Math.round(W * 0.3)), bestShift(rwA, rwB, Math.round(H * 0.3))];
  // Same drawing at another scale: match the grid axes of A and B to find scale and offset.
  const N = 24, xa = axisPeaks(cA, N), xb = axisPeaks(cB, N), ya = axisPeaks(rwA, N), yb = axisPeaks(rwB, N);
  const cands = [];
  if (xa.length >= 2 && xb.length >= 2 && ya.length && yb.length) {
    for (const c of axisProposals(xa, xb, W).slice(0, 40)) { const o = bestOffset(ya, yb, c.s, H); cands.push({ s: c.s, tx: c.t, ty: o.t, n: c.n + o.n }); }
  }
  if (ya.length >= 2 && yb.length >= 2 && xa.length && xb.length) {
    for (const c of axisProposals(ya, yb, H).slice(0, 40)) { const o = bestOffset(xa, xb, c.s, W); cands.push({ s: c.s, tx: o.t, ty: c.t, n: c.n + o.n }); }
  }
  // The sheet's frame: the outermost lines on each side (a PDF and a DXF of one sheet are drawn at
  // unrelated sizes, and lines bunched in the middle of the sheet can outvote the frame above)
  const outer = (pa, pb, len, pa2, pb2, len2, vertical) => {
    const ends = (p) => [p.slice(0, 3), p.slice(-3)];
    const [la, ra] = ends(pa), [lb, rb] = ends(pb);
    for (const l of la) for (const r of ra) for (const l2 of lb) for (const r2 of rb) {
      if (r - l < len * 0.5 || r2 - l2 < len * 0.5) continue;
      const s = (r - l) / (r2 - l2); if (s < 0.2 || s > 5) continue;
      const t = l - s * l2, o = bestOffset(pa2, pb2, s, len2), n = countHits(pa, pb, s, t, Math.max(2, len * 0.0015)) + o.n;
      cands.push(vertical ? { s, tx: o.t, ty: t, n } : { s, tx: t, ty: o.t, n });
    }
  };
  if (xa.length >= 2 && xb.length >= 2 && ya.length && yb.length) outer(xa, xb, W, ya, yb, H, false);
  if (ya.length >= 2 && yb.length >= 2 && xa.length && xb.length) outer(ya, yb, H, xa, xb, W, true);
  for (const c of cands) c.score = c.n + (isNice(c.s) ? 1.5 : 0) + (Math.abs(c.s - 1) < 0.004 ? 0.5 : 0);
  cands.sort((a, b) => b.score - a.score);
  // a quick look at the best different proposals keeps five of them
  const distinct = [];
  for (const c of cands) {
    if (distinct.some((p) => Math.abs(p.s / c.s - 1) < 0.01 && Math.abs(p.tx - c.tx) < 4 && Math.abs(p.ty - c.ty) < 4)) continue;
    distinct.push(c); if (distinct.length >= 40) break;
  }
  const quick = quickScorer(rA, rB);
  for (const c of distinct) c.f = quick([c.s, 0, 0, c.s, c.tx, c.ty]);
  const picked = distinct.sort((a, b) => b.f - a.f).slice(0, 5);
  // Least-squares fit over all lines that matched, then snap to a usual scale ratio if close.
  const refine = (c) => {
    const pairs = (pa, pb, t, len) => { const tol = Math.max(3, len * 0.003), r = []; for (const q of pb) { const x = c.s * q + t; let a = pa[0]; for (const v of pa) if (Math.abs(v - x) < Math.abs(a - x)) a = v; if (Math.abs(a - x) < tol) r.push([q, a]); } return r; };
    const px = pairs(xa, xb, c.tx, W), py = pairs(ya, yb, c.ty, H);
    if (px.length + py.length < 3) return [c.s, 0, 0, c.s, c.tx, c.ty];
    const mean = (r, i) => r.reduce((x, p) => x + p[i], 0) / (r.length || 1);
    const mbx = mean(px, 0), max = mean(px, 1), mby = mean(py, 0), may = mean(py, 1);
    let num = 0, den = 0;
    for (const [q, a] of px) { num += (q - mbx) * (a - max); den += (q - mbx) ** 2; }
    for (const [q, a] of py) { num += (q - mby) * (a - may); den += (q - mby) ** 2; }
    let s = den ? num / den : c.s;
    const nice = NICE.find((r) => Math.abs(s / r - 1) < 0.006); if (nice) s = nice;
    return [s, 0, 0, s, px.length ? max - s * mbx : c.tx, py.length ? may - s * mby : c.ty];
  };
  const score = overlapScorer(rA, rB, W, H);
  let best = shift, bestF = score(shift);
  for (const c of picked) {
    const m = refine(c), f = score(m);
    if (f > bestF + 0.02) { best = m; bestF = f; }
  }
  if (best !== shift && Math.abs(best[0] - 1) < 0.002) best = [1, 0, 0, 1, Math.round(best[4]), Math.round(best[5])];
  return best;
}
function padTo(c, W, H) {
  if (c.width === W && c.height === H) return c;
  const o = document.createElement("canvas"); o.width = W; o.height = H;
  const x = o.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, W, H); x.drawImage(c, 0, 0); return o;
}
function warp(c, m, W, H) {
  const o = document.createElement("canvas"); o.width = W; o.height = H;
  const x = o.getContext("2d", { willReadFrequently: true });
  x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
  const pure = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1;
  if (pure) x.drawImage(c, Math.round(m[4]), Math.round(m[5]));
  else { x.imageSmoothingEnabled = true; x.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]); x.drawImage(c, 0, 0); }
  return o;
}

// Plano A and Plano B views: one plan alone, without hatch, A in #28251f and B in #7e705b.
// Made from the comparison rasters when the hatch switch is off, else drawn again without hatch.
// pestañas de cada versión: la anterior en #877a67 y la nueva en #c7bda8 (como el Comparador A·B); un plano solo, oscuro
const COL_PLAIN = { A: [135, 122, 103], B: [199, 189, 168] };
const COL_SOLO = [40, 37, 31];
function tint(c, rgb) {
  const o = document.createElement("canvas"); o.width = c.width; o.height = c.height;
  const x = o.getContext("2d"); x.drawImage(c, 0, 0);
  const img = x.getImageData(0, 0, o.width, o.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = 1 - Math.min(d[i], d[i + 1], d[i + 2]) / 255; // how much ink, keeping the line's soft edges
    d[i] = 255 - (255 - rgb[0]) * a; d[i + 1] = 255 - (255 - rgb[1]) * a; d[i + 2] = 255 - (255 - rgb[2]) * a; d[i + 3] = 255;
  }
  x.putImageData(img, 0, 0); return o;
}

// Half-size copies of a plan, down to a few hundred pixels. Each pixel keeps the darkest pixel of the
// block it stands for, so thin lines (the axes to click) do not vanish when the plan is shown whole.
function pyramid(c) {
  if (c._levels) return c._levels;
  let w = c.width, h = c.height, d = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data, f = 1;
  const out = [], lum = (a, j) => 0.299 * a[j] + 0.587 * a[j + 1] + 0.114 * a[j + 2];
  while (Math.max(w, h) > 400) {
    const w2 = Math.ceil(w / 2), h2 = Math.ceil(h / 2), cv = document.createElement("canvas"); cv.width = w2; cv.height = h2;
    const x2 = cv.getContext("2d", { willReadFrequently: true }), img = x2.createImageData(w2, h2), o = img.data;
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      let best = -1, bl = Infinity;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const xx = 2 * x + dx, yy = 2 * y + dy; if (xx < w && yy < h) { const j = (yy * w + xx) * 4, l = lum(d, j); if (l < bl) { bl = l; best = j; } } }
      const k = (y * w2 + x) * 4; o[k] = d[best]; o[k + 1] = d[best + 1]; o[k + 2] = d[best + 2]; o[k + 3] = 255;
    }
    x2.putImageData(img, 0, 0); f *= 2; out.push({ f, c: cv }); w = w2; h = h2; d = o;
  }
  return (c._levels = out);
}

// VialAG logo, from the header drawing VialAG supplied ("VIÑETA 4.dxf", units: cm, origin at the
// bar's lower-left corner). r: outlines (outer ring, then holes); t: the same area as triangles.
const LOGO = {
  bar: [45.12, 1.976], band: 0.222, bb: [1.598,0.572,9.611,1.621],
  box: { r: [[[7.737,0.572,1.598,0.572,1.598,1.621,7.737,1.621,7.737,0.572]]],
    t: [1.598,0.572,7.737,0.572,7.737,1.621,7.737,1.621,1.598,1.621,1.598,0.572] },
  vial: { r: [[[2.033,1.437,2.118,1.437,2.379,0.83,2.643,1.437,2.729,1.437,2.387,0.651,2.37,0.651,2.033,1.437]],[[3.841,1.437,3.92,1.437,3.92,0.651,3.841,0.651,3.841,1.437]],[[5.392,1.437,5.759,0.651,5.674,0.651,5.55,0.91,5.212,0.91,5.09,0.651,5.002,0.651,5.373,1.437,5.392,1.437],[5.382,1.27,5.248,0.986,5.516,0.986,5.382,1.27]],[[6.88,1.428,6.958,1.428,6.958,0.718,7.26,0.718,7.26,0.642,6.88,0.642,6.88,1.428]]],
    t: [2.118,1.437,2.033,1.437,2.37,0.651,2.37,0.651,2.387,0.651,2.729,1.437,2.729,1.437,2.643,1.437,2.379,0.83,2.379,0.83,2.118,1.437,2.37,0.651,2.37,0.651,2.729,1.437,2.379,0.83,3.92,1.437,3.841,1.437,3.841,0.651,3.841,0.651,3.92,0.651,3.92,1.437,5.002,0.651,5.248,0.986,5.382,1.27,5.002,0.651,5.09,0.651,5.212,0.91,5.55,0.91,5.674,0.651,5.759,0.651,5.759,0.651,5.392,1.437,5.373,1.437,5.373,1.437,5.002,0.651,5.382,1.27,5.248,0.986,5.002,0.651,5.212,0.91,5.55,0.91,5.759,0.651,5.373,1.437,5.373,1.437,5.382,1.27,5.516,0.986,5.516,0.986,5.248,0.986,5.212,0.91,5.55,0.91,5.373,1.437,5.516,0.986,5.516,0.986,5.212,0.91,5.55,0.91,6.958,1.428,6.88,1.428,6.88,0.642,6.88,0.642,7.26,0.642,7.26,0.718,6.958,0.718,6.958,1.428,6.88,0.642,6.88,0.642,7.26,0.718,6.958,0.718] },
  ag: { r: [[[8.319,1.409,8.685,0.624,8.6,0.624,8.477,0.882,8.138,0.882,8.016,0.624,7.928,0.624,8.3,1.409,8.319,1.409],[8.309,1.242,8.174,0.958,8.443,0.958,8.309,1.242]],[[9.565,1.277,9.522,1.314,9.48,1.346,9.436,1.372,9.393,1.393,9.348,1.409,9.302,1.42,9.254,1.427,9.205,1.429,9.145,1.426,9.088,1.415,9.034,1.399,8.983,1.375,8.937,1.345,8.896,1.31,8.86,1.27,8.83,1.224,8.805,1.175,8.788,1.125,8.777,1.072,8.774,1.017,8.78,0.944,8.798,0.876,8.829,0.812,8.871,0.752,8.905,0.718,8.941,0.688,8.979,0.662,9.021,0.641,9.066,0.625,9.113,0.613,9.163,0.606,9.216,0.604,9.26,0.606,9.302,0.611,9.341,0.619,9.378,0.631,9.412,0.646,9.445,0.664,9.475,0.686,9.503,0.711,9.528,0.739,9.55,0.769,9.568,0.802,9.583,0.837,9.595,0.874,9.604,0.914,9.609,0.956,9.611,1,9.272,1,9.272,0.924,9.523,0.924,9.511,0.872,9.49,0.826,9.461,0.784,9.424,0.747,9.379,0.717,9.33,0.696,9.277,0.683,9.219,0.679,9.17,0.681,9.123,0.69,9.078,0.704,9.035,0.724,8.995,0.749,8.96,0.778,8.93,0.812,8.903,0.85,8.883,0.89,8.868,0.932,8.859,0.975,8.856,1.018,8.859,1.061,8.867,1.103,8.882,1.143,8.902,1.183,8.927,1.219,8.957,1.252,8.992,1.281,9.031,1.306,9.074,1.325,9.117,1.34,9.162,1.348,9.207,1.351,9.245,1.349,9.283,1.343,9.321,1.332,9.36,1.318,9.398,1.299,9.435,1.276,9.47,1.25,9.504,1.22,9.565,1.277]]],
    t: [7.928,0.624,8.174,0.958,8.309,1.242,8.174,0.958,7.928,0.624,8.016,0.624,8.477,0.882,8.6,0.624,8.685,0.624,8.685,0.624,8.319,1.409,8.3,1.409,8.3,1.409,7.928,0.624,8.309,1.242,8.174,0.958,8.016,0.624,8.138,0.882,8.477,0.882,8.685,0.624,8.3,1.409,8.3,1.409,8.309,1.242,8.443,0.958,8.443,0.958,8.174,0.958,8.138,0.882,8.477,0.882,8.3,1.409,8.443,0.958,8.443,0.958,8.138,0.882,8.477,0.882,9.504,1.22,9.565,1.277,9.522,1.314,9.522,1.314,9.48,1.346,9.436,1.372,9.436,1.372,9.393,1.393,9.348,1.409,9.348,1.409,9.302,1.42,9.254,1.427,9.254,1.427,9.205,1.429,9.145,1.426,9.145,1.426,9.088,1.415,9.034,1.399,9.034,1.399,8.983,1.375,8.937,1.345,8.937,1.345,8.896,1.31,8.86,1.27,8.86,1.27,8.83,1.224,8.805,1.175,8.805,1.175,8.788,1.125,8.777,1.072,8.777,1.072,8.774,1.017,8.78,0.944,8.78,0.944,8.798,0.876,8.829,0.812,8.829,0.812,8.871,0.752,8.905,0.718,8.905,0.718,8.941,0.688,8.979,0.662,8.979,0.662,9.021,0.641,9.066,0.625,9.066,0.625,9.113,0.613,9.163,0.606,9.163,0.606,9.216,0.604,9.26,0.606,9.26,0.606,9.302,0.611,9.341,0.619,9.341,0.619,9.378,0.631,9.412,0.646,9.412,0.646,9.445,0.664,9.475,0.686,9.475,0.686,9.503,0.711,9.528,0.739,9.528,0.739,9.55,0.769,9.568,0.802,9.568,0.802,9.583,0.837,9.595,0.874,9.595,0.874,9.604,0.914,9.609,0.956,9.609,0.956,9.611,1,9.272,1,9.272,1,9.272,0.924,9.523,0.924,9.47,1.25,9.504,1.22,9.522,1.314,9.522,1.314,9.436,1.372,9.348,1.409,9.348,1.409,9.254,1.427,9.145,1.426,9.145,1.426,9.034,1.399,8.937,1.345,8.937,1.345,8.86,1.27,8.805,1.175,8.805,1.175,8.777,1.072,8.78,0.944,8.78,0.944,8.829,0.812,8.905,0.718,8.905,0.718,8.979,0.662,9.066,0.625,9.066,0.625,9.163,0.606,9.26,0.606,9.26,0.606,9.341,0.619,9.412,0.646,9.412,0.646,9.475,0.686,9.528,0.739,9.528,0.739,9.568,0.802,9.595,0.874,9.609,0.956,9.272,1,9.523,0.924,9.435,1.276,9.47,1.25,9.522,1.314,9.522,1.314,9.348,1.409,9.145,1.426,9.145,1.426,8.937,1.345,8.805,1.175,8.805,1.175,8.78,0.944,8.905,0.718,8.905,0.718,9.066,0.625,9.26,0.606,9.26,0.606,9.412,0.646,9.528,0.739,9.528,0.739,9.595,0.874,9.609,0.956,9.609,0.956,9.523,0.924,9.511,0.872,9.398,1.299,9.435,1.276,9.522,1.314,9.528,0.739,9.609,0.956,9.511,0.872,9.36,1.318,9.398,1.299,9.522,1.314,9.528,0.739,9.511,0.872,9.49,0.826,9.321,1.332,9.36,1.318,9.522,1.314,9.528,0.739,9.49,0.826,9.461,0.784,9.283,1.343,9.321,1.332,9.522,1.314,9.528,0.739,9.461,0.784,9.424,0.747,9.245,1.349,9.283,1.343,9.522,1.314,9.26,0.606,9.528,0.739,9.424,0.747,9.245,1.349,9.522,1.314,9.145,1.426,9.26,0.606,9.424,0.747,9.379,0.717,9.207,1.351,9.245,1.349,9.145,1.426,9.26,0.606,9.379,0.717,9.33,0.696,9.162,1.348,9.207,1.351,9.145,1.426,9.26,0.606,9.33,0.696,9.277,0.683,9.117,1.34,9.162,1.348,9.145,1.426,9.26,0.606,9.277,0.683,9.219,0.679,9.074,1.325,9.117,1.34,9.145,1.426,9.26,0.606,9.219,0.679,9.17,0.681,9.031,1.306,9.074,1.325,9.145,1.426,8.905,0.718,9.26,0.606,9.17,0.681,8.992,1.281,9.031,1.306,9.145,1.426,8.905,0.718,9.17,0.681,9.123,0.69,8.957,1.252,8.992,1.281,9.145,1.426,8.905,0.718,9.123,0.69,9.078,0.704,8.957,1.252,9.145,1.426,8.805,1.175,8.905,0.718,9.078,0.704,9.035,0.724,8.927,1.219,8.957,1.252,8.805,1.175,8.905,0.718,9.035,0.724,8.995,0.749,8.902,1.183,8.927,1.219,8.805,1.175,8.905,0.718,8.995,0.749,8.96,0.778,8.882,1.143,8.902,1.183,8.805,1.175,8.905,0.718,8.96,0.778,8.93,0.812,8.867,1.103,8.882,1.143,8.805,1.175,8.905,0.718,8.93,0.812,8.903,0.85,8.859,1.061,8.867,1.103,8.805,1.175,8.905,0.718,8.903,0.85,8.883,0.89,8.856,1.018,8.859,1.061,8.805,1.175,8.905,0.718,8.883,0.89,8.868,0.932,8.859,0.975,8.856,1.018,8.805,1.175,8.805,1.175,8.905,0.718,8.868,0.932,8.868,0.932,8.859,0.975,8.805,1.175] },
};
// The PDF fonts only have the Windows Latin characters: others become a near equivalent or "?".
const WIN_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const pdfSafe = (s) => s.normalize("NFC").replace(/[^\x20-\x7e\xa0-\xff]/gu, (c) => WIN_EXTRA.includes(c) ? c : ({ "≥": ">=", "≤": "<=", "№": "No", "\u2009": " ", "\u202f": " " }[c] ?? "?"));
// shorten a line in the middle until it fits w (mm), so the start and the end of a file name stay
function fitWidth(doc, s, w) {
  if (doc.getTextWidth(s) <= w) return s;
  let lo = 1, hi = s.length;
  while (lo < hi) { const n = (lo + hi + 1) >> 1, k = Math.ceil(n / 2); if (doc.getTextWidth(s.slice(0, k) + "…" + s.slice(s.length - (n - k))) <= w) lo = n; else hi = n - 1; }
  const k = Math.ceil(lo / 2); return s.slice(0, k) + "…" + s.slice(s.length - (lo - k));
}
const stem = (n) => n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\.[^.]+$/, "").replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "") || "plano";
