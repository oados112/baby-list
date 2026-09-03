"use strict";

/* ===== הגדרות חיבור ל-GitHub (נשמר רק במכשיר הזה) ===== */
const CFG_KEY = "babylist_config";
const FILE_PATH = "data.json";

let cfg = loadConfig();
let state = null;       // הנתונים בזיכרון
let fileSha = null;     // ה-sha האחרון של data.json ב-GitHub
let saveTimer = null;
let saving = false;
let needsResave = false;
let pollTimer = null;
let openOptions = new Set();   // אילו פריטים מציגים את פאנל האפשרויות (פתוח/סגור)
let collapsedCats = new Set(); // אילו קטגוריות מכווצות (סגורות)
let searchQuery = "";          // טקסט חיפוש נוכחי ברשימת הקניות
let collapsedBagCats = new Set(); // אילו קטגוריות תיק מכווצות
let searchBagQuery = "";       // טקסט חיפוש בתיק הלידה
let collapsedApt = new Set();  // קטגוריות מעבר דירה מכווצות
let searchApt = "";            // חיפוש ברשימת מעבר דירה
let openAptOptions = new Set(); // אילו פריטי דירה מציגים פאנל אפשרויות

// קטגוריות תיק הלידה
const BAG_CATS = [
  { id: "mother", name: "תיק ליולדת", icon: "🤰" },
  { id: "baby", name: "תיק לתינוקת", icon: "👶" },
  { id: "delivery", name: "תיק לחדר לידה", icon: "🏥" }
];

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)) || null; }
  catch { return null; }
}
function saveConfig(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); cfg = c; }

/* ===== עזרי Base64 התומכים בעברית (UTF-8) ===== */
function utf8ToBase64(str) { return btoa(unescape(encodeURIComponent(str))); }
function base64ToUtf8(b64) { return decodeURIComponent(escape(atob((b64 || "").replace(/\s/g, "")))); }

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function nowISO() { return new Date().toISOString(); }

/* ===== קריאה/כתיבה מול GitHub Contents API ===== */
function apiUrl() {
  return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${FILE_PATH}`;
}
function apiHeaders() {
  return {
    "Authorization": `Bearer ${cfg.token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

async function fetchRemote() {
  const res = await fetch(`${apiUrl()}?ref=${encodeURIComponent(cfg.branch)}&t=${Date.now()}`, {
    headers: apiHeaders(), cache: "no-store"
  });
  if (!res.ok) throw new Error(`קריאה נכשלה (${res.status})`);
  const json = await res.json();
  const data = JSON.parse(base64ToUtf8(json.content));
  return { data: normalize(data), sha: json.sha };
}

async function putRemote(data, sha) {
  const body = {
    message: "עדכון רשימה",
    content: utf8ToBase64(JSON.stringify(data, null, 2)),
    branch: cfg.branch
  };
  if (sha) body.sha = sha;
  const res = await fetch(apiUrl(), { method: "PUT", headers: apiHeaders(), body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) { const e = new Error("conflict"); e.conflict = true; throw e; }
  if (!res.ok) throw new Error(`שמירה נכשלה (${res.status})`);
  const json = await res.json();
  return json.content.sha;
}

/* ===== מבנה נתונים תקין כברירת מחדל ===== */
function normalize(d) {
  d = d || {};
  d.categories = d.categories || [];
  d.items = d.items || [];
  d.hospitalBag = d.hospitalBag || [];
  d.recycleBin = d.recycleBin || [];
  d.budget = d.budget || { target: 0 };
  d._deleted = d._deleted || {};
  d.apartment = d.apartment || {};
  d.apartment.categories = d.apartment.categories || [];
  d.apartment.items = d.apartment.items || [];
  d.apartment.deleted = d.apartment.deleted || {};
  return d;
}

/* ===== מיזוג בעת קונפליקט (שני אנשים בו-זמנית) ===== */
// מיזוג לפי id מעל כל הרשימות (פעיל / סל מחזור): מנצחת הרשומה עם updatedAt העדכני
// ביותר, וגם המיקום שלה (האם הועברה לסל). מחיקה לצמיתות נשמרת ב-_deleted.
function mergeData(remote, local) {
  const out = normalize(JSON.parse(JSON.stringify(remote)));
  out._deleted = Object.assign({}, remote._deleted, local._deleted);

  // קטגוריות: האפליקציה לא עורכת אותן, לכן השרת הוא מקור האמת (קולט הוספות חדשות)
  out.categories = remote.categories.length ? remote.categories : local.categories;
  const lt = local.budget && local.budget.target;
  out.budget = { target: (lt || lt === 0) ? lt : remote.budget.target };

  // לכל id נשמרת הרשומה העדכנית ביותר + באיזו רשימה היא נמצאת (כך גם מעבר לסל מתמזג נכון)
  const all = new Map(); // id -> { rec, list }
  const consider = (list, arr) => {
    for (const it of arr || []) {
      const ex = all.get(it.id);
      if (!ex || (it.updatedAt || "") >= (ex.rec.updatedAt || "")) all.set(it.id, { rec: it, list });
    }
  };
  consider("items", remote.items); consider("items", local.items);
  consider("hospitalBag", remote.hospitalBag); consider("hospitalBag", local.hospitalBag);
  consider("recycleBin", remote.recycleBin); consider("recycleBin", local.recycleBin);

  out.items = []; out.hospitalBag = []; out.recycleBin = [];
  for (const { rec, list } of all.values()) {
    const del = out._deleted[rec.id];
    if (del && del >= (rec.updatedAt || "")) continue; // נמחק לצמיתות
    if (list === "items") out.items.push(rec);
    else if (list === "hospitalBag") out.hospitalBag.push(rec);
    else out.recycleBin.push(rec);
  }

  // מיזוג גיליון מעבר דירה (עצמאי משאר הרשימות)
  const ra = remote.apartment || {}, la = local.apartment || {};
  out.apartment = out.apartment || {};
  out.apartment.deleted = Object.assign({}, ra.deleted || {}, la.deleted || {});
  out.apartment.categories = (ra.categories && ra.categories.length) ? ra.categories : (la.categories || []);
  const aptMap = new Map();
  (ra.items || []).forEach(it => aptMap.set(it.id, it));
  (la.items || []).forEach(it => { const ex = aptMap.get(it.id); if (!ex || (it.updatedAt || "") >= (ex.updatedAt || "")) aptMap.set(it.id, it); });
  out.apartment.items = [...aptMap.values()].filter(it => {
    const del = out.apartment.deleted[it.id];
    return !(del && del >= (it.updatedAt || ""));
  });

  return out;
}

/* ===== זרימת שמירה (debounce + טיפול בקונפליקט) ===== */
function scheduleSave() {
  setSaveStatus("dirty");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 1500);
}

async function doSave() {
  if (!cfg) { openSettings(); return; }
  if (saving) { needsResave = true; return; }
  saving = true; needsResave = false;
  setSaveStatus("saving");
  let attempts = 0;
  while (attempts < 4) {
    attempts++;
    try {
      fileSha = await putRemote(state, fileSha);
      saving = false;
      setSaveStatus("saved");
      if (needsResave) doSave();
      return;
    } catch (err) {
      if (err.conflict) {
        try {
          const remote = await fetchRemote();
          state = mergeData(remote.data, state);
          fileSha = remote.sha;
          render();
          continue; // ננסה לשמור שוב עם ה-sha החדש
        } catch { /* ניפול להמשך */ }
      }
      saving = false;
      setSaveStatus("error");
      setTimeout(() => { if (!saving) doSave(); }, 4000); // ניסיון חוזר אוטומטי
      return;
    }
  }
  saving = false;
  setSaveStatus("error");
}

function setSaveStatus(s) {
  const el = document.getElementById("saveStatus");
  el.className = "save-status " + s;
}

/* ===== טעינה ראשונית + polling לרענון ===== */
async function load() {
  if (!cfg) { openSettings(); return; }
  setSaveStatus("saving");
  try {
    const remote = await fetchRemote();
    state = remote.data;
    fileSha = remote.sha;
    setSaveStatus("saved");
    render();
    startPolling();
  } catch (err) {
    setSaveStatus("error");
    showCfgMsg("err", "החיבור נכשל: " + err.message + " — בדקו את ההגדרות.");
    openSettings();
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(pollIfIdle, 30000);
}
async function pollIfIdle() {
  if (!cfg || saving || document.hidden) return;
  try {
    const remote = await fetchRemote();
    if (remote.sha !== fileSha) { // מישהו אחר עדכן
      state = mergeData(remote.data, state);
      fileSha = remote.sha;
      render();
      setSaveStatus("saved");
    }
  } catch { /* שקט — ננסה שוב בפעם הבאה */ }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) pollIfIdle(); });

/* ===== רינדור ===== */
function catById(id) { return state.categories.find(c => c.id === id); }

function render() {
  if (!state) return;
  renderCategoryOptions();
  renderShopping();
  renderBag();
  renderBudget();
  renderBin();
  renderApartment();
}

function renderCategoryOptions() {
  const addSel = document.getElementById("addCategory");
  const filterSel = document.getElementById("filterCategory");
  const curAdd = addSel.value;
  const curFilter = filterSel.value;
  addSel.innerHTML = "";
  state.categories.forEach(c => {
    const o = document.createElement("option");
    o.value = c.id; o.textContent = `${c.icon || ""} ${c.name}`.trim();
    addSel.appendChild(o);
  });
  filterSel.innerHTML = '<option value="all">כל הקטגוריות</option>';
  state.categories.forEach(c => {
    const o = document.createElement("option");
    o.value = c.id; o.textContent = `${c.icon || ""} ${c.name}`.trim();
    filterSel.appendChild(o);
  });
  if (curAdd) addSel.value = curAdd;
  if (curFilter) filterSel.value = curFilter;
}

function renderShopping() {
  const wrap = document.getElementById("shoppingList");
  wrap.innerHTML = "";
  const fCat = document.getElementById("filterCategory").value;
  const fUnbought = document.getElementById("filterUnbought").checked;
  const fShani = document.getElementById("filterShani").checked;
  const fUrgent = document.getElementById("filterUrgent").checked;
  const q = (searchQuery || "").trim().toLowerCase();

  let items = state.items.filter(it => {
    if (fCat !== "all" && it.category !== fCat) return false;
    if (fUnbought && it.bought) return false;
    if (fShani && it.source !== "shani") return false;
    if (fUrgent && (!it.urgent || it.bought)) return false;
    if (q) {
      const hay = ((it.name || "") + " " + (it.notes || "") + " " +
        (it.options || []).map(o => (o.name || "") + " " + (o.where || "")).join(" ")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // קיבוץ לפי קטגוריה לפי סדר הקטגוריות
  state.categories.forEach(cat => {
    const catItems = items.filter(it => it.category === cat.id);
    if (!catItems.length) return;
    // בזמן חיפוש פותחים את כל הקטגוריות התואמות כדי לראות את התוצאות
    const collapsed = q ? false : collapsedCats.has(cat.id);
    const group = document.createElement("div");
    group.className = "cat-group";
    const bought = catItems.filter(i => i.bought).length;
    const header = document.createElement("button");
    header.type = "button";
    header.className = "cat-title" + (collapsed ? " collapsed" : "");
    header.innerHTML = `<span class="cat-chev">${collapsed ? "▸" : "▾"}</span>
      <span class="cat-name">${cat.icon || ""} ${cat.name}</span>
      <span class="cat-count">${bought}/${catItems.length}</span>`;
    header.onclick = () => {
      if (collapsedCats.has(cat.id)) collapsedCats.delete(cat.id); else collapsedCats.add(cat.id);
      renderShopping();
    };
    group.appendChild(header);
    if (!collapsed) catItems.forEach(it => group.appendChild(itemCard(it)));
    wrap.appendChild(group);
  });

  // פריטים בקטגוריה שנמחקה / לא מוכרת
  const orphans = items.filter(it => !catById(it.category));
  if (orphans.length) {
    const group = document.createElement("div");
    group.className = "cat-group";
    group.innerHTML = `<h3 class="cat-title">📦 שונות</h3>`;
    orphans.forEach(it => group.appendChild(itemCard(it)));
    wrap.appendChild(group);
  }

  // הודעת מצב ריק / אין תוצאות חיפוש
  const emptyEl = document.getElementById("shoppingEmpty");
  if (q && !wrap.children.length) {
    emptyEl.textContent = `לא נמצאו פריטים לחיפוש "${searchQuery.trim()}" 🔍`;
    emptyEl.classList.remove("hidden");
  } else if (!state.items.length) {
    emptyEl.textContent = "אין עדיין פריטים — הוסיפו את הראשון למעלה 👆";
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
  }
}

function itemCard(it) {
  const card = document.createElement("div");
  card.className = "item src-" + (it.source || "us") + (it.bought ? " bought" : "") + (it.urgent ? " urgent" : "");

  const top = document.createElement("div");
  top.className = "item-top";

  const chk = document.createElement("input");
  chk.type = "checkbox"; chk.className = "item-check"; chk.checked = !!it.bought;
  chk.title = "סמן כנקנה";
  chk.onchange = () => { it.bought = chk.checked; touch(it); render(); scheduleSave(); };

  const name = document.createElement("input");
  name.className = "item-name"; name.value = it.name;
  name.onchange = () => { it.name = name.value.trim() || it.name; touch(it); scheduleSave(); };

  const del = document.createElement("button");
  del.className = "del-btn"; del.textContent = "🗑"; del.title = "מחיקה";
  del.onclick = () => { deleteItem(it.id); };

  top.append(chk, name, del);

  const ctrl = document.createElement("div");
  ctrl.className = "item-controls";

  // כמות
  const qty = document.createElement("div");
  qty.className = "qty-box";
  const minus = document.createElement("button"); minus.textContent = "−";
  const num = document.createElement("span"); num.textContent = it.qty || 1;
  const plus = document.createElement("button"); plus.textContent = "+";
  minus.onclick = () => { it.qty = Math.max(1, (it.qty || 1) - 1); num.textContent = it.qty; touch(it); renderBudget(); scheduleSave(); };
  plus.onclick = () => { it.qty = (it.qty || 1) + 1; num.textContent = it.qty; touch(it); renderBudget(); scheduleSave(); };
  qty.append(minus, num, plus);

  // מקור (אנחנו / שני)
  const src = document.createElement("button");
  src.className = "src-badge " + (it.source || "us");
  src.textContent = it.source === "shani" ? "שני" : "אנחנו";
  src.title = "החלפת מקור";
  src.onclick = () => {
    it.source = it.source === "shani" ? "us" : "shani";
    // פריט משני (אחותי) — מאפסים מחיר אוטומטית. אפשר לשנות ידנית אחר כך.
    if (it.source === "shani") it.price = 0;
    touch(it); render(); scheduleSave();
  };

  // מחיר
  const price = document.createElement("label");
  price.className = "price-field";
  price.innerHTML = "₪";
  const pin = document.createElement("input");
  pin.type = "number"; pin.min = "0"; pin.step = "0.5"; pin.placeholder = "0";
  pin.value = it.price || "";
  pin.oninput = () => { it.price = parseFloat(pin.value) || 0; renderBudget(); };
  pin.onchange = () => { touch(it); scheduleSave(); };
  price.appendChild(pin);

  // דחוף
  const urg = document.createElement("button");
  urg.type = "button";
  urg.className = "urgent-badge" + (it.urgent ? " on" : "");
  urg.textContent = "🔥 דחוף";
  urg.title = "סמן כדחוף";
  urg.onclick = () => { it.urgent = !it.urgent; touch(it); renderShopping(); scheduleSave(); };

  ctrl.append(qty, src, urg, price);

  // הערות
  const notes = document.createElement("input");
  notes.className = "notes-field"; notes.placeholder = "הערות (מידה, צבע, מותג...)";
  notes.value = it.notes || "";
  notes.onchange = () => { it.notes = notes.value; touch(it); scheduleSave(); };

  card.append(top, ctrl, notes);

  // כפתור אפשרויות / השוואה (3 דגמים וכו')
  it.options = it.options || [];
  const optBtn = document.createElement("button");
  optBtn.className = "opt-toggle" + (openOptions.has(it.id) ? " open" : "");
  const chosen = it.options.find(o => o.chosen);
  optBtn.textContent = "🔎 אפשרויות" + (it.options.length ? ` (${it.options.length})` : "") + (chosen && chosen.name ? ` · נבחר: ${chosen.name}` : "");
  optBtn.onclick = () => {
    if (openOptions.has(it.id)) openOptions.delete(it.id); else openOptions.add(it.id);
    renderShopping();
  };
  card.append(optBtn);
  if (openOptions.has(it.id)) card.append(buildOptionsPanel(it, () => { renderShopping(); renderBudget(); }));

  return card;
}

// פאנל השוואת אפשרויות לפריט. rerender = הפונקציה שמרעננת את הרשימה הרלוונטית.
function buildOptionsPanel(it, rerender) {
  rerender = rerender || (() => { renderShopping(); renderBudget(); });
  const panel = document.createElement("div");
  panel.className = "options-panel";
  it.options.forEach(opt => panel.appendChild(optionCard(it, opt, rerender)));
  const addBtn = document.createElement("button");
  addBtn.className = "opt-add-btn";
  addBtn.textContent = "➕ הוסף אפשרות";
  addBtn.onclick = () => {
    it.options.push({ id: uid(), name: "", price: 0, where: "", pros: "", cons: "", chosen: false });
    touch(it); rerender(); scheduleSave();
  };
  panel.appendChild(addBtn);
  return panel;
}

function optionCard(it, opt, rerender) {
  rerender = rerender || (() => { renderShopping(); renderBudget(); });
  const c = document.createElement("div");
  c.className = "option-card" + (opt.chosen ? " chosen" : "");

  const head = document.createElement("div");
  head.className = "opt-head";
  const choose = document.createElement("button");
  choose.className = "opt-choose" + (opt.chosen ? " on" : "");
  choose.textContent = opt.chosen ? "⭐ נבחר" : "☆ בחר";
  choose.onclick = () => {
    const newVal = !opt.chosen;
    it.options.forEach(o => o.chosen = false);
    opt.chosen = newVal;
    if (newVal && (parseFloat(opt.price) || 0) > 0) it.price = parseFloat(opt.price);
    touch(it); rerender(); scheduleSave();
  };
  const name = document.createElement("input");
  name.className = "opt-name"; name.placeholder = "שם / דגם"; name.value = opt.name || "";
  name.onchange = () => { opt.name = name.value; touch(it); scheduleSave(); };
  const del = document.createElement("button");
  del.className = "del-btn"; del.textContent = "🗑";
  del.onclick = () => {
    if (!confirm("למחוק את האפשרות הזו?")) return;
    it.options = it.options.filter(o => o.id !== opt.id);
    touch(it); rerender(); scheduleSave();
  };
  head.append(choose, name, del);

  const row = document.createElement("div");
  row.className = "opt-row";
  const price = document.createElement("label");
  price.className = "price-field"; price.append(document.createTextNode("₪"));
  const pin = document.createElement("input");
  pin.type = "number"; pin.min = "0"; pin.step = "0.5"; pin.placeholder = "מחיר"; pin.value = opt.price || "";
  pin.onchange = () => { opt.price = parseFloat(pin.value) || 0; if (opt.chosen) it.price = opt.price; touch(it); rerender(); scheduleSave(); };
  price.appendChild(pin);
  const where = document.createElement("input");
  where.className = "opt-where"; where.placeholder = "מאיפה לקנות / מתנה"; where.value = opt.where || "";
  where.onchange = () => { opt.where = where.value; touch(it); scheduleSave(); };
  row.append(price, where);

  const pros = document.createElement("textarea");
  pros.className = "opt-pros"; pros.rows = 2; pros.placeholder = "✔️ יתרונות"; pros.value = opt.pros || "";
  pros.onchange = () => { opt.pros = pros.value; touch(it); scheduleSave(); };
  const cons = document.createElement("textarea");
  cons.className = "opt-cons"; cons.rows = 2; cons.placeholder = "✖️ חסרונות"; cons.value = opt.cons || "";
  cons.onchange = () => { opt.cons = cons.value; touch(it); scheduleSave(); };

  c.append(head, row, pros, cons);
  return c;
}

function bagCard(it) {
  const card = document.createElement("div");
  card.className = "item" + (it.packed ? " bought" : "") + (it.toBuy ? " to-buy" : "");
  const chk = document.createElement("input");
  chk.type = "checkbox"; chk.className = "item-check"; chk.checked = !!it.packed;
  chk.title = "כבר בתיק";
  chk.onchange = () => { it.packed = chk.checked; touch(it); renderBag(); scheduleSave(); };
  const name = document.createElement("input");
  name.className = "item-name"; name.value = it.name;
  name.onchange = () => { it.name = name.value.trim() || it.name; touch(it); scheduleSave(); };
  const buy = document.createElement("button");
  buy.type = "button";
  buy.className = "buy-badge" + (it.toBuy ? " on" : "");
  buy.textContent = "🛒 לקנות";
  buy.title = "לסמן שצריך לקנות";
  buy.onclick = () => { it.toBuy = !it.toBuy; touch(it); renderBag(); scheduleSave(); };
  const del = document.createElement("button");
  del.className = "del-btn"; del.textContent = "🗑";
  del.onclick = () => { deleteBag(it.id); };
  card.append(chk, name, buy, del);
  return card;
}

function renderBag() {
  const wrap = document.getElementById("bagList");
  wrap.innerHTML = "";
  const q = (searchBagQuery || "").trim().toLowerCase();
  const fUnpacked = document.getElementById("filterBagUnpacked").checked;
  const fToBuy = document.getElementById("filterBagToBuy").checked;

  const groups = BAG_CATS.map(bc => ({ bc, items: state.hospitalBag.filter(it => it.cat === bc.id) }));
  const others = state.hospitalBag.filter(it => !BAG_CATS.some(bc => bc.id === it.cat));
  if (others.length) groups.push({ bc: { id: "__other", name: "כללי", icon: "🧳" }, items: others });

  groups.forEach(({ bc, items }) => {
    let list = items.filter(it => {
      if (q && !(it.name || "").toLowerCase().includes(q)) return false;
      if (fUnpacked && it.packed) return false;
      if (fToBuy && !it.toBuy) return false;
      return true;
    });
    if (!list.length) return;
    const collapsed = q ? false : collapsedBagCats.has(bc.id);
    const group = document.createElement("div");
    group.className = "cat-group";
    const packed = list.filter(i => i.packed).length;
    const header = document.createElement("button");
    header.type = "button";
    header.className = "cat-title" + (collapsed ? " collapsed" : "");
    header.innerHTML = `<span class="cat-chev">${collapsed ? "▸" : "▾"}</span>
      <span class="cat-name">${bc.icon || ""} ${bc.name}</span>
      <span class="cat-count">${packed}/${list.length}</span>`;
    header.onclick = () => {
      if (collapsedBagCats.has(bc.id)) collapsedBagCats.delete(bc.id); else collapsedBagCats.add(bc.id);
      renderBag();
    };
    group.appendChild(header);
    if (!collapsed) list.forEach(it => group.appendChild(bagCard(it)));
    wrap.appendChild(group);
  });

  const emptyEl = document.getElementById("bagEmpty");
  if (emptyEl) {
    if (!state.hospitalBag.length) {
      emptyEl.textContent = "אין עדיין פריטים בתיק — הוסיפו למעלה 👆";
      emptyEl.classList.remove("hidden");
    } else if (!wrap.children.length) {
      emptyEl.textContent = q ? `לא נמצאו פריטים לחיפוש "${searchBagQuery.trim()}" 🔍` : "אין פריטים שמתאימים לסינון";
      emptyEl.classList.remove("hidden");
    } else {
      emptyEl.classList.add("hidden");
    }
  }
}

function renderBin() {
  const wrap = document.getElementById("binList");
  wrap.innerHTML = "";
  const bin = state.recycleBin || [];
  document.getElementById("binEmpty").classList.toggle("hidden", bin.length > 0);
  document.getElementById("emptyBinBtn").classList.toggle("hidden", bin.length === 0);

  // עדכון מונה על לשונית הסל
  const tabBtn = document.querySelector('.tab[data-tab="bin"]');
  if (tabBtn) tabBtn.textContent = "🗑️ סל מחזור" + (bin.length ? ` (${bin.length})` : "");

  [...bin].sort((a, b) => (b.deletedAt || "").localeCompare(a.deletedAt || "")).forEach(it => {
    const card = document.createElement("div");
    card.className = "item bin-item";
    const name = document.createElement("span");
    name.className = "item-name bin-name";
    const cat = catById(it.category);
    const where = it.origin === "hospitalBag" ? "תיק לידה" : (cat ? cat.name : "קניות");
    name.textContent = it.name;
    const tag = document.createElement("span");
    tag.className = "bin-from"; tag.textContent = where;
    const actions = document.createElement("div");
    actions.className = "bin-actions";
    const restore = document.createElement("button");
    restore.className = "restore-btn"; restore.textContent = "↩ שחזר";
    restore.onclick = () => restoreFromBin(it.id);
    const del = document.createElement("button");
    del.className = "perm-del-btn"; del.textContent = "מחק לצמיתות";
    del.onclick = () => permanentDelete(it.id);
    actions.append(restore, del);
    const topRow = document.createElement("div");
    topRow.className = "bin-top";
    topRow.append(name, tag);
    card.append(topRow, actions);
    wrap.appendChild(card);
  });
}

function renderBudget() {
  if (!state) return;
  const fmt = n => "₪" + Math.round(n || 0).toLocaleString("he-IL");
  const sum = (arr, pred) => arr.reduce((a, it) => a + ((pred ? pred(it) : true) ? (parseFloat(it.price) || 0) * (it.qty || 1) : 0), 0);

  // תינוק (רשימת הקניות)
  const babyTotal = sum(state.items);
  const babyShani = sum(state.items, it => it.source === "shani");
  const babyUs = babyTotal - babyShani;

  // מעבר דירה
  const aptItems = state.apartment.items;
  const aptTotal = sum(aptItems);
  const aptParents = sum(aptItems, it => it.source === "parents");
  const aptUs = aptTotal - aptParents;

  const grand = babyTotal + aptTotal;
  const wePay = babyUs + aptUs;
  const target = state.budget.target || 0;

  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = fmt(v); };
  set("budgetGrand", grand);
  set("budgetWePay", wePay);
  set("budgetRemaining", Math.max(0, target - wePay));
  const rw = document.getElementById("budgetRemainWrap"); if (rw) rw.hidden = !target;
  set("babyTotal", babyTotal); set("babyUs", babyUs); set("babyShani", babyShani);
  set("aptTotal", aptTotal); set("aptUs", aptUs); set("aptParents", aptParents);

  // פירוט לפי קטגוריות
  const breakdown = (containerId, cats, items) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = "";
    let any = false;
    cats.forEach(cat => {
      const s = sum(items.filter(it => it.category === cat.id));
      if (s <= 0) return;
      any = true;
      const row = document.createElement("div");
      row.className = "bd-row";
      row.innerHTML = `<span>${cat.icon ? cat.icon + " " : ""}${cat.name}</span><span class="bd-val">${fmt(s)}</span>`;
      el.appendChild(row);
    });
    if (!any) el.innerHTML = `<div class="bd-empty">עדיין לא הוזנו מחירים</div>`;
  };
  breakdown("babyBreakdown", state.categories, state.items);
  breakdown("aptBreakdown", state.apartment.categories, aptItems);

  const t = document.getElementById("budgetTarget");
  if (t && document.activeElement !== t) t.value = target || "";
}

/* ===== מוטציות ===== */
function touch(obj) { obj.updatedAt = nowISO(); }

function addItem(name, category, source, qty) {
  state.items.push({ id: uid(), name, category, source, qty: qty || 1, notes: "", price: 0, bought: false, updatedAt: nowISO() });
  render(); scheduleSave();
}
function deleteItem(id) {
  const it = state.items.find(i => i.id === id);
  if (!it) return;
  if (!confirm(`להעביר את "${it.name}" לסל המחזור?`)) return;
  state.items = state.items.filter(i => i.id !== id);
  it.origin = "items"; it.deletedAt = nowISO(); touch(it);
  state.recycleBin.push(it);
  render(); scheduleSave();
}
function addBag(name, cat) {
  state.hospitalBag.push({ id: uid(), name, packed: false, cat: cat || "mother", updatedAt: nowISO() });
  renderBag(); scheduleSave();
}
function deleteBag(id) {
  const it = state.hospitalBag.find(i => i.id === id);
  if (!it) return;
  if (!confirm(`להעביר את "${it.name}" לסל המחזור?`)) return;
  state.hospitalBag = state.hospitalBag.filter(i => i.id !== id);
  it.origin = "hospitalBag"; it.deletedAt = nowISO(); touch(it);
  state.recycleBin.push(it);
  renderBag(); renderBin(); scheduleSave();
}

// שחזור פריט מסל המחזור חזרה למקומו המקורי
function restoreFromBin(id) {
  const it = state.recycleBin.find(i => i.id === id);
  if (!it) return;
  state.recycleBin = state.recycleBin.filter(i => i.id !== id);
  const origin = it.origin || "items";
  delete it.deletedAt; delete it.origin; touch(it);
  if (origin === "hospitalBag") state.hospitalBag.push(it);
  else state.items.push(it);
  render(); scheduleSave();
}

// מחיקה לצמיתות מסל המחזור (אי אפשר לשחזר)
function permanentDelete(id) {
  const it = state.recycleBin.find(i => i.id === id);
  if (!it) return;
  if (!confirm(`למחוק לצמיתות את "${it.name}"? לא ניתן לשחזר.`)) return;
  state.recycleBin = state.recycleBin.filter(i => i.id !== id);
  state._deleted[id] = nowISO();
  renderBin(); scheduleSave();
}

/* ===== ייצוא ל-PDF / הדפסה (כל הקטגוריות פתוחות) ===== */
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
}

function buildPrintHtml(scope) {
  scope = scope || "all";
  const d = state;
  const fmt = n => "₪" + Math.round(n || 0).toLocaleString("he-IL");
  let total = 0, us = 0, shani = 0;
  d.items.forEach(it => { const s = (parseFloat(it.price) || 0) * (it.qty || 1); total += s; if (it.source === "shani") shani += s; else us += s; });
  const target = d.budget.target || 0;

  let body = "";
  if (scope === "all") {
    d.categories.forEach(cat => {
      const items = d.items.filter(it => it.category === cat.id);
      if (!items.length) return;
      const bought = items.filter(i => i.bought).length;
      body += `<section class="cat"><h2>${escapeHtml(cat.icon || "")} ${escapeHtml(cat.name)} <span class="cnt">${bought}/${items.length}</span></h2>`;
      items.forEach(it => {
        const src = it.source === "shani" ? '<span class="tag shani">שני</span>' : '<span class="tag us">אנחנו</span>';
        const urgTag = it.urgent ? '<span class="tag urgent">🔥 דחוף</span>' : "";
        const chk = it.bought ? "☑" : "☐";
        const qty = (it.qty || 1) > 1 ? ` <span class="qty">×${it.qty}</span>` : "";
        const price = (parseFloat(it.price) || 0) > 0 ? ` <span class="price">${fmt(it.price)}</span>` : "";
        const notes = it.notes ? ` <span class="notes">— ${escapeHtml(it.notes)}</span>` : "";
        body += `<div class="row ${it.bought ? "done" : ""}"><span class="chk">${chk}</span><span class="nm">${escapeHtml(it.name)}${qty}</span>${urgTag}${src}${price}${notes}</div>`;
        if (it.options && it.options.length) {
          body += `<div class="opts">`;
          it.options.forEach(o => {
            const star = o.chosen ? "⭐ " : "• ";
            const op = (parseFloat(o.price) || 0) > 0 ? ` (${fmt(o.price)})` : "";
            const where = o.where ? ` · ${escapeHtml(o.where)}` : "";
            const pros = o.pros ? ` · ✔️ ${escapeHtml(o.pros)}` : "";
            const cons = o.cons ? ` · ✖️ ${escapeHtml(o.cons)}` : "";
            body += `<div class="opt ${o.chosen ? "chosen" : ""}">${star}${escapeHtml(o.name || "אפשרות")}${op}${where}${pros}${cons}</div>`;
          });
          body += `</div>`;
        }
      });
      body += `</section>`;
    });
  }

  if ((scope === "all" || scope === "bag") && d.hospitalBag && d.hospitalBag.length) {
    const bagGroup = (name, icon, items) => {
      if (!items.length) return "";
      const packed = items.filter(i => i.packed).length;
      let s = `<section class="cat"><h2>${escapeHtml(icon || "")} ${escapeHtml(name)} <span class="cnt">${packed}/${items.length}</span></h2>`;
      items.forEach(it => { s += `<div class="row ${it.packed ? "done" : ""}"><span class="chk">${it.packed ? "☑" : "☐"}</span><span class="nm">${escapeHtml(it.name)}</span>${it.toBuy ? '<span class="tag shani">🛒 לקנות</span>' : ""}</div>`; });
      return s + `</section>`;
    };
    BAG_CATS.forEach(bc => { body += bagGroup(bc.name, bc.icon, d.hospitalBag.filter(it => it.cat === bc.id)); });
    body += bagGroup("כללי", "🧳", d.hospitalBag.filter(it => !BAG_CATS.some(bc => bc.id === it.cat)));
  }

  if (scope === "apartment") {
    d.apartment.categories.forEach(cat => {
      const items = d.apartment.items.filter(it => it.category === cat.id);
      if (!items.length) return;
      const doneC = items.filter(i => i.checked).length;
      body += `<section class="cat"><h2>${escapeHtml(cat.icon || "")} ${escapeHtml(cat.name)} <span class="cnt">${doneC}/${items.length}</span></h2>`;
      items.forEach(it => {
        const chk = it.checked ? "☑" : "☐";
        const reqTag = it.required ? '<span class="tag req">חובה</span>' : "";
        const urgTag = it.urgent ? '<span class="tag urgent">🔥 דחוף</span>' : "";
        const srcTag = it.source === "parents" ? '<span class="tag parents">הורים</span>' : "";
        const qty = (it.qty || 1) > 1 ? ` <span class="qty">×${it.qty}</span>` : "";
        const price = (parseFloat(it.price) || 0) > 0 ? ` <span class="price">${fmt(it.price)}</span>` : "";
        const notes = it.notes ? ` <span class="notes">— ${escapeHtml(it.notes)}</span>` : "";
        body += `<div class="row ${it.checked ? "done" : ""}"><span class="chk">${chk}</span><span class="nm">${escapeHtml(it.name)}${qty}</span>${urgTag}${reqTag}${srcTag}${price}${notes}</div>`;
        if (it.options && it.options.length) {
          body += `<div class="opts">`;
          it.options.forEach(o => {
            const star = o.chosen ? "⭐ " : "• ";
            const op = (parseFloat(o.price) || 0) > 0 ? ` (${fmt(o.price)})` : "";
            const where = o.where ? ` · ${escapeHtml(o.where)}` : "";
            const pros = o.pros ? ` · ✔️ ${escapeHtml(o.pros)}` : "";
            const cons = o.cons ? ` · ✖️ ${escapeHtml(o.cons)}` : "";
            body += `<div class="opt ${o.chosen ? "chosen" : ""}">${star}${escapeHtml(o.name || "אפשרות")}${op}${where}${pros}${cons}</div>`;
          });
          body += `</div>`;
        }
      });
      body += `</section>`;
    });
  }

  const isBag = scope === "bag";
  const isApt = scope === "apartment";
  const docTitle = isApt ? "🏠 רשימת מעבר דירה" : (isBag ? "👜 תיק לידה — רשימה לאריזה" : "🍼 רשימת קניות ללידה");
  const now = new Date().toLocaleDateString("he-IL", { year: "numeric", month: "long", day: "numeric" });
  const css = `
    *{box-sizing:border-box;}
    body{font-family:"Assistant","Segoe UI","Heebo",sans-serif;color:#222;margin:0;padding:22px;}
    .ph{display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px solid #6d8fd0;padding-bottom:10px;margin-bottom:14px;}
    .ph h1{margin:0;font-size:22px;color:#4a5fae;}
    .date{color:#777;font-size:13px;}
    .budget{display:flex;flex-wrap:wrap;gap:16px;background:#f4f6fc;border:1px solid #e3e7f5;border-radius:10px;padding:11px 15px;margin-bottom:18px;font-size:14px;}
    .cat{margin-bottom:14px;break-inside:avoid;}
    .cat h2{font-size:16px;background:#eef1fb;color:#3a4a8c;padding:8px 12px;border-radius:8px;margin:0 0 8px;}
    .cat h2 .cnt{float:left;font-size:12px;color:#7a85b5;font-weight:400;}
    .row{display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px dashed #e9e9f1;font-size:14px;break-inside:avoid;}
    .row .chk{font-size:15px;}
    .row .nm{flex:1;font-weight:600;}
    .row.done .nm{text-decoration:line-through;color:#9aa;}
    .qty{color:#666;font-weight:400;font-size:12px;}
    .tag{font-size:11px;font-weight:700;border-radius:10px;padding:1px 8px;color:#fff;white-space:nowrap;}
    .tag.us{background:#5b86c9;}.tag.shani{background:#e0a05e;}.tag.req{background:#c0554d;}.tag.parents{background:#4f9d8f;}.tag.urgent{background:#e8542a;}
    .price{color:#2e9b6b;font-weight:700;}
    .notes{color:#888;font-size:12px;}
    .opts{margin:1px 26px 8px;}
    .opt{font-size:12px;color:#555;padding:2px 0;break-inside:avoid;}
    .opt.chosen{color:#2e7d52;font-weight:700;}
    .pf{margin-top:20px;text-align:center;color:#aaa;font-size:11px;border-top:1px solid #eee;padding-top:8px;}
    @page{margin:14mm;}
  `;
  return `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>רשימת קניות ללידה</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>${css}</style></head><body>
    <header class="ph"><h1>${docTitle}</h1><div class="date">${now}</div></header>
    ${(isBag || isApt) ? "" : `<div class="budget"><div><b>סך הכל:</b> ${fmt(total)}</div><div><b>אנחנו:</b> ${fmt(us)}</div><div><b>שני:</b> ${fmt(shani)}</div>${target ? `<div><b>יעד:</b> ${fmt(target)}</div><div><b>נשאר:</b> ${fmt(Math.max(0, target - us))}</div>` : ""}</div>`}
    ${body}
    <footer class="pf">${docTitle} · נוצר ב-${now}</footer>
  </body></html>`;
}

function exportPdf(scope) {
  if (!state) { alert("אין נתונים להדפסה עדיין."); return; }
  const w = window.open("", "_blank");
  if (!w) { alert("חלון ההדפסה נחסם — אפשרו חלונות קופצים (popups) ונסו שוב."); return; }
  w.document.open();
  w.document.write(buildPrintHtml(scope));
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch (e) { /* המשתמש יכול להדפיס ידנית */ } }, 500);
}

/* ===== רשימת מעבר דירה (גיליון נפרד, מסונכרן) ===== */
function aptCatById(id) { return state.apartment.categories.find(c => c.id === id); }

function renderAptCategoryOptions() {
  const addSel = document.getElementById("aptAddCategory");
  const filterSel = document.getElementById("aptFilterCategory");
  if (!addSel || !filterSel) return;
  const curAdd = addSel.value, curFilter = filterSel.value;
  addSel.innerHTML = "";
  state.apartment.categories.forEach(c => {
    const o = document.createElement("option"); o.value = c.id; o.textContent = c.name; addSel.appendChild(o);
  });
  filterSel.innerHTML = '<option value="all">כל הקטגוריות</option>';
  state.apartment.categories.forEach(c => {
    const o = document.createElement("option"); o.value = c.id; o.textContent = c.name; filterSel.appendChild(o);
  });
  if (curAdd) addSel.value = curAdd;
  if (curFilter) filterSel.value = curFilter;
}

function renderApartment() {
  if (!state) return;
  renderAptCategoryOptions();
  const wrap = document.getElementById("aptList");
  if (!wrap) return;
  wrap.innerHTML = "";
  const q = (searchApt || "").trim().toLowerCase();
  const fCat = document.getElementById("aptFilterCategory").value;
  const fMissing = document.getElementById("aptFilterMissing").checked;
  const fReq = document.getElementById("aptFilterRequired").checked;
  const fParents = document.getElementById("aptFilterParents").checked;
  const fUrgent = document.getElementById("aptFilterUrgent").checked;

  const all = state.apartment.items;
  const total = all.length;
  const done = all.filter(i => i.checked).length;
  const pct = total ? Math.round(done / total * 100) : 0;
  document.getElementById("aptProgressBar").style.width = pct + "%";
  const reqTotal = all.filter(i => i.required).length;
  const reqDone = all.filter(i => i.required && i.checked).length;
  document.getElementById("aptProgressLabel").textContent =
    `הושלמו ${done} מתוך ${total} (${pct}%)` + (reqTotal ? ` · חובה: ${reqDone}/${reqTotal}` : "");

  const items = all.filter(it => {
    if (fCat !== "all" && it.category !== fCat) return false;
    if (fMissing && it.checked) return false;
    if (fReq && !it.required) return false;
    if (fParents && it.source !== "parents") return false;
    if (fUrgent && (!it.urgent || it.checked)) return false;
    if (q) {
      const hay = ((it.name || "") + " " + (it.notes || "") + " " +
        (it.options || []).map(o => (o.name || "") + " " + (o.where || "")).join(" ")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  state.apartment.categories.forEach(cat => {
    const catItems = items.filter(it => it.category === cat.id);
    if (!catItems.length) return;
    const collapsed = q ? false : collapsedApt.has(cat.id);
    const group = document.createElement("div");
    group.className = "cat-group";
    const doneC = catItems.filter(i => i.checked).length;
    const header = document.createElement("button");
    header.type = "button";
    header.className = "cat-title" + (collapsed ? " collapsed" : "");
    header.innerHTML = `<span class="cat-chev">${collapsed ? "▸" : "▾"}</span>
      <span class="cat-name">${cat.icon ? cat.icon + " " : ""}${cat.name}</span>
      <span class="cat-count">${doneC}/${catItems.length}</span>`;
    header.onclick = () => {
      if (collapsedApt.has(cat.id)) collapsedApt.delete(cat.id); else collapsedApt.add(cat.id);
      renderApartment();
    };
    group.appendChild(header);
    if (!collapsed) catItems.forEach(it => group.appendChild(aptItemCard(it)));
    wrap.appendChild(group);
  });

  const orphans = items.filter(it => !aptCatById(it.category));
  if (orphans.length) {
    const group = document.createElement("div");
    group.className = "cat-group";
    group.innerHTML = `<div class="cat-title">📦 שונות</div>`;
    orphans.forEach(it => group.appendChild(aptItemCard(it)));
    wrap.appendChild(group);
  }

  const emptyEl = document.getElementById("aptEmpty");
  if (!all.length) {
    emptyEl.textContent = "אין עדיין פריטים — הוסיפו את הראשון למעלה 👆";
    emptyEl.classList.remove("hidden");
  } else if (!wrap.children.length) {
    emptyEl.textContent = q ? `לא נמצאו פריטים לחיפוש "${searchApt.trim()}" 🔍` : "אין פריטים שמתאימים לסינון";
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
  }
}

function aptItemCard(it) {
  const card = document.createElement("div");
  card.className = "item apt-item" + (it.checked ? " bought" : "") + (it.required ? " req" : "") + (it.urgent ? " urgent" : "");

  const top = document.createElement("div");
  top.className = "item-top";
  const chk = document.createElement("input");
  chk.type = "checkbox"; chk.className = "item-check"; chk.checked = !!it.checked; chk.title = "יש / הושג";
  chk.onchange = () => { it.checked = chk.checked; touch(it); renderApartment(); scheduleSave(); };
  const name = document.createElement("input");
  name.className = "item-name"; name.value = it.name;
  name.onchange = () => { it.name = name.value.trim() || it.name; touch(it); scheduleSave(); };
  const del = document.createElement("button");
  del.className = "del-btn"; del.textContent = "🗑"; del.title = "מחיקה";
  del.onclick = () => aptDeleteItem(it.id);
  top.append(chk, name, del);

  const ctrl = document.createElement("div");
  ctrl.className = "item-controls";
  const req = document.createElement("button");
  req.type = "button";
  req.className = "req-badge " + (it.required ? "on" : "off");
  req.textContent = it.required ? "חובה" : "לא חובה";
  req.title = "חובה / לא חובה";
  req.onclick = () => { it.required = !it.required; touch(it); renderApartment(); scheduleSave(); };

  // מקור: אנחנו / הורים (כמו "שני" בקניות — מאפס מחיר)
  const src = document.createElement("button");
  src.type = "button";
  src.className = "src-badge " + (it.source === "parents" ? "parents" : "us");
  src.textContent = it.source === "parents" ? "הורים" : "אנחנו";
  src.title = "אנחנו / מההורים";
  src.onclick = () => {
    it.source = it.source === "parents" ? "us" : "parents";
    if (it.source === "parents") it.price = 0;
    touch(it); renderApartment(); scheduleSave();
  };

  // דחוף
  const urg = document.createElement("button");
  urg.type = "button";
  urg.className = "urgent-badge" + (it.urgent ? " on" : "");
  urg.textContent = "🔥 דחוף";
  urg.title = "סמן כדחוף";
  urg.onclick = () => { it.urgent = !it.urgent; touch(it); renderApartment(); scheduleSave(); };

  const qty = document.createElement("div");
  qty.className = "qty-box";
  const minus = document.createElement("button"); minus.textContent = "−";
  const num = document.createElement("span"); num.textContent = it.qty || 1;
  const plus = document.createElement("button"); plus.textContent = "+";
  minus.onclick = () => { it.qty = Math.max(1, (it.qty || 1) - 1); num.textContent = it.qty; touch(it); scheduleSave(); };
  plus.onclick = () => { it.qty = (it.qty || 1) + 1; num.textContent = it.qty; touch(it); scheduleSave(); };
  qty.append(minus, num, plus);

  const price = document.createElement("label");
  price.className = "price-field"; price.append(document.createTextNode("₪"));
  const pin = document.createElement("input");
  pin.type = "number"; pin.min = "0"; pin.step = "0.5"; pin.placeholder = "0"; pin.value = it.price || "";
  pin.onchange = () => { it.price = parseFloat(pin.value) || 0; touch(it); scheduleSave(); };
  price.appendChild(pin);

  ctrl.append(req, src, urg, qty, price);

  const notes = document.createElement("input");
  notes.className = "notes-field"; notes.placeholder = "הערות (דגם, מותג, מאיפה...)";
  notes.value = it.notes || "";
  notes.onchange = () => { it.notes = notes.value; touch(it); scheduleSave(); };

  card.append(top, ctrl, notes);

  it.options = it.options || [];
  const optBtn = document.createElement("button");
  optBtn.className = "opt-toggle" + (openAptOptions.has(it.id) ? " open" : "");
  const chosen = it.options.find(o => o.chosen);
  optBtn.textContent = "🔎 אפשרויות" + (it.options.length ? ` (${it.options.length})` : "") + (chosen && chosen.name ? ` · נבחר: ${chosen.name}` : "");
  optBtn.onclick = () => {
    if (openAptOptions.has(it.id)) openAptOptions.delete(it.id); else openAptOptions.add(it.id);
    renderApartment();
  };
  card.append(optBtn);
  if (openAptOptions.has(it.id)) card.append(buildOptionsPanel(it, renderApartment));

  return card;
}

function aptAddItem(name, category, required, source) {
  state.apartment.items.push({ id: uid(), name, category, required: !!required, source: source || "us", checked: false, qty: 1, price: 0, notes: "", options: [], updatedAt: nowISO() });
  renderApartment(); scheduleSave();
}
function aptDeleteItem(id) {
  const it = state.apartment.items.find(i => i.id === id);
  if (!it) return;
  if (!confirm(`למחוק את "${it.name}"?`)) return;
  state.apartment.items = state.apartment.items.filter(i => i.id !== id);
  state.apartment.deleted[id] = nowISO();
  renderApartment(); scheduleSave();
}

/* ===== אירועי ממשק ===== */
function setupUI() {
  // טאבים
  document.querySelectorAll(".tab").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
    };
  });

  // בורר מקור בטופס ההוספה
  let addSource = "us";
  document.querySelectorAll(".src-opt").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll(".src-opt").forEach(x => x.classList.remove("active"));
      b.classList.add("active"); addSource = b.dataset.src;
    };
  });

  // הוספת פריט
  document.getElementById("addForm").onsubmit = e => {
    e.preventDefault();
    const name = document.getElementById("addName").value.trim();
    if (!name) return;
    addItem(name, document.getElementById("addCategory").value, addSource, parseInt(document.getElementById("addQty").value) || 1);
    document.getElementById("addName").value = "";
    document.getElementById("addQty").value = "1";
    document.getElementById("addName").focus();
  };

  // הוספת פריט לתיק
  document.getElementById("addBagForm").onsubmit = e => {
    e.preventDefault();
    const name = document.getElementById("addBagName").value.trim();
    if (!name) return;
    addBag(name, document.getElementById("addBagCat").value);
    document.getElementById("addBagName").value = "";
  };

  // חיפוש
  const searchInput = document.getElementById("searchInput");
  const searchClear = document.getElementById("searchClear");
  searchInput.oninput = () => {
    searchQuery = searchInput.value;
    searchClear.classList.toggle("hidden", !searchQuery);
    renderShopping();
  };
  searchClear.onclick = () => {
    searchQuery = ""; searchInput.value = "";
    searchClear.classList.add("hidden");
    renderShopping(); searchInput.focus();
  };

  // סינונים
  document.getElementById("filterCategory").onchange = renderShopping;
  document.getElementById("filterUnbought").onchange = renderShopping;
  document.getElementById("filterShani").onchange = renderShopping;
  document.getElementById("filterUrgent").onchange = renderShopping;

  // תקציב
  document.getElementById("budgetTarget").onchange = e => {
    state.budget.target = parseFloat(e.target.value) || 0;
    renderBudget(); scheduleSave();
  };

  // כווץ / פתח את כל הקטגוריות
  document.getElementById("collapseAll").onclick = () => {
    state.categories.forEach(c => collapsedCats.add(c.id));
    renderShopping();
  };
  document.getElementById("expandAll").onclick = () => { collapsedCats.clear(); renderShopping(); };

  // הורדה / הדפסה ל-PDF (כל הקטגוריות פתוחות)
  document.getElementById("exportPdf").onclick = () => exportPdf("all");
  // הדפסת תיק לידה בלבד
  document.getElementById("exportBagPdf").onclick = () => exportPdf("bag");

  // חיפוש בתיק הלידה
  const searchBagInput = document.getElementById("searchBagInput");
  const searchBagClear = document.getElementById("searchBagClear");
  searchBagInput.oninput = () => {
    searchBagQuery = searchBagInput.value;
    searchBagClear.classList.toggle("hidden", !searchBagQuery);
    renderBag();
  };
  searchBagClear.onclick = () => {
    searchBagQuery = ""; searchBagInput.value = "";
    searchBagClear.classList.add("hidden");
    renderBag(); searchBagInput.focus();
  };

  // כווץ / פתח את כל קטגוריות התיק
  document.getElementById("collapseAllBag").onclick = () => {
    BAG_CATS.forEach(bc => collapsedBagCats.add(bc.id));
    collapsedBagCats.add("__other");
    renderBag();
  };
  document.getElementById("expandAllBag").onclick = () => { collapsedBagCats.clear(); renderBag(); };

  // סינוני תיק הלידה
  document.getElementById("filterBagUnpacked").onchange = renderBag;
  document.getElementById("filterBagToBuy").onchange = renderBag;

  // ===== רשימת מעבר דירה =====
  let aptReq = "1";
  document.querySelectorAll(".req-opt").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll(".req-opt").forEach(x => x.classList.remove("active"));
      b.classList.add("active"); aptReq = b.dataset.req;
    };
  });
  let aptSrc = "us";
  document.querySelectorAll(".apt-src-opt").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll(".apt-src-opt").forEach(x => x.classList.remove("active"));
      b.classList.add("active"); aptSrc = b.dataset.src;
    };
  });
  document.getElementById("aptAddForm").onsubmit = e => {
    e.preventDefault();
    const name = document.getElementById("aptAddName").value.trim();
    if (!name) return;
    aptAddItem(name, document.getElementById("aptAddCategory").value, aptReq === "1", aptSrc);
    document.getElementById("aptAddName").value = "";
    document.getElementById("aptAddName").focus();
  };
  const aptSearchInput = document.getElementById("aptSearchInput");
  const aptSearchClear = document.getElementById("aptSearchClear");
  aptSearchInput.oninput = () => {
    searchApt = aptSearchInput.value;
    aptSearchClear.classList.toggle("hidden", !searchApt);
    renderApartment();
  };
  aptSearchClear.onclick = () => {
    searchApt = ""; aptSearchInput.value = "";
    aptSearchClear.classList.add("hidden");
    renderApartment(); aptSearchInput.focus();
  };
  document.getElementById("aptFilterCategory").onchange = renderApartment;
  document.getElementById("aptFilterMissing").onchange = renderApartment;
  document.getElementById("aptFilterRequired").onchange = renderApartment;
  document.getElementById("aptFilterParents").onchange = renderApartment;
  document.getElementById("aptFilterUrgent").onchange = renderApartment;
  document.getElementById("aptCollapseAll").onclick = () => {
    state.apartment.categories.forEach(c => collapsedApt.add(c.id));
    renderApartment();
  };
  document.getElementById("aptExpandAll").onclick = () => { collapsedApt.clear(); renderApartment(); };
  document.getElementById("aptExportPdf").onclick = () => exportPdf("apartment");

  // רוקן סל מחזור
  document.getElementById("emptyBinBtn").onclick = () => {
    if (!state.recycleBin.length) return;
    if (!confirm("למחוק לצמיתות את כל הפריטים בסל המחזור? לא ניתן לשחזר.")) return;
    const now = nowISO();
    state.recycleBin.forEach(it => { state._deleted[it.id] = now; });
    state.recycleBin = [];
    renderBin(); scheduleSave();
  };

  // רענון ידני
  document.getElementById("refreshBtn").onclick = () => { if (saving) return; load(); };

  // הגדרות
  document.getElementById("settingsBtn").onclick = openSettings;
  document.getElementById("cfgCancel").onclick = () => document.getElementById("settingsModal").classList.add("hidden");
  document.getElementById("cfgSave").onclick = saveSettings;
}

/* ===== הגדרות ===== */
function openSettings() {
  const m = document.getElementById("settingsModal");
  if (cfg) {
    document.getElementById("cfgOwner").value = cfg.owner || "";
    document.getElementById("cfgRepo").value = cfg.repo || "";
    document.getElementById("cfgBranch").value = cfg.branch || "main";
    document.getElementById("cfgToken").value = cfg.token || "";
  } else {
    document.getElementById("cfgRepo").value = "baby-list";
    document.getElementById("cfgBranch").value = "main";
  }
  m.classList.remove("hidden");
}
function showCfgMsg(type, txt) {
  const el = document.getElementById("cfgMsg");
  el.className = "cfg-msg " + type; el.textContent = txt;
}
async function saveSettings() {
  const c = {
    owner: document.getElementById("cfgOwner").value.trim(),
    repo: document.getElementById("cfgRepo").value.trim(),
    branch: document.getElementById("cfgBranch").value.trim() || "main",
    token: document.getElementById("cfgToken").value.trim()
  };
  if (!c.owner || !c.repo || !c.token) { showCfgMsg("err", "נא למלא שם משתמש, repo וטוקן."); return; }
  showCfgMsg("", "בודק חיבור…");
  saveConfig(c);
  try {
    const remote = await fetchRemote();
    state = remote.data; fileSha = remote.sha;
    showCfgMsg("ok", "החיבור הצליח! ✓");
    setSaveStatus("saved");
    render(); startPolling();
    setTimeout(() => document.getElementById("settingsModal").classList.add("hidden"), 700);
  } catch (err) {
    showCfgMsg("err", "החיבור נכשל: " + err.message);
  }
}

/* ===== הפעלה ===== */
document.addEventListener("DOMContentLoaded", () => {
  setupUI();
  load();
});
