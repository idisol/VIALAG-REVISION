"use strict";
// RE-visión (VialAG): inspección de planos con notas que siguen vivas entre versiones.
// El motor (lectura, alineación, comparación) está en motor.js y es el del Comparador A·B v19.

const COL_NOTE = "#d98a00", COL_CHECK = "#6f7c88", COL_GRAVE = "#ed4133";
const PEN = { r: "#ed4133", b: "#2563c9" };
const MAX_VERS = 3;          // versiones a la vista a la vez en la revisión
const FORMATO = 1;           // formato del archivo de revisión (.json)
const APP_ID = "RE-vision VialAG";

// ---------- estado del plano en pantalla ----------
// A: versión anterior (referencia, en gris). B: versión nueva (en rojo lo que A no tiene). Sin B se ve un plano solo.
const S = {
  A: null, B: null, vA: null, vB: null,
  rasterA: null, rasterB: null, frame: null, maskA: null,
  xf: null,            // {mode:'auto'|'chain'|'manual', m} lleva píxeles de B a píxeles del marco (= A)
  bWarp: null, excl: [], neutral: [], moved: [], view: "diff", mixed: false, result: null,
  hatch: true, annot: true, running: false, // Hatchs y Elementos de anotación, prendidos de partida (como el Comparador A·B v23)
  M: null, Mi: null,   // coordenadas de la versión base -> marco, y su inversa
};
const SIN_COM = "Sin comentarios"; // texto de una nota que se dejó sin escribir

// ---------- revisión (lo que se guarda en el .json) ----------
let R = nuevaRevision();
let ON = new Set();      // versiones encendidas (n)
let onOrder = [];        // orden en que se encendieron (para apagar la más antigua al pasar de dos)
let sucio = false;
function nuevaRevision() {
  return { app: APP_ID, formato: FORMATO, id: uid(), proyecto: "", detalle: "", creador: "", revisor: "", creada: new Date().toISOString(),
    cont: 0, notaCont: 0, refN: null, vers: [], notas: [] };
}
function uid() { try { return crypto.randomUUID(); } catch { return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); } }
const iso = () => new Date().toISOString();
const fecha = (s) => { try { return new Date(s).toLocaleDateString("es-CL"); } catch { return ""; } };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const activas = () => R.vers.filter((v) => v.activa).sort((a, b) => a.n - b.n);
const verN = (n) => R.vers.find((v) => v.n === n) || null;
const Tof = (v) => (!v ? null : v.n === R.refN ? I : v.T || null);
const newestShown = () => S.vB || S.vA;
function marcarSucio() { sucio = true; $("saveHint").textContent = "Hay cambios sin guardar en la revisión."; $("saveHint").classList.add("warn"); exportButtons(); }
function marcarGuardado() { sucio = false; $("saveHint").textContent = ""; $("saveHint").classList.remove("warn"); }
window.addEventListener("beforeunload", (e) => { if (sucio && (R.notas.length || R.vers.length)) { e.preventDefault(); e.returnValue = ""; } });

// huella del archivo: reconoce el mismo plano al abrir una revisión guardada
async function huella(buf) {
  try { const h = await crypto.subtle.digest("SHA-256", buf); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
  catch { const a = new Uint8Array(buf); let h1 = 0x811c9dc5, h2 = 0x01000193; for (let i = 0; i < a.length; i++) { h1 = Math.imul(h1 ^ a[i], 16777619); h2 = Math.imul(h2 + a[i], 2246822519); } return "f" + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + a.length.toString(16); }
}

// ---------- lectura de un plano ----------
async function loadDoc(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const buf = await file.arrayBuffer();
  if (ext === "dwg") throw new Error("El formato DWG no se puede leer en el navegador. Exporta el plano a PDF (Trazar → PDF) o a DXF desde tu programa CAD.");
  let D;
  if (ext === "pdf" || isPdf(buf)) {
    if (!window.pdfjsLib) throw new Error("No se pudo cargar el lector de PDF. Revisa tu conexión y recarga la página.");
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false }).promise; // CVE-2024-4367
    D = { name: file.name, kind: "pdf", pdf, pages: pdf.numPages, page: 1, ocAnnot: [] };
    try { // capas del PDF que son anotación (ejes, cotas, textos…): se apagan con "Elementos de anotación"
      const g = (await pdf.getOptionalContentConfig()).getGroups() || {};
      for (const [id, grp] of Object.entries(g)) if (annotLayer(grp.name)) D.ocAnnot.push(id);
    } catch (e) { console.warn(e); }
  } else if (ext === "dxf") {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 22));
    if (head.startsWith("AutoCAD Binary DXF")) throw new Error("Este DXF es binario. Expórtalo como DXF de texto (ASCII).");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { text = new TextDecoder("windows-1252").decode(buf); }
    const P = window.DxfParser && (window.DxfParser.default || window.DxfParser.DxfParser || window.DxfParser);
    if (!P) throw new Error("No se pudo cargar el lector de DXF. Revisa tu conexión y recarga la página.");
    const parser = new P();
    try { parser.registerEntityHandler(HatchHandler); } catch (e) { console.warn(e); }
    const dxf = parser.parseSync(text);
    if (!dxf || !dxf.entities) throw new Error("No se pudo leer el DXF.");
    D = { name: file.name, kind: "dxf", dxf, pages: 1, page: 1 };
  } else throw new Error("Formato no reconocido. Usa PDF o DXF.");
  D.bytes = file.size; D.huella = await huella(buf); D.file = file; // el archivo original va dentro de la revisión guardada
  return D;
}
function isPdf(buf) { const b = new Uint8Array(buf.slice(0, 5)); return String.fromCharCode(...b) === "%PDF-"; }

// coordenadas propias de cada versión (PDF: puntos de la página; DXF: unidades del dibujo) -> píxeles de su imagen
function n2r(D) {
  if (D.kind === "pdf") return [D.scale, 0, 0, D.scale, 0, 0];
  const k = D.f * D.k; return [k, 0, 0, -k, D.pad - D.bb[0] * D.k, D.bb[3] * D.k + D.pad];
}

// ---------- versiones ----------
async function addVersion(D) {
  const act = activas();
  if (act.length >= MAX_VERS) {
    const old = act[0];
    const ok = await preguntar(`Ya hay ${MAX_VERS} versiones en la revisión. Para agregar la nueva se quita la versión ${old.n} (${old.nombre}).\nSus notas se conservan.`, "Quitar y agregar");
    if (!ok || !quitarVersion(old)) return false;
  }
  R.cont++;
  const v = { n: R.cont, nombre: D.name, tipo: D.kind, pagina: 1, paginas: D.pages, bytes: D.bytes, huella: D.huella, fecha: iso(), T: null, activa: true, D };
  R.vers.push(v);
  if (R.refN == null || !verN(R.refN) || !verN(R.refN).activa) R.refN = v.n;
  const prev = activas().filter((x) => x !== v && x.D).pop();
  setOn(prev ? [prev.n, v.n] : [v.n]);
  marcarSucio();
  return true;
}
function setOn(list) { ON = new Set(list); onOrder = [...list]; }
// Quita una versión de la revisión. Si era la base de las notas, las notas pasan a la siguiente.
function quitarVersion(v) {
  const act = activas();
  if (act.length <= 1) { setStatus("La revisión necesita al menos una versión."); return false; }
  if (v.n === R.refN) {
    const nxt = act.find((x) => x !== v);
    if (!nxt.T) { setStatus(`Antes de quitar la versión ${v.n}, compárala una vez con la versión ${nxt.n}.`); return false; }
    const Mi = inv(nxt.T); // base antigua -> nueva base
    for (const nt of R.notas) moverNota(nt, Mi);
    for (const x of act) if (x !== v && x !== nxt && x.T) x.T = mul(Mi, x.T);
    nxt.T = null; R.refN = nxt.n;
  }
  v.activa = false; v.D = null; v.T = null; v.quitada = iso();
  ON.delete(v.n); onOrder = onOrder.filter((n) => n !== v.n);
  if (!ON.size) { const l = activas().filter((x) => x.D).slice(-2).map((x) => x.n); setOn(l); }
  marcarSucio();
  return true;
}
function moverNota(nt, M) {
  const c = [[nt.x0, nt.y0], [nt.x1, nt.y0], [nt.x1, nt.y1], [nt.x0, nt.y1]].map(([x, y]) => apply(M, x, y));
  nt.x0 = Math.min(...c.map((p) => p[0])); nt.x1 = Math.max(...c.map((p) => p[0]));
  nt.y0 = Math.min(...c.map((p) => p[1])); nt.y1 = Math.max(...c.map((p) => p[1]));
  for (const tr of nt.trazos || []) for (let i = 0; i < tr.p.length; i += 2) { const q = apply(M, tr.p[i], tr.p[i + 1]); tr.p[i] = q[0]; tr.p[i + 1] = q[1]; }
}
function toggleOn(v) {
  if (!v.D || exporting) return;
  if (ON.has(v.n)) {
    if (ON.size === 1) { setStatus("Debe quedar al menos una versión a la vista."); return; }
    ON.delete(v.n); onOrder = onOrder.filter((n) => n !== v.n);
  } else {
    ON.add(v.n); onOrder.push(v.n);
    while (ON.size > 2) { const o = onOrder.shift(); ON.delete(o); }
  }
  renderVers(); mostrar();
}

function renderVers() {
  const box = $("vers"); box.textContent = "";
  const act = activas(), canMove = puedeOrdenar();
  for (const v of act) {
    const row = document.createElement("div");
    row.className = "ver" + (ON.has(v.n) && v.D ? " on" : "") + (v.D ? "" : " miss");
    row.dataset.n = v.n;
    const num = document.createElement("span"); num.className = "vnum"; num.textContent = v.n; num.title = `Versión ${v.n}`;
    const tg = document.createElement("button");
    tg.type = "button"; tg.className = "switch tg"; tg.setAttribute("role", "switch"); tg.setAttribute("aria-checked", ON.has(v.n) && !!v.D);
    tg.setAttribute("aria-label", `Ver la versión ${v.n}`); tg.title = v.D ? (ON.has(v.n) ? "Apagar esta versión" : "Prender esta versión") : "Falta cargar el archivo";
    tg.disabled = !v.D || exporting; tg.innerHTML = '<span class="track" aria-hidden="true"></span>';
    tg.onclick = () => toggleOn(v);
    const x = document.createElement("button"); x.type = "button"; x.className = "x"; x.textContent = "×"; x.title = "Quitar esta versión de la revisión"; x.setAttribute("aria-label", `Quitar la versión ${v.n}`);
    x.hidden = act.length <= 1; x.disabled = exporting;
    x.onclick = async () => { if (await preguntar(`¿Quitar la versión ${v.n} (${v.nombre}) de la revisión?\nSus notas se conservan.`, "Quitar")) { if (quitarVersion(v)) { renderVers(); mostrar(); } } };
    const nm = document.createElement("span"); nm.className = "vn"; nm.textContent = v.nombre; nm.title = v.nombre;
    const mt = document.createElement("span"); mt.className = "vm";
    if (!v.D) {
      mt.append("Falta el archivo · ");
      const b = document.createElement("button"); b.type = "button"; b.className = "ld"; b.textContent = "Cargar"; b.onclick = () => { pendingFor = v; $("fileVer").click(); };
      mt.append(b);
    } else {
      mt.append(fecha(v.fecha));
      if (v.D.pages > 1) {
        const sel = document.createElement("select"); sel.setAttribute("aria-label", `Página de la versión ${v.n}`);
        for (let i = 1; i <= v.D.pages; i++) sel.add(new Option("Página " + i, i));
        sel.value = v.D.page; sel.disabled = exporting;
        sel.onchange = () => {
          v.D.page = v.pagina = +sel.value;
          if (v.n === R.refN) { for (const o of activas()) if (o !== v) o.T = null; } else v.T = null; // la alineación de esa versión se calcula de nuevo
          marcarSucio(); mostrar();
        };
        mt.append(sel);
      }
    }
    row.append(num, nm, x, tg, mt);
    if (canMove) arrastrable(row, v);
    box.append(row);
  }
  const n = act.length;
  $("addVer").textContent = n ? "Agregar plano" : "Elegir plano";
  $("openRev").textContent = n ? "Abrir revisión guardada" : "Abrir una revisión guardada";
  $("addVer").disabled = exporting;
  syncLoaded();
}

// ---------- orden de las versiones ----------
// El orden define el número: la primera es la 1 (la base de las notas y la referencia en gris). Se cambia arrastrando.
const puedeOrdenar = () => { const a = activas(); return a.length >= 2 && a.every((v) => v.D) && !exporting; };
let dragV = null;
function arrastrable(row, v) {
  row.draggable = true; row.title = "Arrastra para cambiar el orden";
  row.addEventListener("dragstart", (e) => {
    if (e.target.closest && e.target.closest("button, select")) { e.preventDefault(); return; }
    dragV = v; row.classList.add("dragging"); e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", "version " + v.n); } catch {}
  });
  row.addEventListener("dragend", () => { dragV = null; document.querySelectorAll(".ver").forEach((r) => r.classList.remove("dragging", "drop-before", "drop-after")); });
  row.addEventListener("dragover", (e) => {
    if (!dragV) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "move";
    const r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
    document.querySelectorAll(".ver").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    if (dragV !== v) row.classList.add(after ? "drop-after" : "drop-before");
  });
  row.addEventListener("drop", async (e) => {
    if (!dragV) return;
    e.preventDefault();
    const moved = dragV; dragV = null;
    const r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
    const order = activas().filter((x) => x !== moved);
    let i = order.indexOf(v); if (i < 0) { renderVers(); return; }
    if (after) i++;
    order.splice(i, 0, moved);
    await reordenar(order);
  });
}
async function reordenar(order) {
  const act = activas(), nums = act.map((v) => v.n);
  const map = new Map(order.map((v, i) => [v.n, nums[i]]));
  if ([...map].every(([a, b]) => a === b) || exporting) { renderVers(); return; }
  if (S.running) { runId++; cancelRenders(); setBusy(null); setRunning(false); } // la comparación en curso se rehace con el orden nuevo
  closeEditor(true); setMarking(false);
  const oldRef = verN(R.refN), newRef = order[0];
  if (newRef !== oldRef) {
    // la nueva primera versión pasa a ser la base de las notas: hace falta su alineación con la base actual
    if (!newRef.T) {
      const nb = act.find((x) => x !== newRef && x.D && Tof(x));
      if (!nb || !newRef.D) { setStatus("Para cambiar el orden, carga primero los archivos de todas las versiones."); renderVers(); return; }
      setBusy(`Alineando la versión ${newRef.n} con la ${nb.n}…`); await new Promise((r) => setTimeout(r, 30));
      try {
        const [ra, rb] = await rasterize([nb.D, newRef.D], true);
        const m = autoAlign(ra, rb, Math.max(ra.width, rb.width), Math.max(ra.height, rb.height));
        newRef.T = mul(Tof(nb), mul(inv(n2r(nb.D)), mul(m, n2r(newRef.D))));
      } catch (e) { console.error(e); setBusy(null); setStatus("No se pudo alinear la versión " + newRef.n + "."); renderVers(); return; }
      setBusy(null);
    }
    const Mi = inv(newRef.T); // base antigua -> nueva base
    for (const nt of R.notas) moverNota(nt, Mi);
    for (const x of act) { if (x === newRef) continue; if (x === oldRef) x.T = Mi; else if (x.T) x.T = mul(Mi, x.T); }
    newRef.T = null;
  }
  const m = (n) => (map.has(n) ? map.get(n) : n);
  for (const nt of R.notas) {
    nt.ver = m(nt.ver);
    if (nt.check) nt.check.ver = m(nt.check.ver);
    if (nt.cambios) { const c = {}; for (const [k, val] of Object.entries(nt.cambios)) { const [a, b] = k.split("-").map(Number); const x = m(a), y = m(b); c[`${Math.min(x, y)}-${Math.max(x, y)}`] = val; } nt.cambios = c; }
  }
  for (const v of act) v.n = map.get(v.n);
  R.refN = order[0].n;
  ON = new Set([...ON].map(m)); onOrder = onOrder.map(m);
  marcarSucio(); renderVers(); mostrar();
}

// muestra las versiones encendidas: una sola, o las dos (la más antigua es la referencia)
function mostrar() {
  closeEditor(true);
  const on = activas().filter((v) => ON.has(v.n) && v.D);
  if (!on.length) {
    Object.assign(S, { A: null, B: null, vA: null, vB: null, M: null, Mi: null });
    resetView(); renderNotes();
    const falta = activas().filter((v) => !v.D);
    showHome(falta.length ? "Carga los planos de esta revisión: " + falta.map((v) => `versión ${v.n} (${v.nombre})`).join(", ") + "." : "");
    return;
  }
  const [a, b] = on.length > 1 ? on.slice(-2) : [on[0], null];
  Object.assign(S, { vA: a, vB: b, A: a.D, B: b ? b.D : null, xf: null, view: "diff" });
  document.querySelectorAll("[data-view]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.view === "diff"));
  $("viewSeg").hidden = !b;
  if (b) { $("viewA").textContent = `Versión ${a.n}`; $("viewB").textContent = `Versión ${b.n}`; }
  clearError(); $("empty").hidden = true;
  run({ rerender: true });
}

// ---------- archivos: elegir, arrastrar y soltar ----------
let pendingFor = null; // versión a la que le falta el archivo y se eligió "Cargar"
$("addVer").onclick = () => { pendingFor = null; if (!activas().length) $("fileAny").click(); else $("fileVer").click(); };
$("openRev").onclick = () => $("fileRev").click();
$("loicaBtn").onclick = () => $("fileAny").click();
$("fileAny").onchange = async (e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length) await takeFiles(f); };
$("fileRev").onchange = async (e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length) await takeFiles(f); };
$("fileVer").onchange = async (e) => {
  const f = [...e.target.files]; e.target.value = ""; if (!f.length) return;
  const v = pendingFor; pendingFor = null;
  if (v && !v.D) await takeFiles(f, v); else await takeFiles(f);
};
const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
let dropTimer = 0;
function hideDrop() { $("drop").hidden = true; }
window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); $("drop").hidden = false; });
window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); e.dataTransfer.dropEffect = "copy"; $("drop").hidden = false;
  document.querySelector(".dz").classList.add("over");
  clearTimeout(dropTimer); dropTimer = setTimeout(hideDrop, 400);
});
window.addEventListener("drop", async (e) => { if (!hasFiles(e)) return; e.preventDefault(); clearTimeout(dropTimer); hideDrop(); await takeFiles([...e.dataTransfer.files]); });

// Una revisión guardada (.zip con sus planos, o .json de versiones anteriores) y planos sueltos juntos: primero se abre
// la revisión; los planos que trae el .zip van a su versión, los sueltos se reconocen por su huella o su nombre y los
// demás se agregan como versiones nuevas, en orden de nombre. Al abrir una revisión queda encendida la última versión.
const esPlano = (n) => /\.(pdf|dxf|dwg)$/i.test(n);
async function takeFiles(files, forVer = null) {
  if (exporting) return;
  const zips = files.filter((f) => /\.zip$/i.test(f.name)), jsons = files.filter((f) => /\.json$/i.test(f.name));
  const plans = files.filter((f) => esPlano(f.name)).sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true, sensitivity: "base" })).map((f) => ({ f, n: null }));
  if (!jsons.length && !plans.length && !zips.length) { showError("Solo se pueden cargar planos PDF o DXF, o una revisión guardada (.zip)."); return; }
  clearError();
  let rev = jsons[0] || null;
  for (const z of zips) {
    setBusy("Abriendo " + z.name + "…");
    const r = await leerZip(z); setBusy(null);
    if (!r) return;
    if (r.json && !rev) { rev = r.json; plans.unshift(...r.planos); } else plans.push(...r.planos.map(({ f }) => ({ f, n: null })));
  }
  if (!rev && !plans.length) { showError("El .zip no trae una revisión de RE-visión ni planos PDF o DXF."); return; }
  if (rev && !(await abrirRevision(rev, plans.length > 0))) return;
  let changed = !!rev, llenadas = 0, nuevas = 0;
  for (const { f, n } of plans) {
    setBusy("Leyendo " + f.name + "…"); await new Promise((r) => setTimeout(r, 30));
    let D; // el aviso de carga sigue arriba hasta leer el último plano
    try { D = await loadDoc(f); } catch (e) { setBusy(null); showError(`${f.name}: ${e.message || e}`); continue; }
    const falta = activas().filter((v) => !v.D), propia = n != null ? falta.find((x) => x.n === n) : null;
    const v = propia || (forVer && !forVer.D ? forVer : falta.find((x) => x.huella === D.huella) || falta.find((x) => x.nombre === f.name) || null);
    if (v) {
      if (!propia && v.huella && v.huella !== D.huella && (setBusy(null), true) && !(await preguntar(`${f.name} no es idéntico al archivo guardado de la versión ${v.n}. ¿Usarlo igual?`, "Usarlo"))) continue;
      if (v.pagina && v.pagina <= D.pages) D.page = v.pagina;
      v.D = D; v.paginas = D.pages; if (v === forVer) forVer = null;
      changed = true; llenadas++;
    } else if ((setBusy(null), await addVersion(D))) { changed = true; nuevas++; }
  }
  setBusy(null);
  // al abrir una revisión, o al cargar archivos que le faltaban, queda encendida la versión más nueva que tenga su plano
  if ((rev || llenadas) && !nuevas) setOn(activas().filter((v) => v.D).slice(-1).map((v) => v.n));
  renderVers();
  if (changed) mostrar();
}
// lee una revisión guardada en .zip: la revisión (.json) y los planos de cada versión (campo "archivo")
async function leerZip(file) {
  let zip;
  try { zip = await window.JSZip.loadAsync(file); } catch { showError(`${file.name} no es un .zip válido.`); return null; }
  const ents = Object.values(zip.files).filter((e) => !e.dir && !/(^|\/)(__MACOSX|\.)/.test(e.name));
  const js = ents.filter((e) => /\.json$/i.test(e.name)).sort((a, b) => a.name.split("/").length - b.name.split("/").length)[0];
  if (js) {
    const txt = await js.async("string");
    let o = null; try { o = JSON.parse(txt); } catch {}
    const json = new File([txt], js.name.split("/").pop(), { type: "application/json" }), planos = [];
    for (const v of (o && Array.isArray(o.vers) ? o.vers : [])) {
      const e = v && v.activa && typeof v.archivo === "string" ? zip.file(v.archivo) : null;
      if (e) planos.push({ f: new File([await e.async("blob")], v.nombre || v.archivo.split("/").pop()), n: v.n });
    }
    return { json, planos };
  }
  // un .zip solo con planos: se cargan como planos sueltos
  const planos = [];
  for (const e of ents.filter((e) => esPlano(e.name))) planos.push({ f: new File([await e.async("blob")], e.name.split("/").pop()), n: null });
  return { json: null, planos };
}

// ---------- loica: bienvenida y error ----------
let errTimer = 0, errTick = 0, errKind = null;
function showHome(msg) {
  $("emptyMsg").textContent = msg || ""; $("emptyMsg").hidden = !msg;
  if (!errKind) $("empty").hidden = false;
}
function showError(msg, kind = "error") {
  clearTimeout(errTimer); clearInterval(errTick);
  errKind = kind;
  $("errMsg").textContent = msg; $("errBtns").hidden = kind !== "nomatch";
  $("empty").hidden = true; $("errorView").hidden = false; document.querySelector(".credit").style.visibility = "hidden"; syncLoaded();
  let left = 10;
  const tick = () => { $("errCount").textContent = kind === "nomatch" ? `Volviendo en ${left} s.` : `Volviendo al inicio en ${left} s.`; };
  tick(); errTick = setInterval(() => { left = Math.max(1, left - 1); tick(); }, 1000);
  errTimer = setTimeout(backHome, 10000);
}
function clearError() { clearTimeout(errTimer); clearInterval(errTick); errKind = null; $("errorView").hidden = true; document.querySelector(".credit").style.visibility = ""; syncLoaded(); }
function backHome() {
  const nm = errKind === "nomatch";
  clearError();
  if (nm) { S.forceShow = true; return; } // "No match": se queda la comparación a la vista
  if (!S.rasterA) mostrar();
}
// en celular, el visor aparece cuando hay un plano cargado (o para mostrar un error)
function syncLoaded() { document.querySelector(".app").classList.toggle("loaded", !!S.A || !!errKind); }
const loicaTpl = $("loicaBtn").querySelector("svg").cloneNode(true);
let loicaT0 = 0, loicaTick = 0, loicaOn = false;
function loicaMsg() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return "drag";
  const t = (performance.now() - loicaT0) / 1000;
  const c = t % 21; // arrastrar 10 s, espera 6 s, tímido 5 s
  return c < 10 ? "drag" : c < 16 ? "wait" : "shy";
}
function loicaSync() {
  const on = !$("empty").hidden;
  if (on === loicaOn) return;
  loicaOn = on; clearInterval(loicaTick);
  if (!on) return;
  const svg = loicaTpl.cloneNode(true);
  $("loicaBtn").querySelector("svg").replaceWith(svg);
  loicaT0 = performance.now();
  const set = () => { const m = loicaMsg(); if (svg.getAttribute("data-msg") !== m) svg.setAttribute("data-msg", m); };
  set(); loicaTick = setInterval(set, 200);
}
new MutationObserver(loicaSync).observe($("empty"), { attributes: true, attributeFilter: ["hidden"] });
const SONG = "audio/loica-canto.mp3";
let song = null, singing = false;
// la loica con lupa: al cantar se detiene su animación (SMIL) en la pose de la lupa y mueve el pico al ritmo del canto
function stopSong() {
  singing = false;
  const svg = $("loicaBtn").querySelector("svg");
  if (svg) { svg.classList.remove("is-singing"); try { if (svg.animationsPaused && svg.animationsPaused()) svg.unpauseAnimations(); } catch {} }
  if (song) { song.pause(); song.currentTime = 0; }
}
$("loicaBtn").addEventListener("click", (e) => {
  if (!(e.target.closest && e.target.closest(".loica-bird"))) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (singing) return;
  singing = true;
  if (!song) { song = new Audio(SONG); song.preload = "auto"; song.volume = 0.5; song.onended = song.onerror = stopSong; }
  song.currentTime = 0;
  song.play().then(() => {
    if (!singing) return;
    const svg = $("loicaBtn").querySelector("svg");
    try { svg.pauseAnimations(); svg.setCurrentTime(0); } catch {}
    svg.classList.add("is-singing");
  }).catch(stopSong);
}, true);
new MutationObserver(() => { if ($("empty").hidden && singing) stopSong(); }).observe($("empty"), { attributes: true, attributeFilter: ["hidden"] });

// ---------- imágenes de las versiones ----------
// Igual que el Comparador A·B: DXF en mm cuando ambos dicen sus unidades, marco común si se traslapan,
// y PDF con una sola escala de puntos a píxeles para todos.
// all: con los elementos de anotación aunque el interruptor esté apagado (la alineación automática necesita los ejes)
async function rasterize(list, all = false) {
  const target = RES;
  S.mixed = list.length === 2 && list[0].kind !== list[1].kind;
  const prepDxf = (D, prims, bb) => {
    const pad = Math.round(target * 0.02), k = (target - 2 * pad) / Math.max(bb[2] - bb[0], bb[3] - bb[1]);
    Object.assign(D, { prims, bb, k, pad, W: Math.ceil((bb[2] - bb[0]) * k + 2 * pad), H: Math.ceil((bb[3] - bb[1]) * k + 2 * pad) });
  };
  const dx = list.filter((D) => D.kind === "dxf");
  if (dx.length === 2) {
    const [A, B] = dx, ua = mmPerUnit(A.dxf), ub = mmPerUnit(B.dxf);
    const fa = ua && ub ? ua : 1, fb = ua && ub ? ub : 1;
    const pa = dxfPrims(A.dxf, fa), pb = dxfPrims(B.dxf, fb); A.f = fa; B.f = fb;
    const ba = primBounds(pa), bbB = primBounds(pb);
    if (!ba || !bbB) throw new Error("Uno de los DXF no tiene entidades visibles en el espacio modelo.");
    const size = (b) => Math.max(b[2] - b[0], b[3] - b[1]), r = size(ba) / size(bbB);
    const overlap = Math.min(ba[2], bbB[2]) > Math.max(ba[0], bbB[0]) && Math.min(ba[3], bbB[3]) > Math.max(ba[1], bbB[1]);
    if (r > 0.5 && r < 2 && overlap) { const bb = primBounds(pa.concat(pb)); prepDxf(A, pa, bb); prepDxf(B, pb, bb); }
    else { prepDxf(A, pa, ba); prepDxf(B, pb, bbB); }
  } else {
    for (const D of dx) { D.f = 1; const p = dxfPrims(D.dxf), bb = primBounds(p); if (!bb) throw new Error("El DXF no tiene entidades visibles."); prepDxf(D, p, bb); }
  }
  const sizes = [];
  for (const D of list) if (D.kind === "pdf") { const p = await D.pdf.getPage(D.page), v = p.getViewport({ scale: 1 }); D.pw = v.width; D.ph = v.height; sizes.push(v.width, v.height); }
  const scale = sizes.length ? target / Math.max(...sizes) : 1;
  const out = [];
  for (const D of list) {
    if (D.kind === "pdf") {
      D.scale = scale; D.W = Math.floor(D.pw * scale); D.H = Math.floor(D.ph * scale);
      D.keepFills = null; D.fills = null;
      out.push(await renderSource(D, I, D.W, D.H, true, false, false, all));
      try { D.text = S.annot || all ? await pdfTexts(D) : []; } catch { D.text = []; }
    } else {
      const c = document.createElement("canvas"); c.width = D.W; c.height = D.H;
      const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, D.W, D.H);
      c.text = captureText(ctx);
      if (!S.annot && !all) dxfAnnots(D);
      if (!S.hatch) dxfHatch(D);
      const texts = []; drawPrims(ctx, D, I, texts, true, S.hatch, all); D.text = texts; out.push(c);
    }
    D.lines = textLines(D.text);
  }
  return out;
}

// El mismo muro puede quedar justo bajo el umbral de "relleno sin contorno" en una versión y sobre él en la otra:
// los rellenos en el mismo lugar se deciden igual en ambas (Comparador A·B v19).
async function reconcileFills(id) {
  const A = S.A, B = S.B;
  if (!B || S.hatch || A.kind !== "pdf" || B.kind !== "pdf" || !A.fills || !B.fills) return true;
  for (const f of A.fills) f.lone = f.lone0;
  for (const f of B.fills) f.lone = f.lone0;
  const m = S.xf.m, cell = 16, grid = new Map(), at = (x, y) => Math.round(x / cell) + "," + Math.round(y / cell);
  for (const f of B.fills) {
    const c = [[f.ob[0], f.ob[1]], [f.ob[2], f.ob[1]], [f.ob[2], f.ob[3]], [f.ob[0], f.ob[3]]].map(([x, y]) => apply(m, x, y));
    const b = [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))];
    const k = at(b[0], b[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push({ f, b });
  }
  for (const a of A.fills) {
    const gx = Math.round(a.ob[0] / cell), gy = Math.round(a.ob[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const { f, b } of grid.get(gx + dx + "," + (gy + dy)) || []) {
      if (f.lone0 === a.lone0 || Math.abs(b[0] - a.ob[0]) > 3 || Math.abs(b[1] - a.ob[1]) > 3 || Math.abs(b[2] - a.ob[2]) > 3 || Math.abs(b[3] - a.ob[3]) > 3) continue;
      a.lone = f.lone = a.pil || f.pil || (a.e + f.e) / 2 < LONE_EDGE;
    }
  }
  const { W, H } = S.frame;
  for (const D of [A, B]) {
    if (!D.fills.some((f) => f.lone !== f.drawn)) continue;
    D.keepFills = keepMap(D.fills);
    const c = await renderSource(D, I, D.W, D.H, true, true);
    if (id !== runId) return false;
    for (const f of D.fills) f.drawn = f.lone;
    if (D === A) { S.rasterA = c; S.maskA = inkMask(padTo(c, W, H), W, H); S.glyphA = glyphs(padTo(c.text, W, H), A); c.text = null; }
    else S.rasterB = c;
  }
  return true;
}
function glyphs(c, D) {
  const { W, H } = S.frame, g = inkMask(c, W, H);
  return D.lines.length && !g.includes(1) ? null : g;
}

// ---------- alineación entre versiones ----------
// Cada versión guarda T: sus coordenadas -> las de la versión base (la más antigua de la revisión).
// Con T de ambas, la alineación sale de ahí (así las notas y la comparación usan la misma); si falta, automática.
function alinear() {
  const tA = Tof(S.vA), tB = Tof(S.vB);
  if (tA && tB) return { mode: "chain", m: mul(n2r(S.A), mul(inv(tA), mul(tB, inv(n2r(S.B))))) };
  const [ra, rb] = S.full || [S.rasterA, S.rasterB]; S.full = null;
  return { mode: "auto", m: autoAlign(ra, rb, S.frame.W, S.frame.H) };
}
const relNative = () => mul(inv(n2r(S.A)), mul(S.xf.m, n2r(S.B))); // coordenadas de B -> de A
function fijarT(force = false) {
  const tA = Tof(S.vA), tB = Tof(S.vB), rel = relNative();
  if (tA && (!tB || force)) { if (S.vB.n !== R.refN) { S.vB.T = mul(tA, rel); marcarSucio(); } }
  else if (!tA && tB) { S.vA.T = mul(tB, inv(rel)); marcarSucio(); }
}
// Una versión sin T que no se puede deducir del par a la vista se alinea con la vecina que sí lo tiene.
async function ensureT(id) {
  const need = S.B ? (!Tof(S.vA) && !Tof(S.vB) ? [S.vA] : []) : (!Tof(S.vA) ? [S.vA] : []);
  const loaded = activas().filter((v) => v.D);
  for (const v of need) {
    const i = loaded.indexOf(v);
    const nb = loaded.slice(0, i).reverse().find((x) => Tof(x)) || loaded.slice(i + 1).find((x) => Tof(x));
    if (!nb) continue;
    setBusy(`Alineando la versión ${v.n} con la ${nb.n}…`);
    const [ra, rb] = await rasterize([nb.D, v.D], true);
    if (id !== runId) return;
    const W = Math.max(ra.width, rb.width), H = Math.max(ra.height, rb.height);
    const m = autoAlign(ra, rb, W, H);
    v.T = mul(Tof(nb), mul(inv(n2r(nb.D)), mul(m, n2r(v.D)))); marcarSucio();
  }
}

// ---------- comparación y vista ----------
let runId = 0;
function setRunning(on) {
  S.running = on;
  if (on) { $("dlPdf").disabled = $("dlDxf").disabled = $("verInforme").disabled = $("alignBtn").disabled = true; $("addNote").disabled = true; }
  else { exportButtons(); $("alignBtn").disabled = false; scheduleDetail(); } // con zoom, el detalle se rehace con el resultado nuevo
}
async function run({ rerender = false, keepAlign = false } = {}) {
  if (!S.A) return;
  const id = ++runId;
  cancelRenders(); detailId++; clearDetail();
  setBusy(S.B ? "Comparando versiones…" : "Preparando el plano…"); setRunning(true);
  if (rerender) S.stale = true;
  await new Promise((r) => setTimeout(r, 30));
  try {
    if (S.stale || !S.rasterA) {
      await ensureT(id); if (id !== runId) return;
      setBusy(S.B ? "Comparando versiones…" : "Preparando el plano…");
      // con "Elementos de anotación" apagado, la alineación automática se hace con los planos completos (con sus ejes)
      S.full = null;
      if (S.B && !S.annot && !(Tof(S.vA) && Tof(S.vB)) && (!keepAlign || !S.xf)) { S.full = await rasterize([S.A, S.B], true); if (id !== runId) return; }
      const rs = await rasterize(S.B ? [S.A, S.B] : [S.A]);
      if (id !== runId) return;
      S.rasterA = rs[0]; S.rasterB = rs[1] || null; S.stale = false; S.single = null; S.plain = null;
      S.frame = { W: Math.max(...rs.map((c) => c.width)), H: Math.max(...rs.map((c) => c.height)) };
      if (S.B) { S.maskA = inkMask(padTo(rs[0], S.frame.W, S.frame.H), S.frame.W, S.frame.H); S.glyphA = glyphs(padTo(rs[0].text, S.frame.W, S.frame.H), S.A); }
      for (const c of rs) c.text = c === rs[1] ? c.text : null;
      if (!keepAlign) S.xf = null;
    }
    if (S.B) {
      if (!S.xf) S.xf = alinear();
      fijarT();
      if (!(await reconcileFills(id))) return;
      S.bWarp = warp(S.rasterB, S.xf.m, S.frame.W, S.frame.H);
      S.glyphB = S.rasterB.text ? glyphs(warp(S.rasterB.text, S.xf.m, S.frame.W, S.frame.H), S.B) : null;
      compare();
      if (S.mixed && !rerender) setStatus("Las versiones tienen formatos distintos (PDF y DXF): revisa que calcen bien.");
    } else { S.result = null; S.xf = null; }
    const tA = Tof(S.vA);
    S.M = tA ? mul(n2r(S.A), inv(tA)) : null; S.Mi = S.M ? inv(S.M) : null;
    if (S.B && S.result) marcarCambios();
    $("empty").hidden = true;
    paint(); showResult(); renderNotes();
  } catch (e) {
    if (id !== runId || (e && e.name === "RenderingCancelledException")) return;
    console.error(e);
    showError("No se pudo preparar el plano: " + (e.message || e));
  } finally { if (id === runId) { setBusy(null); setRunning(false); } }
}
function compare() {
  const { W, H } = S.frame;
  S.neutral = matchTexts(S.A.lines, S.B.lines, S.xf.m); // el mismo texto con otra fuente no es un cambio
  const mA = S.maskA.slice(), mB = inkMask(S.bWarp, W, H);
  const Rr = classify(mA, mB, W, H, TOL, S.excl, S.neutral, S.glyphA, S.glyphB);
  // burbujas de eje y marcas de corte corridas sobre una línea que coincide: no son cambios
  S.moved = [];
  if (Rr.nAdd) {
    const dA = dilate(mA, W, H, TOL), dB = dilate(mB, W, H, TOL);
    S.moved = simbolosCorridos(Rr, mA, mB, dA, dB, W, H, S.A.lines, S.B.lines, S.xf.m);
    if (S.moved.length) aplicarCorridos(Rr, dA, dB, W, H, S.moved);
  }
  Rr.pct = Rr.nA + Rr.nB ? (Rr.nRem + Rr.nAdd) / (Rr.nA + Rr.nB) * 100 : 0;
  S.result = Rr;
}

// ---------- símbolos corridos sobre su línea ----------
// Una burbuja de eje que quedó más lejos sobre el mismo eje, o una marca de corte corrida sobre la misma línea,
// no es un cambio del proyecto: es la misma figura con el mismo texto, trasladada a lo largo de una línea que coincide.
// Se buscan por el texto (el mismo en las dos versiones, corrido solo en horizontal o en vertical), se confirman
// comparando la figura trasladada píxel a píxel y exigiendo una línea común que siga en esa dirección.
// Un eje que se movió de lado, uno nuevo o una letra distinta siguen en rojo.
function simbolosCorridos(Rr, mA, mB, dA, dB, W, H, linesA, linesB, M) {
  const out = [];
  if (!linesA || !linesB || !linesA.length || !linesB.length) return out;
  const norm = (s) => s.toLowerCase().replace(/\s+/g, "");
  const caja = (c) => { const xs = c.map((q) => q[0]), ys = c.map((q) => q[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  const enA = new Map();
  for (const t of linesA) {
    const k = norm(t.s); if (!k) continue;
    const bx = caja(t.c); if (!enA.has(k)) enA.set(k, []);
    enA.get(k).push({ cx: (bx[0] + bx[2]) / 2, cy: (bx[1] + bx[3]) / 2 });
  }
  const sB = scaleOf(M), add = Rr.add, com = Rr.com;
  const addD = dilate(add, W, H, 2), sello = new Int32Array(W * H);
  let nComp = 0;
  const maxR = 0.15 * Math.max(W, H);
  // lo rojo de B unido alrededor del texto, dentro de una ventana
  const figura = (seed, win) => {
    const id = ++nComp, px = [], st = [];
    let borde = false;
    for (let y = seed[1]; y < seed[3]; y++) for (let i = y * W + seed[0], e = y * W + seed[2]; i < e; i++) if (addD[i] && !sello[i]) { sello[i] = id; st.push(i); }
    if (!st.length) return null;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    while (st.length) {
      const i = st.pop(); px.push(i);
      const x = i % W, y = (i - x) / W;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let yy = y - 1; yy <= y + 1; yy++) {
        if (yy < win[1] || yy >= win[3]) { borde = true; continue; }
        for (let xx = x - 1; xx <= x + 1; xx++) {
          if (xx < win[0] || xx >= win[2]) { borde = true; continue; }
          const j = yy * W + xx; if (addD[j] && !sello[j]) { sello[j] = id; st.push(j); }
        }
      }
    }
    return { px, box: [x0, y0, x1 + 1, y1 + 1], borde };
  };
  // qué parte de la figura calza al trasladarla: lo de B sobre A y lo de A sobre B
  const puntaje = (f, dx, dy) => {
    let nb = 0, okb = 0, na = 0, oka = 0;
    for (const i of f.px) {
      const x = i % W, y = (i - x) / W, xa = x - dx, ya = y - dy;
      const j = xa >= 0 && ya >= 0 && xa < W && ya < H ? ya * W + xa : -1;
      if (mB[i]) { nb++; if (j >= 0 && dA[j]) okb++; }
      if (j >= 0 && mA[j]) { na++; if (dB[i]) oka++; }
    }
    return nb < 12 || na < 12 ? 0 : Math.min(okb / nb, oka / na);
  };
  // una línea común (gris) que sigue desde la figura en la dirección del corrimiento y pasa por su parte central
  const lineaComun = (bx, vert, largo) => {
    const [c0, c1] = vert ? [bx[0], bx[2]] : [bx[1], bx[3]], q = 0.3 * (c1 - c0);
    const a0 = Math.round(c0 + q), a1 = Math.round(c1 - q);
    for (let a = a0; a <= a1; a++) for (const dir of [1, -1]) {
      let b = vert ? (dir > 0 ? bx[3] - 3 : bx[1] + 2) : (dir > 0 ? bx[2] - 3 : bx[0] + 2), run = 0, gap = 0;
      while (run < largo) {
        if (b < 0 || b >= (vert ? H : W)) break;
        let hit = 0;
        for (let o = -1; o <= 1 && !hit; o++) {
          const c = a + o; if (c < 0 || c >= (vert ? W : H)) continue;
          hit = vert ? com[b * W + c] : com[c * W + b];
        }
        if (hit) { run += 1 + gap; gap = 0; } else if (++gap > 4) break;
        b += dir;
      }
      if (run >= largo) return true;
    }
    return false;
  };
  for (const t of linesB) {
    const k = norm(t.s), cand = enA.get(k); if (!cand) continue;
    const bx = caja(t.c.map((q) => apply(M, q[0], q[1]))), h = Math.max(4, t.h * sB);
    const cx = (bx[0] + bx[2]) / 2, cy = (bx[1] + bx[3]) / 2;
    // el mismo texto en A, corrido solo en horizontal o en vertical
    const ds = [];
    for (const a of cand) {
      const dx = cx - a.cx, dy = cy - a.cy, ax = Math.abs(dx), ay = Math.abs(dy), mayor = Math.max(ax, ay), menor = Math.min(ax, ay);
      if (mayor < 2 * TOL + 2 || mayor > 25 * h || menor > Math.max(3, 0.2 * h)) continue;
      ds.push(ax >= ay ? { dx: Math.round(dx), dy: 0, n: mayor } : { dx: 0, dy: Math.round(dy), n: mayor });
    }
    if (!ds.length) continue;
    ds.sort((p, q) => p.n - q.n);
    const R = Math.min(16 * h, maxR), m = 1.5 * h;
    const f = figura(clipRect([bx[0] - m, bx[1] - m, bx[2] + m, bx[3] + m], W, H), clipRect([cx - R, cy - R, cx + R, cy + R], W, H));
    // una figura acotada (no una línea larga que se movió de lado) y de tamaño de símbolo
    if (!f || f.borde) continue;
    for (const d of ds.slice(0, 3)) {
      let best = { v: 0 };
      for (let ey = -2; ey <= 2; ey++) for (let ex = -2; ex <= 2; ex++) {
        const v = puntaje(f, d.dx + ex, d.dy + ey); if (v > best.v) best = { v, dx: d.dx + ex, dy: d.dy + ey };
      }
      if (best.v < 0.9) continue;
      const vert = Math.abs(best.dy) > Math.abs(best.dx), b = f.box;
      if ((vert ? b[2] - b[0] : b[3] - b[1]) > 12 * h) continue;
      if (!lineaComun(b, vert, Math.max(25, vert ? b[3] - b[1] : b[2] - b[0]))) continue;
      const p = TOL + 3;
      out.push({ box: [Math.min(b[0], b[0] - best.dx) - p, Math.min(b[1], b[1] - best.dy) - p, Math.max(b[2], b[2] - best.dx) + p, Math.max(b[3], b[3] - best.dy) + p], dx: best.dx, dy: best.dy, s: t.s });
      break;
    }
  }
  return out;
}
// dentro de cada símbolo corrido, lo que calza con la otra versión trasladada pasa a gris
function aplicarCorridos(Rr, dA, dB, W, H, moved) {
  for (const mv of moved) {
    const [x0, y0, x1, y1] = clipRect(mv.box, W, H), dx = Math.round(mv.dx), dy = Math.round(mv.dy);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      if (Rr.add[i]) { const xa = x - dx, ya = y - dy; if (xa >= 0 && ya >= 0 && xa < W && ya < H && dA[ya * W + xa]) { Rr.add[i] = 0; Rr.com[i] = 1; Rr.nAdd--; } }
      if (Rr.rem[i]) { const xb = x + dx, yb = y + dy; if (xb >= 0 && yb >= 0 && xb < W && yb < H && dB[yb * W + xb]) { Rr.rem[i] = 0; Rr.com[i] = 1; Rr.nRem--; } }
    }
  }
}

function paintDiff(ctx, Rr, W, H, thick) {
  const img = ctx.createImageData(W, H), d = img.data;
  const remV = dilate(Rr.rem, W, H, thick), addV = dilate(Rr.add, W, H, thick), comV = dilate(Rr.com, W, H, thick);
  for (let i = 0, j = 0; i < W * H; i++, j += 4) {
    let c = null;
    // la anterior es la referencia, completa en gris; la nueva encima: lo que coincide gris, lo que la anterior no tiene en rojo
    if (Rr.com[i]) c = COL_MATCH; else if (addV[i]) c = COL_DIFF; else if (remV[i] || comV[i]) c = COL_MATCH;
    if (c) { d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2]; } else { d[j] = d[j + 1] = d[j + 2] = 255; }
    d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
function paint() {
  const { W, H } = S.frame;
  if (!S.out || S.out.width !== W || S.out.height !== H) { S.out = document.createElement("canvas"); S.out.width = W; S.out.height = H; }
  const ctx = S.out.getContext("2d", { willReadFrequently: true });
  if (!S.B) {
    if (!S.single) S.single = tint(padTo(S.rasterA, W, H), COL_SOLO);
    ctx.drawImage(S.single, 0, 0);
  } else if (S.view === "diff") paintDiff(ctx, S.result, W, H, 1);
  else {
    const v = plainView(S.view);
    if (v) ctx.drawImage(v, 0, 0);
    else { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H); makePlain().then((ok) => { if (ok) paint(); }); }
  }
  main.setCanvas(S.out);
  // copias reducidas que guardan el píxel más oscuro: al ver el plano entero no se pierden las líneas finas
  delete S.out._levels; main.setLevels(pyramid(S.out));
  scheduleDetail(); drawOverlay();
}
const plainKey = () => [S.rasterA, S.bWarp, S.hatch];
function plainView(v) { const p = S.plain; return p && p.key.every((k, i) => k === plainKey()[i]) ? p[v] : null; }
let plainBusy = null;
function makePlain() {
  if (plainBusy) return plainBusy;
  const key = plainKey(), { W, H } = S.frame;
  plainBusy = (async () => {
    let a = S.rasterA, b = S.rasterB;
    if (S.hatch) {
      setBusy("Preparando vista…");
      [a, b] = await Promise.all([renderSource(S.A, I, S.rasterA.width, S.rasterA.height, false, true, true), renderSource(S.B, I, S.rasterB.width, S.rasterB.height, false, true, true)]);
      setBusy(null);
    }
    if (!plainKey().every((k, i) => k === key[i])) return false;
    S.plain = { key, A: tint(padTo(a, W, H), COL_PLAIN.A), B: tint(warp(b, S.xf.m, W, H), COL_PLAIN.B) };
    return true;
  })().catch((e) => { setBusy(null); if (!(e && e.name === "RenderingCancelledException")) console.error(e); return false; }).finally(() => { plainBusy = null; });
  return plainBusy;
}
function showResult() {
  $("resultSec").hidden = false; // la tarjeta aparece con el primer plano cargado
  $("scoreRow").hidden = !(S.B && S.result); // con un solo plano no hay cuadro de cambios
  if (S.B && S.result) {
    const pct = S.result.pct;
    $("pct").innerHTML = (pct < 10 ? pct.toFixed(1) : Math.round(pct)).toString().replace(".", ",") + "<small>%</small>";
    $("pctLbl").textContent = `Cambios aproximados de la versión ${S.vB.n} respecto de la ${S.vA.n}`; $("pctLbl").classList.remove("pre"); $("alignBtn").hidden = false;
    const match = 100 - pct;
    if (match < NO_MATCH && !S.forceShow) { if (errKind !== "nomatch") showError(`No match: las versiones ${S.vA.n} y ${S.vB.n} coinciden solo en un ${Math.round(match)} %. Puede que no sean el mismo plano, o que no se hayan podido alinear.`, "nomatch"); }
    else if (errKind === "nomatch") clearError();
  } else {
    $("pct").textContent = "–"; $("pctLbl").classList.add("pre"); $("alignBtn").hidden = true;
    $("pctLbl").textContent = "Cambios entre versiones indicados en rojo";
  }
  showResultStatus(); exportButtons();
}
function showResultStatus() {}
function resetView() {
  runId++; cancelRenders(); detailId++; clearDetail(); setBusy(null);
  Object.assign(S, { result: null, rasterA: null, rasterB: null, xf: null, excl: [], running: false, frame: null, single: null, plain: null, forceShow: false });
  main.content.hidden = true; drawOverlay();
  $("pct").textContent = "–"; $("pctLbl").textContent = "Cambios entre versiones indicados en rojo"; $("pctLbl").classList.add("pre"); $("alignBtn").hidden = true;
  $("resultSec").hidden = true; $("scoreRow").hidden = true; $("viewSeg").hidden = true; setStatus(""); exportButtons(); syncLoaded();
}

// ---------- detalle nítido al acercar (igual que el Comparador A·B) ----------
let detailTimer = 0, detailId = 0, detailEl = null;
function clearDetail() { if (detailEl) { detailEl.remove(); detailEl = null; } }
function scheduleDetail() {
  clearTimeout(detailTimer);
  if (!S.frame || !S.rasterA || exporting || S.running) return;
  const z = main.s * DPR();
  if (z <= 1.1) { cancelRenders(); detailId++; clearDetail(); return; }
  if (detailEl && Math.abs(detailEl._z / z - 1) < 0.05 && covers(detailEl._r)) return;
  detailTimer = setTimeout(renderDetail, 220);
}
function covers(r) {
  const er = main.el.getBoundingClientRect(), a = main.toFrame(er.left, er.top), b = main.toFrame(er.right, er.bottom), { W, H } = S.frame;
  return r[0] <= Math.max(0, a[0]) + 0.5 && r[1] <= Math.max(0, a[1]) + 0.5 && r[2] >= Math.min(W, b[0]) - 0.5 && r[3] >= Math.min(H, b[1]) - 0.5;
}
async function renderDetail() {
  const id = ++detailId;
  cancelRenders();
  const { W, H } = S.frame, er = main.el.getBoundingClientRect();
  const a = main.toFrame(er.left, er.top), b = main.toFrame(er.right, er.bottom);
  let z = Math.min(main.s * DPR(), MAX_ZOOM * 2);
  const mx = (b[0] - a[0]) * 0.15, my = (b[1] - a[1]) * 0.15;
  let r = [Math.max(0, a[0] - mx), Math.max(0, a[1] - my), Math.min(W, b[0] + mx), Math.min(H, b[1] + my)];
  if ((r[2] - r[0]) * (r[3] - r[1]) * z * z > DETAIL_BUDGET) r = [Math.max(0, a[0]), Math.max(0, a[1]), Math.min(W, b[0]), Math.min(H, b[1])];
  const area = (r[2] - r[0]) * (r[3] - r[1]); if (area <= 1) return;
  if (area * z * z > DETAIL_BUDGET) z = Math.sqrt(DETAIL_BUDGET / area);
  try {
    const out = await renderRegion(r, z, S.view, Math.max(1, Math.round(DPR())), () => id !== detailId);
    if (!out || id !== detailId) return;
    out.className = "detail";
    Object.assign(out.style, { left: r[0] + "px", top: r[1] + "px", width: (r[2] - r[0]) + "px", height: (r[3] - r[1]) + "px" });
    out._z = z; out._r = r;
    clearDetail(); detailEl = out; main.content.appendChild(out);
    showResultStatus();
  } catch (e) {
    if (e && e.name === "RenderingCancelledException") return;
    console.error(e); if (id === detailId) showResultStatus();
  }
}
// dibuja el rectángulo r del marco a z px por px: un plano solo, una versión, o la comparación
async function renderRegion(r, z, view, thick, stale = () => false) {
  const w = Math.max(1, Math.round((r[2] - r[0]) * z)), h = Math.max(1, Math.round((r[3] - r[1]) * z));
  const TA = [z, 0, 0, z, -r[0] * z, -r[1] * z];
  if (!S.B) return tint(await renderSource(S.A, TA, w, h), COL_SOLO);
  const m = S.xf.m, TB = [z * m[0], z * m[1], z * m[2], z * m[3], z * (m[4] - r[0]), z * (m[5] - r[1])];
  if (view === "A") return tint(await renderSource(S.A, TA, w, h, false, false, true), COL_PLAIN.A);
  if (view === "B") return tint(await renderSource(S.B, TB, w, h, false, false, true), COL_PLAIN.B);
  const [cA, cB] = await Promise.all([renderSource(S.A, TA, w, h, true), renderSource(S.B, TB, w, h, true)]);
  if (stale()) return null;
  const tol = Math.round(TOL * z);
  const sc = (q) => [(q[0] - r[0]) * z, (q[1] - r[1]) * z, (q[2] - r[0]) * z, (q[3] - r[1]) * z];
  const g = S.glyphA && S.glyphB && S.neutral.length;
  const mA = inkMask(cA, w, h), mB = inkMask(cB, w, h);
  const Rr = classify(mA, mB, w, h, tol, S.excl.map(sc), S.neutral.map(sc), g && inkMask(cA.text, w, h), g && inkMask(cB.text, w, h));
  const mv = (S.moved || []).filter((m) => m.box[2] > r[0] && m.box[0] < r[2] && m.box[3] > r[1] && m.box[1] < r[3]);
  if (mv.length) aplicarCorridos(Rr, dilate(mA, w, h, tol), dilate(mB, w, h, tol), w, h, mv.map((m) => ({ box: sc(m.box), dx: m.dx * z, dy: m.dy * z })));
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  paintDiff(out.getContext("2d"), Rr, w, h, thick);
  return out;
}

// ---------- visor ----------
class Viewer {
  constructor(el, opts = {}) {
    this.el = el; this.opts = opts; this.s = 1; this.tx = 0; this.ty = 0; this.c = null; this.marks = [];
    this.content = document.createElement("div"); this.content.className = "content"; this.content.hidden = true; el.prepend(this.content);
    if (opts.overlay) { this.ov = document.createElement("canvas"); this.ov.className = "ov"; this.content.after(this.ov); }
    this.mlayer = document.createElement("div"); this.mlayer.className = "markers"; el.appendChild(this.mlayer);
    el.addEventListener("wheel", (e) => {
      if (e.target.closest(".noteedit, .errorview, .empty")) return;
      e.preventDefault(); const r = el.getBoundingClientRect(); this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)));
    }, { passive: false });
    const pts = new Map(); let down = null, pinch = null;
    el.addEventListener("pointerdown", (e) => {
      if (!this.c || this.content.hidden || e.target.closest(".errorview, .empty, .noteedit, a, button")) return;
      el.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) { const [p, q] = [...pts.values()]; pinch = { d: Math.hypot(p[0] - q[0], p[1] - q[1]) }; if (this.cap) { this.cap.up(null, false); this.cap = null; } down = null; return; }
      const cap = this.opts.capture && this.opts.capture(this.toFrame(e.clientX, e.clientY), e);
      if (cap) { this.cap = cap; down = null; return; }
      down = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false }; el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && pts.size === 2) {
        const [p, q] = [...pts.values()], d = Math.hypot(p[0] - q[0], p[1] - q[1]), r = el.getBoundingClientRect();
        this.zoomAt((p[0] + q[0]) / 2 - r.left, (p[1] + q[1]) / 2 - r.top, d / pinch.d); pinch.d = d; return;
      }
      if (this.cap) { this.cap.move(this.toFrame(e.clientX, e.clientY)); return; }
      if (!down) return; const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.hypot(dx, dy) > 4) down.moved = true;
      this.tx = down.tx + dx; this.ty = down.ty + dy; if (down.moved) this.touched = true; this.apply();
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pinch) { if (pts.size < 2) pinch = null; return; }
      if (this.cap) { const c = this.cap; this.cap = null; c.up(this.toFrame(e.clientX, e.clientY), e.type === "pointerup"); return; }
      if (!down) return; el.classList.remove("dragging");
      if (!down.moved && e.type === "pointerup" && this.opts.onClick) this.opts.onClick(this.toFrame(e.clientX, e.clientY));
      down = null;
    };
    el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    new ResizeObserver(() => { if (this.c && !this.touched) this.fit(); else this.apply(); }).observe(el);
  }
  setCanvas(c) {
    const same = this.c && this.c.width === c.width && this.c.height === c.height;
    if (this.c !== c) { if (this.c) this.c.remove(); this.content.prepend(c); this.c = c; }
    this.content.style.width = c.width + "px"; this.content.style.height = c.height + "px";
    this.content.hidden = false;
    if (!same) this.fit(); else this.apply();
  }
  fit() {
    if (!this.c) return; const w = this.el.clientWidth, h = this.el.clientHeight - (this.opts.padBottom || 0);
    this.s = Math.min(w / this.c.width, h / this.c.height) * 0.94; this.tx = (w - this.c.width * this.s) / 2; this.ty = (h - this.c.height * this.s) / 2; this.touched = false; this.apply();
  }
  zoomAt(x, y, f) { const ns = Math.min(MAX_ZOOM, Math.max(0.03, this.s * f)); f = ns / this.s; this.tx = x - (x - this.tx) * f; this.ty = y - (y - this.ty) * f; this.s = ns; this.touched = true; this.apply(); }
  zoomTo(x, y, w, h) {
    const vw = this.el.clientWidth, vh = this.el.clientHeight, m = Math.max(w, h) * 0.6 + 40;
    this.s = Math.min(MAX_ZOOM, Math.min(vw / (w + 2 * m), vh / (h + 2 * m))); this.tx = vw / 2 - (x + w / 2) * this.s; this.ty = vh / 2 - (y + h / 2) * this.s; this.touched = true; this.apply();
  }
  toFrame(cx, cy) { const r = this.el.getBoundingClientRect(); return [(cx - r.left - this.tx) / this.s, (cy - r.top - this.ty) / this.s]; }
  setLevels(levels) {
    for (const l of this.levels || []) l.c.remove();
    this.levels = levels; for (const l of levels) { l.c.className = "lvl"; this.content.appendChild(l.c); }
    this.apply();
  }
  apply() {
    this.content.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.s})`;
    if (this.c) this.c.style.imageRendering = this.s > 2 ? "pixelated" : "auto";
    if (this.levels) { const z = this.s * DPR(); let use = null; for (const l of this.levels) if (z * l.f <= 1.2) use = l; for (const l of this.levels) l.c.style.visibility = l === use ? "visible" : "hidden"; }
    this.mlayer.innerHTML = "";
    for (const m of this.marks) { const d = document.createElement("div"); d.className = "mk"; d.textContent = m.label; d.style.left = this.tx + m.x * this.s + "px"; d.style.top = this.ty + m.y * this.s + "px"; this.mlayer.appendChild(d); }
    if (this.opts.onView) this.opts.onView();
  }
}
const main = new Viewer($("vp"), {
  padBottom: 28, overlay: true,
  onView: () => { scheduleDetail(); drawOverlay(); },
  capture: (p) => captureNote(p),
  onClick: (p) => clickNote(p),
});

// La barra de arriba no muestra textos (pedido de Pipo). Solo los avisos que importan (un error, algo que no se pudo hacer)
// aparecen un momento en la burbuja negra del visor; los mensajes de "listo" no se muestran.
let avisoT = 0;
function setStatus(t) {
  if (!t) return;
  if ($("addNote").getAttribute("aria-pressed") === "true") return; // la burbuja está guiando el rectángulo de la nota
  clearTimeout(avisoT); hint(t);
  avisoT = setTimeout(() => { if ($("addNote").getAttribute("aria-pressed") !== "true") hint(""); }, 6000);
}
let busyEl = null;
function setBusy(t) {
  if (t) { if (!busyEl) { busyEl = document.createElement("div"); busyEl.className = "busy"; busyEl.innerHTML = "<div></div>"; $("vp").appendChild(busyEl); } busyEl.firstChild.textContent = t; }
  else if (busyEl) { busyEl.remove(); busyEl = null; }
  $("vp").classList.toggle("is-busy", !!t);
}
function setView(v) { S.view = v; document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === v)); if (S.frame) { detailId++; clearDetail(); paint(); } }
document.querySelectorAll("[data-view]").forEach((b) => b.onclick = () => setView(b.dataset.view));
$("zIn").onclick = () => main.zoomAt(main.el.clientWidth / 2, main.el.clientHeight / 2, 1.6);
$("zOut").onclick = () => main.zoomAt(main.el.clientWidth / 2, main.el.clientHeight / 2, 1 / 1.6);
$("zFit").onclick = () => main.fit();
$("nmShow").onclick = () => { S.forceShow = true; clearError(); };
$("nmAlign").onclick = () => { S.forceShow = true; clearError(); openManual(); };
$("alignBtn").onclick = () => { if (errKind === "nomatch") clearError(); openManual(); };
// Interruptores Hatchs y Elementos de anotación (los del Comparador A·B v23), prendidos de partida.
// Apagados, eso no se dibuja, no se compara ni va al DXF. Cambiar uno vuelve a dibujar las versiones con la misma alineación.
for (const [id, key] of [["hatchBtn", "hatch"], ["annotBtn", "annot"]]) $(id).onclick = () => {
  if (exporting) return;
  S[key] = !S[key]; $(id).setAttribute("aria-checked", S[key]);
  if (S.A) run({ rerender: true, keepAlign: true });
};

// ---------- notas ----------
// Las notas se guardan en coordenadas de la versión base, así siguen en su lugar en cualquier versión alineada.
const NS = { marking: false, ed: null, pen: null, showChecked: false };
let rubber = null, stroke = null;
const IMG = new Map(); // id de nota -> imagen cargada
const visible = (nt) => nt.estado === "abierta" || (NS.showChecked && nt.estado === "check");
function corners(nt, M = S.M) { return [[nt.x0, nt.y0], [nt.x1, nt.y0], [nt.x1, nt.y1], [nt.x0, nt.y1]].map(([x, y]) => apply(M, x, y)); }
function bbox(c) { const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }
function noteImg(nt) {
  if (!nt.img) return null;
  let im = IMG.get(nt.id);
  if (!im || im._src !== nt.img.src) { im = new Image(); im._src = nt.img.src; im.onload = () => drawOverlay(); im.src = nt.img.src; IMG.set(nt.id, im); }
  return im.complete && im.naturalWidth ? im : null;
}
// Dibuja una nota con P: coordenadas base -> px del lienzo. u: grosor de línea por px.
function paintNote(g, nt, P, u, { editing = false } = {}) {
  const c = [[nt.x0, nt.y0], [nt.x1, nt.y0], [nt.x1, nt.y1], [nt.x0, nt.y1]].map(([x, y]) => P(x, y)), b = bbox(c);
  const ck = nt.estado === "check", col = ck ? COL_CHECK : COL_NOTE;
  g.save(); g.lineJoin = "round"; g.lineCap = "round";
  g.beginPath(); c.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath();
  g.fillStyle = ck ? "rgba(111,124,136,.07)" : nt.grave ? "rgba(237,65,51,.07)" : "rgba(217,138,0,.09)"; g.fill();
  g.lineWidth = (nt.grave && !ck ? 2.6 : 2) * u; g.strokeStyle = col; if (ck) g.setLineDash([6 * u, 4 * u]); g.stroke(); g.setLineDash([]);
  for (const tr of nt.trazos || []) strokePath(g, tr, P, u, ck);
  if (editing) { g.strokeStyle = "#28251f"; g.lineWidth = 1.2 * u; g.setLineDash([5 * u, 4 * u]); g.strokeRect(b[0] - 4 * u, b[1] - 4 * u, b[2] - b[0] + 8 * u, b[3] - b[1] + 8 * u); g.setLineDash([]); }
  // número en la esquina; las graves en rojo con un aviso; un clip si la nota tiene imagen adjunta
  const r = 11 * u, x = b[0], y = b[1];
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = ck ? COL_CHECK : nt.grave ? COL_GRAVE : COL_NOTE; g.fill();
  g.lineWidth = 1.5 * u; g.strokeStyle = "#fff"; g.stroke();
  g.fillStyle = "#fff"; g.font = `600 ${12 * u}px 'IBM Plex Sans', Arial, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(ck ? "✓" : String(nt.n), x, y + 0.5 * u);
  let tx = x + r + 3 * u;
  if (nt.grave && !ck) {
    const ty = y, s = 9 * u;
    g.beginPath(); g.moveTo(tx + s, ty - s); g.lineTo(tx + 2 * s, ty + s * 0.75); g.lineTo(tx, ty + s * 0.75); g.closePath();
    g.fillStyle = COL_GRAVE; g.fill(); g.strokeStyle = "#fff"; g.lineWidth = 1.2 * u; g.stroke();
    g.fillStyle = "#fff"; g.font = `700 ${10 * u}px Arial, sans-serif`; g.fillText("!", tx + s, ty + 1.5 * u);
    tx += 2 * s + 3 * u;
  }
  if (nt.img) clipIcon(g, tx + 8 * u, y, u, ck ? COL_CHECK : "#61594b");
  g.restore();
}
// clip de "imagen adjunta", centrado en (cx, cy)
function clipIcon(g, cx, cy, u, col) {
  g.save(); g.translate(cx - 9 * u, cy - 9 * u); g.scale(0.75 * u, 0.75 * u);
  g.beginPath(); g.arc(12, 12, 13, 0, Math.PI * 2); g.fillStyle = "#fff"; g.fill(); g.lineWidth = 1.6; g.strokeStyle = col; g.stroke();
  g.lineWidth = 2; g.lineCap = "round"; g.lineJoin = "round";
  g.stroke(new Path2D("M18.5 11.5 11.7 18.3a4.2 4.2 0 0 1-6-6l7-7a2.8 2.8 0 0 1 4 4l-7 7a1.4 1.4 0 0 1-2-2l6.4-6.4"));
  g.restore();
}
function strokePath(g, tr, P, u, faded = false) {
  const p = tr.p; if (p.length < 2) return;
  g.save(); g.strokeStyle = PEN[tr.c] || PEN.r; g.globalAlpha = faded ? 0.45 : 1; g.lineWidth = 2.5 * u; g.lineCap = "round"; g.lineJoin = "round";
  g.beginPath();
  for (let i = 0; i < p.length; i += 2) { const q = P(p[i], p[i + 1]); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }
  if (p.length === 2) { const q = P(p[0], p[1]); g.lineTo(q[0] + 0.1, q[1]); }
  g.stroke(); g.restore();
}
function drawOverlay() {
  const v = main; if (!v.ov) return;
  const d = DPR(), cw = v.el.clientWidth, ch = v.el.clientHeight;
  for (const c of [v.ov]) {
    if (c.width !== Math.round(cw * d) || c.height !== Math.round(ch * d)) { c.width = Math.round(cw * d); c.height = Math.round(ch * d); c.style.width = cw + "px"; c.style.height = ch + "px"; }
    const x = c.getContext("2d"); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height); x.setTransform(d, 0, 0, d, 0, 0);
  }
  if (!S.M || v.content.hidden) { placeEditor(); return; }
  const g = v.ov.getContext("2d");
  const P = (x, y) => { const f = apply(S.M, x, y); return [v.tx + f[0] * v.s, v.ty + f[1] * v.s]; };
  for (const nt of R.notas.filter(visible).sort((a, b) => (a.estado === "check") - (b.estado === "check") || a.n - b.n)) paintNote(g, nt, P, 1, { editing: NS.ed && NS.ed.nt === nt });
  if (stroke) strokePath(g, stroke, P, 1);
  if (rubber) {
    const a = [v.tx + rubber.a[0] * v.s, v.ty + rubber.a[1] * v.s], b = [v.tx + rubber.b[0] * v.s, v.ty + rubber.b[1] * v.s];
    g.save(); g.strokeStyle = COL_NOTE; g.lineWidth = 1.5; g.setLineDash([6, 4]); g.fillStyle = "rgba(217,138,0,.08)";
    g.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    g.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); g.restore();
  }
  placeEditor();
}
function hint(t) { $("hint").textContent = t || ""; $("hint").hidden = !t; }
function setMarking(on) {
  if (on && (!S.M || S.running)) return;
  if (on) closeEditor(true);
  NS.marking = on; $("vp").classList.toggle("marking", on);
  $("addNote").setAttribute("aria-pressed", on); $("addNote").title = on ? "Apretar de nuevo (o Esc) para no agregar la nota" : "";
  hint(on ? "Haz un rectángulo para observar" : "");
}
$("addNote").onclick = () => setMarking(!NS.marking);
// arrastrar: marca la región de una nota nueva, o dibuja dentro de la nota abierta con el lápiz elegido
function captureNote(p) {
  if (!S.M) return null;
  if (NS.marking) {
    rubber = { a: p, b: p };
    return {
      move: (q) => { rubber.b = q; drawOverlay(); },
      up: (q, ok) => {
        const r = rubber; rubber = null;
        if (ok && q) r.b = q;
        const w = Math.abs(r.b[0] - r.a[0]) * main.s, h = Math.abs(r.b[1] - r.a[1]) * main.s;
        if (ok && w > 8 && h > 8) crearNota(r.a, r.b); else drawOverlay();
      },
    };
  }
  if (NS.ed && NS.pen) {
    const nt = NS.ed.nt, q = apply(S.Mi, p[0], p[1]);
    if (q[0] < nt.x0 || q[0] > nt.x1 || q[1] < nt.y0 || q[1] > nt.y1) return null;
    stroke = { c: NS.pen, p: [q[0], q[1]] };
    let last = [p[0] * main.s, p[1] * main.s];
    return {
      move: (f) => {
        if (Math.hypot(f[0] * main.s - last[0], f[1] * main.s - last[1]) < 1.5) return;
        last = [f[0] * main.s, f[1] * main.s];
        const w = apply(S.Mi, f[0], f[1]);
        stroke.p.push(Math.min(nt.x1, Math.max(nt.x0, w[0])), Math.min(nt.y1, Math.max(nt.y0, w[1]))); drawOverlay();
      },
      up: (f, ok) => { if (ok && stroke && stroke.p.length >= 4) { (nt.trazos = nt.trazos || []).push(stroke); } stroke = null; drawOverlay(); },
    };
  }
  return null;
}
function noteAt(p) {
  const tol = 12 / main.s;
  const list = R.notas.filter(visible).sort((a, b) => b.n - a.n);
  for (const nt of list) { const b = bbox(corners(nt)); if (Math.hypot(p[0] - b[0], p[1] - b[1]) < tol * 1.2) return nt; }
  for (const nt of list) { const b = bbox(corners(nt)); if (p[0] >= b[0] - tol && p[0] <= b[2] + tol && p[1] >= b[1] - tol && p[1] <= b[3] + tol) return nt; }
  return null;
}
function clickNote(p) {
  if (!S.M || NS.marking) return;
  const nt = noteAt(p);
  if (NS.ed) { if (nt === NS.ed.nt) return; closeEditor(true); }
  if (nt) openEditor(nt, false);
}
function crearNota(a, b) {
  const c = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]].map(([x, y]) => apply(S.Mi, x, y)), bb = bbox(c);
  const nt = { id: uid(), n: ++R.notaCont, ver: newestShown().n, x0: bb[0], y0: bb[1], x1: bb[2], y1: bb[3], texto: "", grave: false, estado: "abierta", creada: iso(), trazos: [], img: null, cambios: {} };
  R.notas.push(nt); setMarking(false); openEditor(nt, true);
}
const snap = (nt) => JSON.stringify({ texto: nt.texto, grave: nt.grave, trazos: nt.trazos, img: nt.img });
function openEditor(nt, nueva) {
  NS.ed = { nt, nueva, prev: snap(nt) }; setPen(null);
  const ck = nt.estado === "check";
  $("noteLbl").textContent = `Nota ${nt.n}`;
  $("noteMeta").textContent = `Versión ${nt.ver} · ${fecha(nt.creada)}` + (ck ? ` · check en la versión ${nt.check ? nt.check.ver : "?"}` : "");
  $("noteText").value = nt.texto === SIN_COM ? "" : nt.texto;
  $("noteGrave").setAttribute("aria-pressed", !!nt.grave); $("noteEdit").classList.toggle("grave", !!nt.grave);
  showThumb(nt);
  $("noteCheck").textContent = ck ? "Reabrir" : "✓ Check"; $("noteCheck").hidden = nueva;
  $("noteDel").hidden = nueva;
  const ch = cambioTxt(nt); $("noteChg").hidden = !ch; if (ch) { $("noteChg").textContent = ch.t; $("noteChg").classList.toggle("chg", ch.chg); }
  $("noteEdit").hidden = false; placeEditor();
  setTimeout(() => $("noteText").focus(), 0);
  drawOverlay(); renderNotes();
}
function closeEditor(save) {
  const ed = NS.ed; if (!ed) return;
  NS.ed = null; setPen(null); stroke = null;
  const nt = ed.nt;
  if (save) nt.texto = $("noteText").value.trim(); else Object.assign(nt, JSON.parse(ed.prev));
  // una nota nueva se queda aunque no tenga texto (se borra solo con el basurero)
  if (!nt.texto) nt.texto = SIN_COM;
  if (snap(nt) !== ed.prev || ed.nueva) marcarSucio();
  $("noteEdit").hidden = true; renderNotes(); drawOverlay();
}
function quitarNota(nt) {
  const i = R.notas.indexOf(nt); if (i >= 0) R.notas.splice(i, 1);
  if (nt.n === R.notaCont) R.notaCont--; // un número recién creado y descartado se vuelve a usar
  IMG.delete(nt.id);
}
function setPen(c) {
  NS.pen = c;
  document.querySelectorAll(".pen[data-pen]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.pen === c));
  $("vp").classList.toggle("drawing", !!c);
  if (NS.ed) hint(c ? "Dibuja arrastrando dentro de la región de la nota. Para mover el plano, apaga el lápiz." : "");
}
document.querySelectorAll(".pen[data-pen]").forEach((b) => (b.onclick = () => setPen(NS.pen === b.dataset.pen ? null : b.dataset.pen)));
$("penUndo").onclick = () => { if (NS.ed && NS.ed.nt.trazos && NS.ed.nt.trazos.length) { NS.ed.nt.trazos.pop(); drawOverlay(); } };
$("noteGrave").onclick = () => { if (!NS.ed) return; const nt = NS.ed.nt; nt.grave = !nt.grave; $("noteGrave").setAttribute("aria-pressed", nt.grave); $("noteEdit").classList.toggle("grave", nt.grave); drawOverlay(); };
$("noteOk").onclick = () => closeEditor(true);
$("noteCancel").onclick = () => closeEditor(false);
$("noteCheck").onclick = () => {
  if (!NS.ed) return; const nt = NS.ed.nt;
  if (nt.estado === "check") { nt.estado = "abierta"; delete nt.check; }
  else { nt.estado = "check"; nt.check = { ver: newestShown() ? newestShown().n : nt.ver, fecha: iso() }; }
  NS.ed.prev = ""; closeEditor(true); // cuenta como cambio
};
$("noteDel").onclick = async () => {
  if (!NS.ed) return; const nt = NS.ed.nt;
  if (!(await preguntar(`¿Eliminar la nota ${nt.n}?\nSi la observación quedó resuelta, usa Check: la nota se oculta y queda en el registro.`, "Eliminar"))) return;
  NS.ed = null; setPen(null); quitarNota(nt); $("noteEdit").hidden = true; marcarSucio(); renderNotes(); drawOverlay();
};
$("noteText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) closeEditor(true); });
// imagen adjunta a la nota: con el clip o pegándola (Ctrl+V). Se ve en miniatura en la nota y grande en el informe.
$("noteImg").onclick = () => $("imgFile").click();
$("noteImgDel").onclick = () => { if (!NS.ed) return; NS.ed.nt.img = null; IMG.delete(NS.ed.nt.id); showThumb(NS.ed.nt); drawOverlay(); };
$("noteThumbBtn").onclick = () => { $("noteThumb").classList.toggle("big"); placeEditor(); };
$("imgFile").onchange = async (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) await adjuntarImagen(f); };
async function adjuntarImagen(f) {
  if (!NS.ed) return;
  const nt = NS.ed.nt;
  try { nt.img = await leerImagen(f); IMG.delete(nt.id); showThumb(nt); drawOverlay(); }
  catch { setStatus("No se pudo leer la imagen."); }
}
function showThumb(nt) {
  const has = !!(nt && nt.img);
  $("noteThumb").hidden = !has; $("noteThumb").classList.remove("big");
  if (has) $("noteThumbImg").src = nt.img.src; else $("noteThumbImg").removeAttribute("src");
  $("noteImg").title = has ? "Cambiar la imagen adjunta (también puedes pegar otra con Ctrl+V)" : "Adjuntar imagen (también puedes pegarla con Ctrl+V)";
  placeEditor();
}
// pegar una imagen mientras la nota está abierta (captura de pantalla, imagen copiada de una web o de un PDF)
window.addEventListener("paste", (e) => {
  if (!NS.ed || $("noteEdit").hidden) return;
  const items = [...((e.clipboardData && e.clipboardData.items) || [])];
  const it = items.find((i) => i.kind === "file" && /^image\//.test(i.type));
  if (!it) return;
  const f = it.getAsFile(); if (!f) return;
  e.preventDefault();
  adjuntarImagen(new File([f], f.name && f.name !== "image.png" ? f.name : "imagen-pegada.png", { type: f.type }));
});
// la imagen se guarda dentro de la revisión, reducida a 1400 px como máximo
async function leerImagen(f) {
  const url = URL.createObjectURL(f);
  try {
    const im = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const k = Math.min(1, 1400 / Math.max(im.naturalWidth, im.naturalHeight)), w = Math.round(im.naturalWidth * k), h = Math.round(im.naturalHeight * k);
    const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(im, 0, 0, w, h);
    return { src: c.toDataURL("image/jpeg", 0.86), w, h, nombre: f.name };
  } finally { URL.revokeObjectURL(url); }
}
// el editor se ubica al lado de la nota, dentro del visor
function placeEditor() {
  const box = $("noteEdit"); if (!NS.ed || box.hidden || !S.M) return;
  const v = main, b = bbox(corners(NS.ed.nt)), x0 = v.tx + b[0] * v.s, y0 = v.ty + b[1] * v.s, x1 = v.tx + b[2] * v.s, y1 = v.ty + b[3] * v.s;
  const W = v.el.clientWidth, H = v.el.clientHeight, w = box.offsetWidth, h = box.offsetHeight, m = 12;
  let x = x1 + m, y = y0;
  if (x + w > W - 8) x = x0 - w - m;
  if (x < 8) { x = Math.min(Math.max(8, x0), W - w - 8); y = y1 + m; if (y + h > H - 30) y = y0 - h - m; }
  y = Math.min(Math.max(8, y), Math.max(8, H - h - 30));
  box.style.left = x + "px"; box.style.top = y + "px";
}
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (NS.marking) { setMarking(false); return; }
  if (NS.ed) { if (NS.pen) setPen(null); else closeEditor(false); }
});
function focusNote(nt) { if (!S.M) return; const b = bbox(corners(nt)); main.zoomTo(b[0], b[1], b[2] - b[0], b[3] - b[1]); }
// ¿cambió el plano dentro de la nota con la versión nueva?
function marcarCambios() {
  const { W, H } = S.frame, Rr = S.result;
  for (const nt of R.notas) {
    if (nt.estado !== "abierta" || nt.ver > S.vA.n) continue;
    const b = bbox(corners(nt)), r = clipRect(b, W, H); let n = 0;
    for (let y = r[1]; y < r[3]; y++) for (let i = y * W + r[0], e = y * W + r[2]; i < e; i++) n += Rr.add[i] | Rr.rem[i];
    const area = Math.max(1, (r[2] - r[0]) * (r[3] - r[1])), hay = n > Math.max(6, area * 0.0004);
    nt.cambios = nt.cambios || {};
    const k = `${S.vA.n}-${S.vB.n}`; // entre qué versiones se miró
    if (nt.cambios[k] !== hay) { nt.cambios[k] = hay; marcarSucio(); }
  }
}
function cambioTxt(nt) {
  const k = S.vB ? `${S.vA.n}-${S.vB.n}` : null;
  if (!k || !nt.cambios || nt.cambios[k] === undefined) return null;
  const entre = `de la versión ${S.vA.n} a la ${S.vB.n}`;
  return nt.cambios[k] ? { chg: true, t: `Hubo cambios en esta zona ${entre}.`, c: `cambió ${entre}` } : { chg: false, t: `Sin cambios en esta zona ${entre}.`, c: `sin cambios ${entre}` };
}
function renderNotes() {
  const box = $("noteList"); box.textContent = "";
  $("notesSec").hidden = !R.notas.length; // el cuadro de notas aparece con la primera nota
  const ab = R.notas.filter((n) => n.estado === "abierta").sort((a, b) => a.n - b.n), gr = ab.filter((n) => n.grave), ot = ab.filter((n) => !n.grave);
  const ck = R.notas.filter((n) => n.estado === "check").sort((a, b) => a.n - b.n);
  const item = (nt) => {
    const b = document.createElement("button"); b.type = "button";
    b.className = "nt" + (nt.grave ? " grave" : "") + (nt.estado === "check" ? " ck" : "") + (NS.ed && NS.ed.nt === nt ? " sel" : "");
    const ch = cambioTxt(nt);
    b.innerHTML = `<span class="num">${nt.estado === "check" ? "✓" : nt.n}</span><span class="tx">${esc(nt.texto || SIN_COM)}</span>` +
      `<span class="mt">${nt.grave ? '<span class="gtag">Grave</span>' : ""}<span>N° ${nt.n} · versión ${nt.ver}</span>` +
      (nt.img ? `<span class="clip" title="Con imagen adjunta"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 11.5 12.2 19.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/></svg>imagen</span>` : "") +
      (nt.estado === "check" ? `<span>check en la versión ${nt.check ? nt.check.ver : "?"}</span>` : ch ? `<span class="${ch.chg ? "chg" : "same"}">${ch.c}</span>` : "") + "</span>";
    b.onclick = () => { if (!S.M) return; if (NS.ed) closeEditor(true); if (!visible(nt)) return; focusNote(nt); openEditor(nt, false); };
    return b;
  };
  const sec = (t, list, cls = "") => { if (!list.length) return; const h = document.createElement("h3"); h.textContent = t; if (cls) h.className = cls; box.append(h, ...list.map(item)); };
  sec(`Graves (${gr.length})`, gr, "gr");
  sec(gr.length ? `Otras observaciones (${ot.length})` : `Observaciones (${ot.length})`, ot);
  if (NS.showChecked) sec(`En check (${ck.length})`, ck);
  $("showChecked").hidden = !ck.length;
  $("showChecked").textContent = NS.showChecked ? "Ocultar notas en check" : `Ver notas en check (${ck.length})`;
  $("showChecked").setAttribute("aria-pressed", NS.showChecked);
  $("addNote").disabled = !S.M || S.running || exporting;
  $("notesHint").textContent = !S.A ? (R.notas.length ? `${R.notas.length} nota${R.notas.length > 1 ? "s" : ""} guardada${R.notas.length > 1 ? "s" : ""}. Carga los planos para verlas.` : "Carga un plano para empezar a dejar notas.")
    : !S.M ? "No se pudo ubicar esta versión respecto de las notas. Prende también la versión anterior."
    : !R.notas.length ? "Aprieta Agregar nota y haz un rectángulo sobre el plano. Dentro puedes escribir, marcar si es grave, dibujar y adjuntar una imagen."
    : !ab.length ? "Todas las notas están en check." : "";
  $("notesHint").hidden = !$("notesHint").textContent;
}
$("showChecked").onclick = () => { NS.showChecked = !NS.showChecked; if (NS.ed && NS.ed.nt.estado === "check" && !NS.showChecked) closeEditor(true); renderNotes(); drawOverlay(); };

// ---------- datos de la revisión ----------
const FIELDS = { fProyecto: "proyecto", fDetalle: "detalle", fCreador: "creador", fRevisor: "revisor" };
for (const [id, k] of Object.entries(FIELDS)) $(id).addEventListener("input", (e) => { R[k] = e.target.value; marcarSucio(); });
function fillFields() { for (const [id, k] of Object.entries(FIELDS)) $(id).value = R[k] || ""; }

// ---------- guardar y abrir la revisión (.zip con la revisión en .json y los planos de cada versión) ----------
const nombreBase = () => ["RE-vision", stem(R.proyecto || "proyecto"), R.detalle ? stem(R.detalle) : null, "V" + (activas().length ? activas().at(-1).n : 0)].filter(Boolean).join("_");
// arch: n de versión -> ruta de su plano dentro del .zip
function revisionJson(arch = new Map()) {
  const o = { ...R, guardada: iso(), versionActual: activas().length ? activas().at(-1).n : null };
  o.vers = R.vers.map(({ D, archivo, ...v }) => (arch.has(v.n) ? { ...v, archivo: arch.get(v.n) } : v));
  return JSON.stringify(o, null, 1);
}
const MB = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0).replace(".", ",") + " MB";
async function zipRevision(conPlanos) {
  const base = nombreBase(), zip = new window.JSZip(), arch = new Map();
  if (conPlanos) for (const v of activas()) if (v.D && v.D.file) {
    arch.set(v.n, `planos/V${v.n}/${v.nombre.replace(/[\\/:*?"<>|]/g, "_")}`);
    // los PDF ya vienen comprimidos; los DXF son texto y se comprimen bien
    zip.file(arch.get(v.n), v.D.file, { compression: v.tipo === "pdf" ? "STORE" : "DEFLATE" });
  }
  zip.file(base + ".json", revisionJson(arch), { compression: "DEFLATE" });
  return [base + ".zip", await zip.generateAsync({ type: "blob", compressionOptions: { level: 6 } }), arch.size];
}
$("saveRev").onclick = async () => {
  if (exporting) return;
  closeEditor(true);
  setExporting(true);
  try {
    setBusy("Guardando la revisión con sus planos…");
    const [name, blob, n] = await zipRevision(true);
    setBusy(null);
    let ok = await offerFile(name, blob);
    if (!ok && dlErr === "too_large" && n && await preguntar(`La revisión con sus planos pesa ${MB(blob.size)} y es demasiado grande para descargarla aquí. ¿Guardarla sin los planos? Al abrirla tendrás que cargarlos de nuevo.`, "Guardar sin planos")) {
      const [name2, blob2] = await zipRevision(false);
      ok = await offerFile(name2, blob2);
    }
    if (ok) marcarGuardado();
  } catch (e) { console.error(e); setStatus("No se pudo guardar la revisión: " + (e.message || e)); }
  finally { setBusy(null); setExporting(false); renderVers(); exportButtons(); }
};
async function abrirRevision(file, conPlanos = false) {
  let o;
  try { o = JSON.parse(await file.text()); } catch { showError(`${file.name} no es una revisión válida.`); return false; }
  if (!o || typeof o.app !== "string" || !o.app.startsWith("RE-vision") || !Array.isArray(o.vers) || !Array.isArray(o.notas)) { showError(`${file.name} no es una revisión de RE-visión.`); return false; }
  if ((R.vers.length || R.notas.length) && sucio && !(await preguntar("Hay cambios sin guardar en la revisión abierta. ¿Abrir la otra igual?", "Abrir"))) return false;
  closeEditor(true); setMarking(false);
  const base = nuevaRevision();
  R = { ...base, ...o, vers: o.vers.map((v) => ({ ...v, D: null })), notas: o.notas.map((n) => ({ trazos: [], cambios: {}, ...n })) };
  delete R.guardada; delete R.versionActual;
  IMG.clear(); NS.showChecked = false;
  setOn(activas().slice(-1).map((v) => v.n));
  fillFields(); marcarGuardado(); renderVers(); resetView(); renderNotes();
  Object.assign(S, { A: null, B: null, vA: null, vB: null, M: null, Mi: null });
  const falta = activas();
  if (conPlanos) showHome("Abriendo la revisión con sus planos…");
  else showHome(falta.length ? "Revisión abierta. Carga los planos: " + falta.map((v) => `versión ${v.n} (${v.nombre})`).join(", ") + "." : "Revisión abierta.");
  return true;
}

// ---------- descargas ----------
let exporting = false, dlNs;
function setExporting(on) {
  exporting = on;
  for (const id of ["hatchBtn", "annotBtn", "addVer", "openRev", "addNote", "saveRev", "verInforme"]) $(id).disabled = on;
  document.querySelectorAll(".ver button, .ver select").forEach((b) => (b.disabled = on));
}
// fallback: () => [nombre, blob] en un formato que acepte la página de Claude cuando rechaza este
let dlErr = null; // código del último error de descarga ("too_large", "declined"…)
async function offerFile(filename, blob, fallback = null) {
  dlErr = null;
  if (dlNs === undefined) dlNs = window.claude && window.claude.use ? await window.claude.use("downloads").catch(() => null) : null;
  if (dlNs) {
    try { await dlNs.save({ filename, data: blob }); return true; }
    catch (e) {
      const c = e && e.code; dlErr = c || "error";
      if (fallback && (c === "rejected_extension" || c === "extension_not_enabled")) { const [f, b] = await fallback(); return offerFile(f, b); }
      setStatus(c === "declined" ? "" : c === "rate_limited" ? "Ya hay una descarga esperando tu confirmación." : c === "too_large" ? "El archivo es demasiado grande para descargarlo aquí." : "La descarga no está disponible en esta vista.");
      return false;
    }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return true;
}
const fmtPct = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v))).replace(".", ",") + " %";
const stamp = () => new Date().toLocaleString("es-CL").replace(/[  ]/g, " ");
const CREDIT = "Desarrollado por VialAG para la revisión de planos";
const SECRETO = "Si encontraste esto eres un genio y me debes un almuerzo. Atte. Felipe Borquez";
// pie de cada hoja: el crédito al centro y, en blanco y muy chico en la esquina derecha, el mensaje escondido
function pdfPie(doc, pw, ph) {
  doc.setFont("helvetica", "normal"); doc.setFontSize(4); doc.setTextColor(255, 255, 255); doc.text(pdfSafe(SECRETO), pw - 3, ph - 2.5, { align: "right" });
  doc.setFontSize(8); doc.setTextColor(150, 145, 136); doc.text(pdfSafe(CREDIT), pw / 2, ph - 6.5, { align: "center" });
}
const PRIVACY = "Los archivos se procesan en tu navegador y no se suben a ningún servidor.";
const targetDxf = () => { const D = S.B || S.A; return D && D.kind === "dxf"; };
function exportButtons() {
  const ready = !!S.frame && !S.running;
  $("dlPdf").disabled = $("verInforme").disabled = !ready || exporting;
  $("dlDxf").disabled = !(ready && targetDxf()) || exporting;
  $("saveRev").disabled = !(R.vers.length || R.notas.length) || exporting;
  $("dlHint").textContent = ready && !targetDxf() ? "El DXF se genera cuando la versión más nueva a la vista es DXF." : "";
  $("addNote").disabled = !S.M || S.running || exporting;
}
const versionTxt = () => !S.vA ? "" : S.vB ? `Versión ${S.vB.n} comparada con la ${S.vA.n}` : `Versión ${S.vA.n}`;

// título como el del panel: "RE-VISIÓN" en Arial Black, mayúsculas y subrayado (la misma fuente de la página)
const TITULO = "RE-VISIÓN";
const titleFont = (px) => `900 ${px}px "Arial Black", "Arial Bold", Gadget, Arial, sans-serif`;
// medidas en px de una letra de F px: ancho del título y alto de las mayúsculas; spacing = el .02em de la página
function tituloMedidas(F = 200, spacing = true) {
  const g = document.createElement("canvas").getContext("2d");
  g.font = titleFont(F); g.letterSpacing = spacing ? 0.02 * F + "px" : "0px";
  const cap = g.measureText("E").actualBoundingBoxAscent || 0.716 * F;
  return { g, F, w: g.measureText(TITULO).width, cap, ul: (4 / 15) * F, th: (2 / 15) * F }; // subrayado: 4 px bajo la línea base y 2 px de grueso a 15 px, como en la página
}
let tituloCache = null;
function tituloPng() {
  if (tituloCache) return tituloCache;
  const { F, w, cap, ul, th } = tituloMedidas(), top = Math.ceil(1.05 * F);
  const cv = document.createElement("canvas"); cv.width = Math.ceil(w + 2); cv.height = Math.ceil(top + ul + th + 2);
  const g = cv.getContext("2d"); g.font = titleFont(F); g.letterSpacing = 0.02 * F + "px";
  g.fillStyle = "#fff"; g.textBaseline = "alphabetic"; g.fillText(TITULO, 0, top);
  g.fillRect(0, top + ul, w, th);
  return (tituloCache = { url: cv.toDataURL("image/png"), F, w: cv.width, h: cv.height, top, cap, under: ul + th });
}
// header del PDF como el de la página
function pdfHeader(doc, pw) {
  const bh = 16, brown = [97, 89, 75], light = [239, 233, 223];
  doc.setFillColor(...brown); doc.rect(0, 0, pw, bh, "F");
  doc.setFillColor(199, 189, 168); doc.rect(0, bh, pw, 1.2, "F");
  const bb = LOGO.bb, lh = 7.6, k = lh / (bb[3] - bb[1]), lx = 12, ly = (bh - lh) / 2;
  const X = (u) => lx + (u - bb[0]) * k, Y = (v) => ly + (bb[3] - v) * k;
  for (const [part, col] of [[LOGO.box, [255, 255, 255]], [LOGO.vial, brown], [LOGO.ag, [255, 255, 255]]]) {
    doc.setFillColor(...col);
    for (const poly of part.r) {
      const ops = [];
      for (const r of poly) { for (let i = 0; i < r.length; i += 2) ops.push({ op: i ? "l" : "m", c: [X(r[i]), Y(r[i + 1])] }); ops.push({ op: "h" }); }
      doc.path(ops); doc.fillEvenOdd();
    }
  }
  let x = X(bb[2]) + 8;
  // título en imagen (jsPDF no trae Arial Black): mayúsculas y subrayado centrados en la barra
  const T = tituloPng(), tk = 5.8 / T.F, base = bh / 2 + (T.cap - T.under) * tk / 2;
  doc.addImage(T.url, "PNG", x, base - T.top * tk, T.w * tk, T.h * tk, "RE-VISION-titulo");
  x += T.w * tk;
  // leyenda: líneas gris y roja, rectángulo de nota y círculo de grave
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
  const items = [["l", COL_MATCH, "Coincide"], ["l", COL_DIFF, "Cambio"], ["r", [217, 138, 0], "Nota"], ["c", [237, 65, 51], "Grave"]];
  const sw = 6, gap = 2.2, tws = items.map(([, , t]) => doc.getTextWidth(t));
  const lw = 10 + tws.reduce((a, t) => a + sw + gap + t, 0) + 6 * (items.length - 1), lht = 7;
  const px = Math.max(pw / 2 - lw / 2, x + 8), py = bh / 2 - lht / 2;
  doc.setFillColor(255, 255, 255); doc.roundedRect(px, py, lw, lht, lht / 2, lht / 2, "F");
  let cx = px + 5; doc.setTextColor(61, 54, 44);
  items.forEach(([kind, c, t], i) => {
    if (kind === "l") { doc.setLineWidth(1.1); doc.setLineCap("round"); doc.setDrawColor(...c); doc.line(cx + 0.5, bh / 2, cx + sw - 0.5, bh / 2); doc.setLineCap("butt"); }
    else if (kind === "r") { doc.setLineWidth(0.5); doc.setDrawColor(...c); doc.setFillColor(251, 240, 220); doc.rect(cx + 0.6, bh / 2 - 1.6, sw - 1.2, 3.2, "FD"); }
    else { doc.setFillColor(...c); doc.circle(cx + sw / 2, bh / 2, 1.9, "F"); }
    cx += sw + gap; doc.text(t, cx, bh / 2, { baseline: "middle" }); cx += tws[i] + 6;
  });
  doc.setTextColor(...light);
  const room = pw - 10 - (px + lw + 8);
  if (room > 30) {
    let fs = 8.5, lines;
    for (fs of [8.5, 7.5, 7]) { doc.setFontSize(fs); lines = doc.getTextWidth(PRIVACY) <= room ? [PRIVACY] : doc.splitTextToSize(PRIVACY, room); if (lines.length <= 2) break; }
    const lh2 = fs * 0.42, y0 = bh / 2 - (lines.length - 1) * lh2 / 2;
    lines.forEach((t, i) => doc.text(pdfSafe(t), pw - 10, y0 + i * lh2, { baseline: "middle", align: "right" }));
  }
  return bh + 1.2;
}
// Nota en el PDF, en vector. X, Y: px del marco -> mm.
function pdfNote(doc, nt, X, Y, k = 1) {
  const c = corners(nt).map(([x, y]) => [X(x), Y(y)]), b = bbox(c), ck = nt.estado === "check";
  const col = ck ? [111, 124, 136] : [217, 138, 0];
  doc.setDrawColor(...col); doc.setLineWidth((nt.grave && !ck ? 0.55 : 0.4) * k);
  if (ck) doc.setLineDashPattern([1.5 * k, 1 * k], 0);
  for (let i = 0; i < 4; i++) doc.line(c[i][0], c[i][1], c[(i + 1) % 4][0], c[(i + 1) % 4][1]);
  doc.setLineDashPattern([], 0);
  doc.setLineCap("round"); doc.setLineJoin("round");
  for (const tr of nt.trazos || []) {
    const rgb = tr.c === "b" ? [37, 99, 201] : [237, 65, 51];
    doc.setDrawColor(...rgb); doc.setLineWidth(0.45 * k);
    let prev = null;
    for (let i = 0; i < tr.p.length; i += 2) { const f = apply(S.M, tr.p[i], tr.p[i + 1]), q = [X(f[0]), Y(f[1])]; if (prev) doc.line(prev[0], prev[1], q[0], q[1]); prev = q; }
  }
  doc.setLineCap("butt"); doc.setLineJoin("miter");
  const r = 2.6 * k;
  doc.setFillColor(...(ck ? [111, 124, 136] : nt.grave ? [237, 65, 51] : [217, 138, 0])); doc.setDrawColor(255, 255, 255); doc.setLineWidth(0.35 * k);
  doc.circle(b[0], b[1], r, "FD");
  doc.setFont("helvetica", "bold"); doc.setFontSize(8.5 * k); doc.setTextColor(255, 255, 255);
  doc.text(ck ? "v" : String(nt.n), b[0], b[1] + 0.1 * k, { align: "center", baseline: "middle" });
  if (nt.grave && !ck) {
    const tx = b[0] + r + 0.8 * k, ty = b[1], s = 2.1 * k;
    doc.setFillColor(237, 65, 51); doc.triangle(tx + s, ty - s, tx + 2 * s, ty + s * 0.75, tx, ty + s * 0.75, "F");
    doc.setFontSize(6.5 * k); doc.text("!", tx + s, ty + 0.35 * k, { align: "center", baseline: "middle" });
  }
}
// Recorte del plano alrededor de una nota, con la nota dibujada encima (para las fichas del informe)
async function recorteNota(nt, px = 1100) {
  const { W, H } = S.frame, b = bbox(corners(nt));
  let size = Math.max(b[2] - b[0], b[3] - b[1]) * 1.8 + 24;
  size = Math.min(size, Math.max(W, H));
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  let r = [cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2];
  const z = Math.min(64, px / size);
  const c = await renderRegion(r, z, S.B ? "diff" : "single", 1);
  const g = c.getContext("2d"), u = px / 520;
  const P = (x, y) => { const f = apply(S.M, x, y); return [(f[0] - r[0]) * z, (f[1] - r[1]) * z]; };
  paintNote(g, nt, P, u);
  return c;
}
// mode "ver": fuera de claude.ai el informe se abre en otra pestaña (abierta dentro del clic, para que el navegador
// no la bloquee); en claude.ai, o si no se pudo abrir, se ofrece la descarga.
// "Ver INFORME" y "Descargar PDF" bajan el mismo PDF directo, sin abrir otra pestaña (como el Comparador A·B)
async function exportPdf() {
  if (!S.frame || exporting || S.running) return;
  if (!window.jspdf) { setStatus("No se pudo cargar el generador de PDF. Revisa tu conexión y recarga la página."); return; }
  closeEditor(true); setMarking(false);
  setExporting(true); cancelRenders(); detailId++;
  setBusy("Preparando PDF…"); await new Promise((r) => setTimeout(r, 30));
  try {
    const { W, H } = S.frame;
    const doc = new window.jspdf.jsPDF({ orientation: W >= H ? "landscape" : "portrait", unit: "mm", format: "a3", compress: true });
    const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight(), mg = 12;
    const ink = [24, 33, 43], muted = [91, 102, 114];
    let y = pdfHeader(doc, pw) + 10;
    // datos de la revisión
    const titulo = pdfSafe([R.proyecto || "Proyecto sin nombre", R.detalle].filter(Boolean).join(" · "));
    let right = pw - mg;
    if (S.B && S.result) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(26); doc.setTextColor(...COL_DIFF);
      const pct = fmtPct(S.result.pct); doc.text(pct, right, y + 1, { align: "right" });
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...muted); doc.text("Cambios aproximados", right, y + 6, { align: "right" });
      right -= Math.max(doc.getTextWidth("Cambios aproximados"), 30) + 8;
    }
    doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(...ink);
    doc.text(fitWidth(doc, titulo, right - mg), mg, y);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(...muted);
    const quien = pdfSafe(`Creador: ${R.creador || "–"}     Revisor: ${R.revisor || "–"}     ${versionTxt()}     ${stamp()}`);
    y += 6; doc.text(fitWidth(doc, quien, right - mg), mg, y);
    const ab = R.notas.filter((n) => n.estado === "abierta"), gr = ab.filter((n) => n.grave), ck = R.notas.filter((n) => n.estado === "check");
    const files = pdfSafe(S.B ? `Versión ${S.vA.n}: ${S.vA.nombre}     Versión ${S.vB.n}: ${S.vB.nombre}` : `Archivo: ${S.vA.nombre}`);
    y += 4.8; doc.text(fitWidth(doc, files, right - mg), mg, y);
    y += 4.8; doc.setTextColor(...ink);
    doc.text(pdfSafe(`${ab.length} observacion${ab.length === 1 ? "" : "es"} abierta${ab.length === 1 ? "" : "s"}` + (gr.length ? ` (${gr.length} grave${gr.length > 1 ? "s" : ""})` : "") + (ck.length ? ` · ${ck.length} en check` : "") + (ab.length ? " · el detalle de cada una va en las páginas siguientes" : "")), mg, y);
    y += 4;
    // el plano completo, redibujado por cuadros, con las notas abiertas encima
    const aw = pw - 2 * mg, ah = ph - y - 12, s = Math.min(aw / W, ah / H), w = W * s, h = H * s, x0 = (pw - w) / 2;
    await pdfPlan(doc, x0, y, s, W, H);
    const X = (fx) => x0 + fx * s, Y = (fy) => y + fy * s, kn = Math.max(0.6, Math.min(1.2, s * 40));
    const zonas = [];
    for (const nt of ab) { pdfNote(doc, nt, X, Y, kn); zonas.push([nt, bbox(corners(nt).map(([fx, fy]) => [X(fx), Y(fy)]))]); }
    doc.setDrawColor(...COL_MATCH); doc.setLineWidth(0.2); doc.rect(x0, y, w, h);
    pdfPie(doc, pw, ph);
    if (ab.length) { doc.setFontSize(8.5); doc.setTextColor(97, 89, 75); doc.text(pdfSafe("Toca una nota del plano para ir a su detalle."), x0, y + h + 4.5); }
    const pos = await pdfFichas(doc, ab, ck);
    // cada nota del plano general lleva a su ficha
    doc.setPage(1);
    for (const [nt, b] of zonas) {
      const p = pos.get(nt.id); if (!p) continue;
      const m = 3.2 * kn;
      doc.link(b[0] - m, b[1] - m, b[2] - b[0] + 2 * m, b[3] - b[1] + 2 * m, { pageNumber: p.page, magFactor: "XYZ", top: Math.max(0, p.y - 4), left: 0, zoom: 0 });
    }
    await offerFile(nombreBase() + ".pdf", doc.output("blob"));
  } catch (e) { console.error(e); setStatus("No se pudo generar el PDF: " + (e.message || e)); }
  finally { setExporting(false); setBusy(null); renderVers(); exportButtons(); scheduleDetail(); }
}
async function pdfPlan(doc, x0, y0, s, W, H) {
  const z = Math.max(1, PDF_RES / Math.max(W, H)), step = PDF_TILE / z, pad = TOL + 4;
  const nx = Math.ceil(W / step), ny = Math.ceil(H / step), view = S.B ? "diff" : "single";
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    setBusy(`Preparando PDF… plano ${j * nx + i + 1} / ${nx * ny}`);
    await new Promise((res) => setTimeout(res, 20));
    const r = [i * step, j * step, Math.min(W, (i + 1) * step), Math.min(H, (j + 1) * step)];
    const rr = [Math.max(0, r[0] - pad), Math.max(0, r[1] - pad), Math.min(W, r[2] + pad), Math.min(H, r[3] + pad)];
    const big = await renderRegion(rr, z, view, 1);
    const tw = Math.round((r[2] - r[0]) * z), th = Math.round((r[3] - r[1]) * z);
    const t = document.createElement("canvas"); t.width = tw; t.height = th;
    t.getContext("2d").drawImage(big, Math.round((r[0] - rr[0]) * z), Math.round((r[1] - rr[1]) * z), tw, th, 0, 0, tw, th);
    doc.addImage(t, "PNG", x0 + r[0] * s, y0 + r[1] * s, (r[2] - r[0]) * s, (r[3] - r[1]) * s, undefined, "FAST");
    big.width = big.height = t.width = t.height = 0;
  }
}
// Fichas de observaciones: las graves en sus propias páginas y, aparte, el resto; al final la lista de las que están en check.
// Devuelve dónde quedó cada ficha (página y altura) para enlazarla desde el plano general.
async function pdfFichas(doc, ab, ck) {
  const ink = [24, 33, 43], muted = [91, 102, 114], pos = new Map();
  let pw = 0, ph = 0, mg = 12, top = 0;
  const pagina = (titulo, rojo = false) => {
    doc.addPage("a3", "landscape"); pw = doc.internal.pageSize.getWidth(); ph = doc.internal.pageSize.getHeight();
    top = pdfHeader(doc, pw) + 10;
    doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(...(rojo ? [237, 65, 51] : ink)); doc.text(pdfSafe(titulo), mg, top);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...muted);
    doc.text(fitWidth(doc, pdfSafe([R.proyecto, R.detalle].filter(Boolean).join(" · ") + (R.proyecto || R.detalle ? "     " : "") + versionTxt()), pw / 2), pw - mg, top, { align: "right" });
    pdfPie(doc, pw, ph);
    top += 5;
  };
  const graves = ab.filter((n) => n.grave).sort((a, b) => a.n - b.n), otras = ab.filter((n) => !n.grave).sort((a, b) => a.n - b.n);
  const secciones = [[`Observaciones graves (${graves.length})`, graves, true], [graves.length ? `Otras observaciones (${otras.length})` : `Observaciones (${otras.length})`, otras, false]];
  let hechas = 0;
  for (const [titulo, lista, rojo] of secciones) {
    for (let i = 0; i < lista.length; i++) {
      const nt = lista[i], slot = i % 4;
      if (slot === 0) pagina(i ? titulo + " · continuación" : titulo, rojo);
      setBusy(`Preparando PDF… nota ${++hechas} / ${ab.length}`); await new Promise((r) => setTimeout(r, 10));
      const gap = 8, cw = (pw - 2 * mg - gap) / 2, chh = (ph - top - 14 - gap) / 2;
      const cx = mg + (slot % 2) * (cw + gap), cy = top + Math.floor(slot / 2) * (chh + gap);
      pos.set(nt.id, { page: doc.internal.getNumberOfPages(), y: cy });
      await pdfFicha(doc, nt, cx, cy, cw, chh, ink, muted);
    }
  }
  if (ck.length) {
    pagina(`Notas en check (${ck.length})`);
    const cols = [["N°", 16], ["Observación", pw - 2 * mg - 16 - 46 - 46 - 30], ["Creada en", 46], ["Check en", 46], ["Fecha", 30]];
    let y = top + 3;
    const head = () => {
      doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...muted);
      let x = mg; for (const [t, w] of cols) { doc.text(t, x, y); x += w; }
      y += 2; doc.setDrawColor(217, 209, 194); doc.setLineWidth(0.3); doc.line(mg, y, pw - mg, y); y += 5;
    };
    head();
    for (const nt of ck) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
      const tl = doc.splitTextToSize(pdfSafe(nt.texto || SIN_COM), cols[1][1] - 4).slice(0, 3), rh = Math.max(6, tl.length * 4.3 + 2);
      if (y + rh > ph - 16) { pagina(`Notas en check (${ck.length}, continuación)`); y = top + 3; head(); doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); }
      let x = mg; doc.setTextColor(...ink);
      doc.text(String(nt.n) + (nt.grave ? " !" : ""), x, y); x += cols[0][1];
      doc.text(tl, x, y, { lineHeightFactor: 1.2 }); x += cols[1][1];
      doc.setTextColor(...muted);
      doc.text(`Versión ${nt.ver}`, x, y); x += cols[2][1];
      doc.text(nt.check ? `Versión ${nt.check.ver}` : "–", x, y); x += cols[3][1];
      doc.text(nt.check ? fecha(nt.check.fecha) : "", x, y);
      y += rh; doc.setDrawColor(234, 229, 220); doc.setLineWidth(0.2); doc.line(mg, y - 3.5, pw - mg, y - 3.5);
    }
  }
  return pos;
}
// Una ficha: recorte del plano con la nota y, si tiene, la imagen adjunta del mismo tamaño al lado.
async function pdfFicha(doc, nt, cx, cy, cw, chh, ink, muted) {
  doc.setDrawColor(...(nt.grave ? [237, 65, 51] : [217, 209, 194])); doc.setLineWidth(nt.grave ? 0.6 : 0.3); doc.roundedRect(cx, cy, cw, chh, 2, 2, "S");
  const cabecera = (tx, ty) => {
    doc.setFillColor(...(nt.grave ? [237, 65, 51] : [217, 138, 0])); doc.circle(tx + 3.2, ty - 1.4, 3.6, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(255, 255, 255); doc.text(String(nt.n), tx + 3.2, ty - 1.3, { align: "center", baseline: "middle" });
    doc.setTextColor(...ink); doc.setFontSize(12); doc.text(`Nota ${nt.n}`, tx + 9, ty);
    if (nt.grave) {
      const gx = tx + 9 + doc.getTextWidth(`Nota ${nt.n}`) + 4;
      doc.setFillColor(237, 65, 51); doc.roundedRect(gx, ty - 4.2, 19, 5.6, 1, 1, "F");
      doc.setFontSize(8.5); doc.setTextColor(255, 255, 255); doc.text("GRAVE", gx + 9.5, ty - 1.3, { align: "center", baseline: "middle" });
    }
  };
  const volver = () => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(97, 89, 75);
    const t = "Ver en el plano general", w = doc.getTextWidth(t);
    doc.textWithLink(t, cx + cw - 5 - w, cy + chh - 4.5, { pageNumber: 1 });
  };
  const textoNota = (tx, ty, tw, maxY) => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(10.5); doc.setTextColor(...ink);
    const lines = doc.splitTextToSize(pdfSafe(nt.texto || SIN_COM), tw);
    const maxL = Math.max(1, Math.floor((maxY - ty) / 4.6));
    const shown = lines.length > maxL ? [...lines.slice(0, maxL - 1), lines[maxL - 1].replace(/\s*\S*$/, "") + " …"] : lines;
    doc.text(shown, tx, ty, { lineHeightFactor: 1.25 });
    return ty + shown.length * 4.6;
  };
  const meta = () => [`Creada en la versión ${nt.ver} (${fecha(nt.creada)})`, (nt.trazos || []).length ? "con dibujo dentro de la región" : null].filter(Boolean).join(", ");
  const crop = await recorteNota(nt);
  const im = nt.img ? await cargarImg(nt.img.src).catch(() => null) : null;
  if (!im) {
    // recorte a la izquierda, texto a la derecha
    const iw = Math.min(chh - 8, cw * 0.56);
    doc.addImage(crop, "PNG", cx + 4, cy + 4, iw, iw, undefined, "FAST");
    doc.setDrawColor(217, 209, 194); doc.setLineWidth(0.2); doc.rect(cx + 4, cy + 4, iw, iw);
    const tx = cx + 4 + iw + 6, tw = cx + cw - 5 - tx; let ty = cy + 10;
    cabecera(tx, ty); ty += 7;
    ty = textoNota(tx, ty, tw, cy + chh - 24) + 3;
    doc.setFontSize(8.5); doc.setTextColor(...muted);
    for (const m of doc.splitTextToSize(pdfSafe(meta()), tw).slice(0, 2)) { doc.text(m, tx, ty); ty += 4; }
    const ch = cambioTxt(nt);
    if (ch) { doc.setTextColor(...(ch.chg ? [190, 45, 35] : muted)); doc.text(fitWidth(doc, pdfSafe(ch.t), tw), tx, cy + chh - 11); }
  } else {
    // cabecera arriba; recorte del plano e imagen adjunta lado a lado, del mismo tamaño; texto abajo
    cabecera(cx + 5, cy + 9);
    const sq = Math.min((cw - 14) / 2, chh - 13 - 26), iy = cy + 13;
    doc.addImage(crop, "PNG", cx + 5, iy, sq, sq, undefined, "FAST");
    doc.setDrawColor(217, 209, 194); doc.setLineWidth(0.2); doc.rect(cx + 5, iy, sq, sq);
    const bx = cx + 5 + sq + 4, k = Math.min(sq / im.naturalWidth, sq / im.naturalHeight), w = im.naturalWidth * k, h = im.naturalHeight * k;
    doc.setFillColor(250, 247, 240); doc.rect(bx, iy, sq, sq, "F");
    doc.addImage(im, "JPEG", bx + (sq - w) / 2, iy + (sq - h) / 2, w, h, undefined, "FAST");
    doc.setDrawColor(217, 209, 194); doc.rect(bx, iy, sq, sq);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...muted);
    doc.text("Plano", cx + 5, iy + sq + 3.4); doc.text(fitWidth(doc, pdfSafe("Imagen adjunta" + (nt.img.nombre ? ": " + nt.img.nombre : "")), sq), bx, iy + sq + 3.4);
    const tx = cx + 5, tw = cw - 10; let ty = iy + sq + 9;
    ty = textoNota(tx, ty, tw, cy + chh - 13) + 1;
    doc.setFontSize(8.5); doc.setTextColor(...muted);
    doc.text(fitWidth(doc, pdfSafe(meta()), tw - 40), tx, cy + chh - 9);
    const ch = cambioTxt(nt);
    if (ch) { doc.setTextColor(...(ch.chg ? [190, 45, 35] : muted)); doc.text(fitWidth(doc, pdfSafe(ch.t), tw - 40), tx, cy + chh - 4.5); }
  }
  crop.width = crop.height = 0;
  volver();
}
function cargarImg(src) { return new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; }); }

// DXF en coordenadas de la versión más nueva a la vista (la del dibujante), con las notas en sus capas.
async function exportDxf() {
  if (!S.frame || exporting || S.running || !targetDxf()) return;
  closeEditor(true); setMarking(false);
  setExporting(true); setBusy("Preparando DXF…"); await new Promise((r) => setTimeout(r, 30));
  try {
    const { W, H } = S.frame, Rr = S.result, A = S.A, B = S.B, hatch = S.hatch;
    const Dt = B || A, vt = B ? S.vB : S.vA, mt = B ? S.xf.m : I;
    const toWorld = (fx, fy) => apply(mul(inv(n2r(Dt)), inv(mt)), fx, fy);
    const frameOf = (D) => { const md = D === A ? I : S.xf.m; return (x, y) => apply(md, (x - D.bb[0]) * D.k + D.pad, (D.bb[3] - y) * D.k + D.pad); };
    const near = (mask, fx, fy) => { let n = 0; const x0 = Math.round(fx), y0 = Math.round(fy); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = x0 + dx, y = y0 + dy; if (x >= 0 && y >= 0 && x < W && y < H) n += mask[y * W + x]; } return n; };
    const ents = [], num = (v) => (Math.round(v * 1e4) / 1e4).toString();
    const enc = (t) => t.normalize("NFC").replace(/[^\x20-\x7e]/gu, (c) => { const v = c.codePointAt(0); return v > 0xffff ? "?" : "\\U+" + v.toString(16).toUpperCase().padStart(4, "0"); });
    const cut = (t, max = 250) => {
      if (enc(t).length <= max) return t;
      const c = [...t.normalize("NFC")]; let n = c.length, r = t;
      while (n > 0 && enc(r).length > max) { n--; const h = Math.ceil(n / 2); r = c.slice(0, h).join("") + "..." + c.slice(c.length - (n - h)).join(""); }
      return r;
    };
    const inFrame = (fx, fy) => fx >= 0 && fy >= 0 && fx <= W && fy <= H;
    const pline = (layer, pts, closed = false) => {
      if (pts.length < 2) return;
      if (pts.length === 2 && !closed) { ents.push(`0\nLINE\n8\n${layer}\n10\n${num(pts[0][0])}\n20\n${num(pts[0][1])}\n30\n0\n11\n${num(pts[1][0])}\n21\n${num(pts[1][1])}\n31\n0`); return; }
      let t = `0\nPOLYLINE\n8\n${layer}\n66\n1\n70\n${closed ? 1 : 0}\n10\n0\n20\n0\n30\n0`;
      for (const p of pts) t += `\n0\nVERTEX\n8\n${layer}\n10\n${num(p[0])}\n20\n${num(p[1])}\n30\n0`;
      ents.push(t + `\n0\nSEQEND\n8\n${layer}`);
    };
    const runs = (pts, toFrame, chg, keepSame, layerChg, layerSame) => {
      let cur = null, curCls = null; const flush = () => { if (cur && cur.length > 1) { if (curCls) pline(layerChg, cur); else if (keepSame) pline(layerSame, cur); } };
      for (let i = 0; i < pts.length - 1; i++) {
        const p = toFrame(pts[i][0], pts[i][1]), q = toFrame(pts[i + 1][0], pts[i + 1][1]);
        const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 1.5));
        for (let j = i === 0 ? 0 : 1; j <= n; j++) {
          const fx = p[0] + (q[0] - p[0]) * j / n, fy = p[1] + (q[1] - p[1]) * j / n;
          if (!inFrame(fx, fy)) { flush(); cur = null; curCls = null; continue; }
          const c = chg ? near(chg, fx, fy) : 0, s = chg ? near(Rr.com, fx, fy) : 1;
          const cls = c > s ? true : s > 0 ? false : curCls ?? false;
          if (!cur) { cur = [toWorld(fx, fy)]; curCls = cls; }
          else if (cls === curCls) { if (j === n) cur.push(toWorld(fx, fy)); }
          else { const w = toWorld(fx, fy); cur.push(w); flush(); cur = [w]; curCls = cls; }
        }
      }
      flush();
    };
    const rotT = Math.atan2(mt[1], mt[0]), sT = scaleOf(mt) * Dt.k * Dt.f;
    const textEnt = (layer, D, p, toFrame) => {
      const lines = p.s.split("\n"), md = D === A ? I : S.xf.m;
      const [fx, fy] = toFrame(p.p[0], p.p[1]); const [wx, wy] = toWorld(fx, fy);
      const hh = p.h * D.k * scaleOf(md) / sT;
      const rot = (p.rot - Math.atan2(md[1], md[0]) + rotT) * 180 / Math.PI;
      const lh = hh * 1.4, y0 = !p.multi ? 0 : p.va === 3 ? 0 : p.va === 2 ? -lh * lines.length / 2 : -lh * lines.length;
      lines.forEach((s, i) => {
        if (!s.trim()) return;
        const oy = -(y0 + i * lh), x = wx - oy * Math.sin(rot * Math.PI / 180), y = wy + oy * Math.cos(rot * Math.PI / 180);
        const ha = p.ha || 0, va = p.multi ? 3 : p.va || 0, al = ha || va;
        ents.push(`0\nTEXT\n8\n${layer}\n10\n${num(x)}\n20\n${num(y)}\n30\n0\n40\n${num(hh)}\n1\n${enc(cut(s))}\n50\n${num(rot)}` + (al ? `\n72\n${ha}\n73\n${va}\n11\n${num(x)}\n21\n${num(y)}\n31\n0` : ""));
      });
    };
    const textChanged = (D, p, toFrame, chg) => {
      if (!chg) return false;
      const [x, y] = toFrame(p.p[0], p.p[1]), r = Math.max(2, p.h * D.k * 0.6);
      let c = 0, s = 0;
      for (let yy = Math.max(0, Math.floor(y - r)); yy < Math.min(H, Math.ceil(y + r)); yy++) for (let xx = Math.max(0, Math.floor(x - r)); xx < Math.min(W, Math.ceil(x + r * 4)); xx++) { c += chg[yy * W + xx]; s += Rr.com[yy * W + xx]; }
      return c > s * 0.5 && c > 3;
    };
    // plano: con dos versiones, la anterior (solo lo que ya no está) y la nueva (coincide / cambio); con una, el plano solo
    const docs = B ? [[A, Rr.rem, "ANTERIOR", false, "ANTERIOR"], [B, Rr.add, "CAMBIO", true, "COINCIDE"]].filter(([D]) => D.kind === "dxf") : [[A, null, "PLANO", true, "PLANO"]];
    const total = docs.reduce((a, [D]) => a + D.prims.length, 0); let k = 0;
    for (const [D, chg, layer, keepSame, layerSame] of docs) {
      const toFrame = frameOf(D);
      for (const p of D.prims) {
        if (!shown(p) || (!hatch && p.hl)) { /* fuera por un interruptor (también el hatch dibujado como líneas) */ }
        else if (p.t === "h") { if (hatch || p.keep) for (const L of p.loops) runs([...L, L[0]], toFrame, chg, keepSame, layer, layerSame); }
        else if (p.t === "p") runs(p.pts, toFrame, chg, keepSame, layer, layerSame);
        else if (!inFrame(...toFrame(p.p[0], p.p[1]))) { /* fuera del área */ }
        else if (textChanged(D, p, toFrame, chg)) textEnt(layer, D, p, toFrame);
        else if (keepSame) textEnt(layerSame, D, p, toFrame);
        if (++k % 4000 === 0) { setBusy(`Preparando DXF… ${Math.round(k / total * 100)} %`); await new Promise((r) => setTimeout(r, 0)); }
      }
    }
    // notas: región, número, texto y dibujos, en coordenadas de esta versión
    const Mt = mul(mul(inv(n2r(Dt)), inv(mt)), S.M); // base -> versión destino
    const span = (() => { const a = toWorld(0, 0), b = toWorld(W, H); return Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); })();
    const th = span / 160;
    for (const nt of R.notas.filter((n) => n.estado === "abierta").sort((a, b) => b.grave - a.grave || a.n - b.n)) {
      const L = nt.grave ? "NOTAS_GRAVES" : "NOTAS";
      const c = [[nt.x0, nt.y0], [nt.x1, nt.y0], [nt.x1, nt.y1], [nt.x0, nt.y1]].map(([x, y]) => apply(Mt, x, y));
      pline(L, c, true);
      for (const tr of nt.trazos || []) { const q = []; for (let i = 0; i < tr.p.length; i += 2) q.push(apply(Mt, tr.p[i], tr.p[i + 1])); pline(tr.c === "b" ? "NOTAS_AZUL" : "NOTAS_ROJO", q); }
      const xs = c.map((p) => p[0]), x0 = Math.min(...xs), y1 = Math.max(...c.map((p) => p[1]));
      const words = `${nt.n}. ${nt.grave ? "[GRAVE] " : ""}${nt.texto || SIN_COM}${nt.img ? " (imagen adjunta en el PDF)" : ""}`.split(/\s+/), lines = []; let cur = "";
      for (const w of words) { if ((cur + " " + w).trim().length > 60 && cur) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim(); }
      if (cur) lines.push(cur);
      lines.forEach((s, i) => ents.push(`0\nTEXT\n8\n${L}\n10\n${num(x0)}\n20\n${num(y1 + th * 0.6 + (lines.length - 1 - i) * th * 1.5)}\n30\n0\n40\n${num(th)}\n1\n${enc(cut(s))}\n7\nVIALAG`));
    }
    const tl = toWorld(0, 0), br = toWorld(W, H);
    ents.push(...dxfHeader([Math.min(tl[0], br[0]), Math.min(tl[1], br[1]), Math.max(tl[0], br[0]), Math.max(tl[1], br[1])], { num, enc, cut }));
    const layers = [["PLANO", 8], ["COINCIDE", 8], ["ANTERIOR", 8], ["CAMBIO", 1], ["NOTAS", 30], ["NOTAS_GRAVES", 30], ["NOTAS_ROJO", 1], ["NOTAS_AZUL", 5], ["ENCABEZADO", 7]];
    const styles = [["STANDARD", "txt"], ["VIALAG", "arial.ttf"], ["VIALAG_NEGRITA", "arialbd.ttf"], ["VIALAG_TITULO", "ariblk.ttf"]];
    const uName = { 1: "pulgadas", 2: "pies", 4: "milimetros", 5: "centimetros", 6: "metros", 7: "kilometros", 9: "micropulgadas", 10: "yardas", 14: "decimetros" }[Dt.dxf.header && Dt.dxf.header["$INSUNITS"]] || "las mismas del plano (sin unidades declaradas)";
    const head = ["999", `RE-vision VialAG. Coordenadas de la version ${vt.n} (${enc(vt.nombre)}). Unidades: ${uName}`,
      "0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "0", "ENDSEC",
      "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LTYPE", "70", "1", "0", "LTYPE", "2", "CONTINUOUS", "70", "0", "3", "Solid line", "72", "65", "73", "0", "40", "0.0", "0", "ENDTAB",
      "0", "TABLE", "2", "LAYER", "70", String(layers.length),
      ...layers.flatMap(([n, c]) => ["0", "LAYER", "2", n, "70", "0", "62", String(c), "6", "CONTINUOUS"]),
      "0", "ENDTAB", "0", "TABLE", "2", "STYLE", "70", String(styles.length),
      ...styles.flatMap(([n, f]) => ["0", "STYLE", "2", n, "70", "0", "40", "0.0", "41", "1.0", "50", "0.0", "71", "0", "42", "2.5", "3", f, "4", ""]),
      "0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"].join("\n");
    const dxfText = head + "\n" + ents.join("\n") + "\n0\nENDSEC\n0\nEOF\n";
    const name = nombreBase();
    await offerFile(name + ".dxf", new Blob([dxfText], { type: "application/dxf" }), async () => {
      setBusy("Comprimiendo DXF…");
      const zip = new window.JSZip(); zip.file(name + ".dxf", dxfText);
      return [name + "_dxf.zip", await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } })];
    });
  } catch (e) { console.error(e); setStatus("No se pudo generar el DXF: " + (e.message || e)); }
  finally { setExporting(false); setBusy(null); renderVers(); exportButtons(); }
}
// header del DXF: barra con logo y título, leyenda, datos de la revisión y pie
function dxfHeader(ext, { num, enc, cut }) {
  const [ex0, ey0, ex1, ey1] = ext, s = (ex1 - ex0) / LOGO.bar[0], out = [], L = "ENCABEZADO";
  const yInfo2 = ey1 + 1.0 * s, yInfo1 = yInfo2 + 0.6 * s, yTit = yInfo1 + 0.85 * s, yb = yTit + 0.95 * s;
  const P = (u, v) => [num(ex0 + u * s), num(yb + v * s)];
  const xyz = (i, [x, y]) => `\n1${i}\n${x}\n2${i}\n${y}\n3${i}\n0`;
  const solid = (c, a, b, d, e = d) => out.push(`0\nSOLID\n8\n${L}\n62\n${c}` + xyz(0, a) + xyz(1, b) + xyz(2, d) + xyz(3, e));
  const rect = (c, [u0, v0, u1, v1]) => solid(c, P(u0, v0), P(u1, v0), P(u0, v1), P(u1, v1));
  const tris = (c, t) => { for (let i = 0; i < t.length; i += 6) solid(c, P(t[i], t[i + 1]), P(t[i + 2], t[i + 3]), P(t[i + 4], t[i + 5])); };
  const textW = (c, style, str, [x, y], h, ha = 0, va = 0) => out.push(`0\nTEXT\n8\n${L}\n62\n${c}\n10\n${x}\n20\n${y}\n30\n0\n40\n${num(h)}\n1\n${enc(cut(str))}\n7\n${style}` +
    (ha || va ? `\n72\n${ha}\n73\n${va}\n11\n${x}\n21\n${y}\n31\n0` : ""));
  const text = (c, style, str, u, v, h, ha, va) => textW(c, style, str, P(u, v), h * s, ha, va);
  rect(9, [0, 0, LOGO.bar[0], LOGO.band]);
  rect(251, [0, LOGO.band, LOGO.bar[0], LOGO.bar[1]]);
  tris(255, LOGO.box.t); tris(251, LOGO.vial.t); tris(255, LOGO.ag.t);
  const mid = (LOGO.band + LOGO.bar[1]) / 2;
  { // título "RE-VISIÓN" en Arial Black con subrayado (en AutoCAD la altura del texto es la de las mayúsculas)
    const m = tituloMedidas(200, false), h = 0.46, k = h / m.cap, ul = m.ul * k, th = m.th * k;
    const base = mid - (h - ul - th) / 2; // mayúsculas + subrayado centrados en la barra
    text(255, "VIALAG_TITULO", TITULO, 10.8, base, h);
    rect(255, [10.8, base - ul - th, 10.8 + m.w * k, base - ul]);
  }
  const pl = [21.551, 0.642, 30.6, 1.538], r = (pl[3] - pl[1]) / 2, ring = [];
  for (let i = 0; i <= 12; i++) { const a = -Math.PI / 2 + Math.PI * i / 12; ring.push([pl[2] - r + r * Math.cos(a), mid + r * Math.sin(a)]); }
  for (let i = 0; i <= 12; i++) { const a = Math.PI / 2 + Math.PI * i / 12; ring.push([pl[0] + r + r * Math.cos(a), mid + r * Math.sin(a)]); }
  const cx = (pl[0] + pl[2]) / 2;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; solid(255, P(cx, mid), P(a[0], a[1]), P(b[0], b[1])); }
  rect(8, [21.983, mid - 0.053, 22.554, mid + 0.053]); text(250, "VIALAG", "Coincide", 22.845, mid, 0.27, 0, 2);
  rect(1, [25.066, mid - 0.053, 25.637, mid + 0.053]); text(250, "VIALAG", "Cambio", 25.909, mid, 0.27, 0, 2);
  rect(30, [27.6, mid - 0.16, 28.17, mid + 0.16]); text(250, "VIALAG", "Nota", 28.44, mid, 0.27, 0, 2);
  text(9, "VIALAG", PRIVACY, 43.528, mid, 0.25, 2, 2);
  const ab = R.notas.filter((n) => n.estado === "abierta"), gr = ab.filter((n) => n.grave).length;
  textW(7, "VIALAG_NEGRITA", [R.proyecto || "Proyecto sin nombre", R.detalle].filter(Boolean).join(" · "), [num(ex0), num(yTit)], 0.5 * s);
  if (S.B && S.result) { textW(1, "VIALAG_NEGRITA", fmtPct(S.result.pct), [num(ex1), num(yTit)], 0.5 * s, 2, 0); }
  textW(8, "VIALAG", `Creador: ${R.creador || "-"}     Revisor: ${R.revisor || "-"}     ${versionTxt()}`, [num(ex0), num(yInfo1)], 0.28 * s);
  textW(8, "VIALAG", stamp() + (S.B && S.result ? "     cambios aproximados" : ""), [num(ex1), num(yInfo1)], 0.28 * s, 2, 0);
  textW(8, "VIALAG", `${ab.length} observaciones abiertas` + (gr ? ` (${gr} graves)` : "") + ". Capas NOTAS y NOTAS_GRAVES (region y texto), NOTAS_ROJO y NOTAS_AZUL (dibujos).", [num(ex0), num(yInfo2)], 0.28 * s);
  textW(8, "VIALAG", CREDIT, [num((ex0 + ex1) / 2), num(ey0 - 1.0 * s)], 0.28 * s, 1, 0);
  return out;
}
$("dlPdf").onclick = () => exportPdf();
$("verInforme").onclick = () => exportPdf();
$("dlDxf").onclick = exportDxf;

// ---------- pregunta (diálogo propio: la página de Claude no permite confirm()) ----------
function preguntar(msg, si = "Aceptar") {
  return new Promise((ok) => {
    const d = $("ask"); $("askMsg").textContent = msg; $("askYes").textContent = si;
    d.onclose = () => ok(d.returnValue === "si");
    d.returnValue = ""; d.showModal(); $("askYes").focus();
  });
}

// ---------- alineación manual con dos puntos ----------
const pick = { A: [], B: [] };
const vA = new Viewer($("vpA"), { onClick: (p) => addPick("A", snapCorner(S.rasterA, p, SNAP_PX / vA.s)) });
const vB = new Viewer($("vpB"), { onClick: (p) => addPick("B", snapCorner(S.rasterB, p, SNAP_PX / vB.s)) });
function addPick(k, p) { if (pick[k].length >= 2) return; pick[k].push(p); refreshPicks(); }
// A click snaps to the nearest corner or crossing of lines within SNAP_PX screen pixels (Harris corner
// response on the plan's raster), so both plans get the very same point even when picked zoomed out.
// With no corner in reach the click stays where it was.
const SNAP_PX = 14;
function snapCorner(c, p, r) {
  if (!c) return p;
  r = Math.max(2, Math.min(80, r));
  const x0 = Math.max(0, Math.floor(p[0] - r) - 3), y0 = Math.max(0, Math.floor(p[1] - r) - 3);
  const x1 = Math.min(c.width, Math.ceil(p[0] + r) + 4), y1 = Math.min(c.height, Math.ceil(p[1] + r) + 4), w = x1 - x0, h = y1 - y0;
  if (w < 9 || h < 9) return p;
  const d = c.getContext("2d", { willReadFrequently: true }).getImageData(x0, y0, w, h).data, g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 1 - (0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]) / 255;
  const xx = new Float32Array(w * h), yy = new Float32Array(w * h), xy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, gx = (g[i + 1] - g[i - 1]) / 2, gy = (g[i + w] - g[i - w]) / 2;
    xx[i] = gx * gx; yy[i] = gy * gy; xy[i] = gx * gy;
  }
  let best = null, bestV = 0;
  const s2 = 2 * (r / 1.5) ** 2;
  for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
    const dx = x0 + x + 0.5 - p[0], dy = y0 + y + 0.5 - p[1], dd = dx * dx + dy * dy;
    if (dd > r * r) continue;
    let a = 0, b = 0, cc = 0;
    for (let v = -2; v <= 2; v++) for (let u = -2; u <= 2; u++) { const j = (y + v) * w + x + u; a += xx[j]; b += yy[j]; cc += xy[j]; }
    const R = a * b - cc * cc - 0.04 * (a + b) ** 2;
    if (R < 0.02) continue; // an ideal crossing of two thin lines gives about 0.1
    const v = R * Math.exp(-dd / s2);
    if (v > bestV) { bestV = v; best = [x0 + x + 0.5, y0 + y + 0.5]; }
  }
  return best || p;
}
function refreshPicks() {
  vA.marks = pick.A.map((p, i) => ({ x: p[0], y: p[1], label: i + 1 })); vB.marks = pick.B.map((p, i) => ({ x: p[0], y: p[1], label: i + 1 }));
  vA.apply(); vB.apply();
  $("cntA").textContent = pick.A.length + " / 2"; $("cntB").textContent = pick.B.length + " / 2";
  const same = $("sameScale").checked;
  $("dlgApply").disabled = !(pick.A.length === pick.B.length && (pick.A.length === 2 || (same && pick.A.length === 1)));
}
function openManual() {
  if (!S.rasterA || !S.rasterB || !S.xf || S.running) return;
  closeEditor(true);
  $("dlgNameA").textContent = `Versión ${S.vA.n}`; $("dlgNameB").textContent = `Versión ${S.vB.n}`;
  // un PDF y un DXF se dibujan a tamaños sin relación: su escala sale siempre de los dos puntos
  pick.A = []; pick.B = []; $("sameScale").checked = !S.mixed && Math.abs(scaleOf(S.xf.m) - 1) < 0.005; $("dlg").showModal();
  vA.setCanvas(S.rasterA); vB.setCanvas(S.rasterB); vA.setLevels(pyramid(S.rasterA)); vB.setLevels(pyramid(S.rasterB)); vA.fit(); vB.fit(); refreshPicks();
}
$("sameScale").onchange = refreshPicks;
$("dlgReset").onclick = () => { pick.A = []; pick.B = []; refreshPicks(); };
$("dlgCancel").onclick = () => $("dlg").close();
$("dlgApply").onclick = () => {
  const [p1, p2] = pick.A, [q1, q2] = pick.B, same = $("sameScale").checked;
  let s = 1, th = 0;
  if (p2 && q2) {
    th = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) - Math.atan2(q2[1] - q1[1], q2[0] - q1[0]);
    // dos puntos siempre dan la escala; "misma escala" solo redondea a 1 una escala casi 1
    s = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / Math.hypot(q2[0] - q1[0], q2[1] - q1[1]);
    if (same && Math.abs(s - 1) < 0.02) s = 1;
    if (Math.abs(th) < 0.002) th = 0;
  }
  const a = s * Math.cos(th), b = s * Math.sin(th);
  const e = p1[0] - (a * q1[0] - b * q1[1]), f = p1[1] - (b * q1[0] + a * q1[1]);
  S.xf = { mode: "manual", m: [a, b, -b, a, e, f] };
  fijarT(true);
  $("dlg").close(); S.forceShow = false; run({ keepAlign: true });
};

// ---------- inicio ----------
renderVers(); renderNotes(); exportButtons(); fillFields();
showHome("");
loicaSync();
