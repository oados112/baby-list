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

  let items = state.items.filter(it => {
    if (fCat !== "all" && it.category !== fCat) return false;
    if (fUnbought && it.bought) return false;
    if (fShani && it.source !== "shani") return false;
    return true;
  });

  document.getElementById("shoppingEmpty").classList.toggle("hidden", state.items.length > 0);

  // קיבוץ לפי קטגוריה לפי סדר הקטגוריות
  state.categories.forEach(cat => {
    const catItems = items.filter(it => it.category === cat.id);
    if (!catItems.length) return;
    const group = document.createElement("div");
    group.className = "cat-group";
    const bought = catItems.filter(i => i.bought).length;
    group.innerHTML = `<h3 class="cat-title">${cat.icon || ""} ${cat.name}
      <span class="cat-count">${bought}/${catItems.length}</span></h3>`;
    catItems.forEach(it => group.appendChild(itemCard(it)));
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
}

function itemCard(it) {
  const card = document.createElement("div");
  card.className = "item src-" + (it.source || "us") + (it.bought ? " bought" : "");

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

  ctrl.append(qty, src, price);

  // הערות
  const notes = document.createElement("input");
  notes.className = "notes-field"; notes.placeholder = "הערות (מידה, צבע, מותג...)";
  notes.value = it.notes || "";
  notes.onchange = () => { it.notes = notes.value; touch(it); scheduleSave(); };

  card.append(top, ctrl, notes);
  return card;
}

function renderBag() {
  const wrap = document.getElementById("bagList");
  wrap.innerHTML = "";
  state.hospitalBag.forEach(it => {
    const card = document.createElement("div");
    card.className = "item" + (it.packed ? " bought" : "");
    const chk = document.createElement("input");
    chk.type = "checkbox"; chk.className = "item-check"; chk.checked = !!it.packed;
    chk.onchange = () => { it.packed = chk.checked; touch(it); renderBag(); scheduleSave(); };
    const name = document.createElement("input");
    name.className = "item-name"; name.value = it.name;
    name.onchange = () => { it.name = name.value.trim() || it.name; touch(it); scheduleSave(); };
    const del = document.createElement("button");
    del.className = "del-btn"; del.textContent = "🗑";
    del.onclick = () => { deleteBag(it.id); };
    card.append(chk, name, del);
    wrap.appendChild(card);
  });
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
  let total = 0, us = 0, shani = 0;
  state.items.forEach(it => {
    const sum = (parseFloat(it.price) || 0) * (it.qty || 1);
    total += sum;
    if (it.source === "shani") shani += sum; else us += sum;
  });
  const target = state.budget.target || 0;
  const fmt = n => "₪" + Math.round(n).toLocaleString("he-IL");
  document.getElementById("budgetTotal").textContent = fmt(total);
  document.getElementById("budgetUs").textContent = fmt(us);
  document.getElementById("budgetShani").textContent = fmt(shani);
  document.getElementById("budgetRemaining").textContent = fmt(Math.max(0, target - us));
  const t = document.getElementById("budgetTarget");
  if (document.activeElement !== t) t.value = target || "";
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
function addBag(name) {
  state.hospitalBag.push({ id: uid(), name, packed: false, updatedAt: nowISO() });
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
    addBag(name);
    document.getElementById("addBagName").value = "";
  };

  // סינונים
  document.getElementById("filterCategory").onchange = renderShopping;
  document.getElementById("filterUnbought").onchange = renderShopping;
  document.getElementById("filterShani").onchange = renderShopping;

  // תקציב
  document.getElementById("budgetTarget").onchange = e => {
    state.budget.target = parseFloat(e.target.value) || 0;
    renderBudget(); scheduleSave();
  };

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
