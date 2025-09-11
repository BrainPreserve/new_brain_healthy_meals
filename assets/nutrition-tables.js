/* BrainPreserve tables module — SAFE RESET (renders-all fallback) + Mojibake fix + No-HTML number chooser
   What this version guarantees:
   - If NO ingredients are provided to renderTables(...), it shows ALL rows (safe fallback).
   - If ingredients ARE provided, it filters to ONLY those rows (case-insensitive; alias-aware via master.csv).
   - Aggressively cleans mojibake (Ã¢ÂÂ etc.) and removes the replacement char (�), including combos like "�–".
   - Drops blank CSV rows and hides phantom/always-empty columns.
   - Auto-injects a "Number of recipes (optional)" input above the selections button WITHOUT editing index.html.
*/

(function () {
  // =========================
  // CONFIG
  // =========================
  const CFG = {
    paths: {
      master:   '/data/master.csv',
      nutrition:'/data/table_nutrition.csv',
      cognitive:'/data/table_cognitive_benefits.csv',
      diet:     '/data/table_diet_compatibility.csv',
      micro:    '/data/table_microbiome.csv'
    },
    keyColumns:   ['ingredient_name', 'ingredient', 'food', 'item', 'name'],
    aliasColumns: ['aliases', 'alias', 'also_known_as'],
    // IMPORTANT: keep true to avoid "no tables" if some flow forgets to pass ingredients.
    renderAllWhenNoIngredients: true
  };

  // =========================
  // DATA
  // =========================
  const DATA = {
    loaded: false,
    master: [],
    masterIndex: new Map(),   // normName -> CanonicalName
    aliasToCanon: new Map(),  // normAlias -> CanonicalName
    tables: { nutrition: [], cognitive: [], diet: [], micro: [] }
  };

  // =========================
  // HELPERS
  // =========================
  function norm(s) {
    return String(s || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s\-\/&'().,]/gu, '') // keep common punctuation
      .replace(/\s+/g, ' ')
      .trim();
  }

  // --- Robust mojibake fixer ---
  function maybeRecodeUTF8(s) {
    const suspect = /[ÃÂâ€¢]|â|Ã¢Â|Ãƒ|ï¿½/.test(s);
    if (!suspect) return s;
    try {
      const bytes = Uint8Array.from([...s].map(ch => ch.charCodeAt(0) & 0xFF));
      const decoded = new TextDecoder('utf-8').decode(bytes);
      const score = t => (t.match(/[ÃÂâ€¢]|â|Ã¢Â|Ãƒ|ï¿½/g) || []).length;
      if (score(decoded) <= score(s)) s = decoded;
    } catch (_) {}
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return s;
  }

  // Display sanitizer — includes stubborn sequences + U+FFFD removal
  function cleanDisplay(val) {
    let s = String(val ?? '');
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    s = s.replace(/\u00A0/g, ' ');
    s = maybeRecodeUTF8(s);

    const replacements = [
      [/Ã¢ÂÂ|Ã¢Â€Â™|â€™|â/g, '’'],
      [/Ã¢ÂÂ˜|Ã¢Â€Â˜|â€˜|â˜/g, '‘'],
      [/Ã¢ÂÂœ|Ã¢Â€Âœ|â€œ|â/g, '“'],
      [/Ã¢ÂÂ�|Ã¢Â€Â�|â€|â/g, '”'],
      [/Ã¢ÂÂ“|Ã¢Â€Â“|â€“|â/g, '–'],
      [/Ã¢ÂÂ”|Ã¢Â€Â”|â€”|â/g, '—'],
      [/Ã¢ÂÂ¦|Ã¢Â€Â¦|â€¦|â¦/g, '…'],
      [/Ã‚|Â/g, '']
    ];
    for (const [pat, rep] of replacements) s = s.replace(pat, rep);

    s = s.replace(/\uFFFD\s*–/g, '–');
    s = s.replace(/–\s*\uFFFD/g, '–');
    s = s.replace(/\uFFFD\s*-\s*/g, '-');
    s = s.replace(/-\s*\uFFFD/g, '-');
    s = s.replace(/\uFFFD+/g, '');
    s = s.replace(/[ \t]{2,}/g, ' ');
    return s.trim();
  }

  function isHeaderNameOk(name) {
    if (!name) return false;
    const t = String(name).trim();
    if (!t) return false;
    const l = t.toLowerCase();
    if (l === '_' || /^_+\d*$/.test(l)) return false;
    if (/^unnamed/i.test(t)) return false;
    if (/^column\d+$/i.test(t)) return false;
    return true;
  }

  function chooseHeaders(rows) {
    if (!rows || rows.length === 0) return [];
    const all = new Set();
    for (const r of rows) Object.keys(r).forEach(k => all.add(k));
    let headers = Array.from(all).filter(isHeaderNameOk);
    headers = headers.filter(h => rows.some(r => String(r[h] ?? '').trim() !== ''));
    return headers;
  }

  function dropEmptyRows(rows) {
    return (rows || []).filter(row =>
      Object.values(row).some(v => String(v ?? '').trim() !== '')
    );
  }

  function pick(obj, candidateKeys) {
    const keys = Object.keys(obj);
    for (const k of candidateKeys) {
      const hit = keys.find(h => h.toLowerCase() === k.toLowerCase());
      if (hit) return { key: hit, value: obj[hit] };
    }
    return undefined;
  }

  function getKeyValue(row) {
    const p = pick(row, CFG.keyColumns);
    return p ? String(p.value) : '';
  }

  function splitAliases(val) {
    if (val == null || val === '') return [];
    return String(val).split(/[;,]/g).map(x => norm(x)).filter(Boolean);
  }

  // CSV loader with pre-parse mojibake repair
  function csv(path) {
    return new Promise((resolve, reject) => {
      Papa.parse(path, {
        download: true,
        header: true,
        dynamicTyping: false,
        skipEmptyLines: true,
        beforeFirstChunk: function (chunk) {
          let fixed = chunk || '';
          if (fixed && fixed.charCodeAt(0) === 0xFEFF) fixed = fixed.slice(1);
          fixed = maybeRecodeUTF8(fixed);
          fixed = fixed.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          return fixed;
        },
        complete: (res) => {
          const rows = dropEmptyRows(res.data || []);
          for (const row of rows) {
            for (const k of Object.keys(row)) {
              const v = row[k];
              if (typeof v === 'string') row[k] = cleanDisplay(v);
            }
          }
          resolve(rows);
        },
        error: reject
      });
    });
  }

  function buildMasterIndexes() {
    DATA.masterIndex.clear();
    DATA.aliasToCanon.clear();

    for (const row of DATA.master) {
      const rawName = getKeyValue(row);
      if (!rawName) continue;
      const canonName = String(rawName).trim();
      const normName  = norm(rawName);
      if (!DATA.masterIndex.has(normName)) DATA.masterIndex.set(normName, canonName);

      const aliasField = pick(row, CFG.aliasColumns);
      if (aliasField && aliasField.value) {
        for (const a of splitAliases(aliasField.value)) {
          if (!DATA.aliasToCanon.has(a)) DATA.aliasToCanon.set(a, canonName);
        }
      }
    }
  }

  function lookupCanonical(nameOrAlias) {
    const n = norm(nameOrAlias);
    if (!n) return undefined;
    if (DATA.masterIndex.has(n)) return DATA.masterIndex.get(n);
    if (DATA.aliasToCanon.has(n)) return DATA.aliasToCanon.get(n);
    return undefined;
  }

  function canonicalizeList(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach(name => {
      const c = lookupCanonical(name) || String(name || '').trim();
      if (c) out.push(c);
    });
    return Array.from(new Set(out));
  }

  function filterByIngredients(tableRows, ingredientSet) {
    if (!ingredientSet || ingredientSet.size === 0) return tableRows.slice();
    const out = [];
    for (const row of tableRows) {
      const keyVal = getKeyValue(row);
      if (!keyVal) continue;
      const canon = lookupCanonical(keyVal) || String(keyVal).trim();
      if (ingredientSet.has(canon)) out.push(row);
    }
    return out;
  }

  // =========================
  // LOAD & RENDER
  // =========================
  async function loadAll() {
    if (DATA.loaded) return;

    DATA.master = await csv(CFG.paths.master);
    buildMasterIndexes();

    DATA.tables.nutrition = await csv(CFG.paths.nutrition);
    DATA.tables.cognitive = await csv(CFG.paths.cognitive);
    DATA.tables.diet      = await csv(CFG.paths.diet);
    DATA.tables.micro     = await csv(CFG.paths.micro);

    DATA.loaded = true;
  }

  function createTable(title, rows) {
    const box = document.createElement('div');
    box.className = 'card';

    const h = document.createElement('h3');
    h.textContent = title;
    box.appendChild(h);

    if (!rows || rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No matching rows.';
      box.appendChild(p);
      return box;
    }

    const headers = chooseHeaders(rows);
    const table = document.createElement('table');

    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    headers.forEach(col => {
      const th = document.createElement('th');
      th.textContent = cleanDisplay(col);
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach(row => {
      const tr = document.createElement('tr');
      headers.forEach(col => {
        const td = document.createElement('td');
        const v = row[col];
        td.textContent = (v != null && String(v).trim() !== '') ? cleanDisplay(v) : '—';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    box.appendChild(table);
    return box;
  }

  function renderAllTables(ingredientList) {
    const mount = document.getElementById('bp-nutrition');
    if (!mount) return;

    mount.innerHTML = '';

    const canonList = canonicalizeList(ingredientList);
    const ingredientSet = new Set(canonList);

    const base = CFG.renderAllWhenNoIngredients && ingredientSet.size === 0;
    const t1 = base ? DATA.tables.nutrition.slice() : filterByIngredients(DATA.tables.nutrition, ingredientSet);
    const t2 = base ? DATA.tables.cognitive.slice() : filterByIngredients(DATA.tables.cognitive, ingredientSet);
    const t3 = base ? DATA.tables.diet.slice()      : filterByIngredients(DATA.tables.diet,      ingredientSet);
    const t4 = base ? DATA.tables.micro.slice()     : filterByIngredients(DATA.tables.micro,     ingredientSet);

    const any =
      (t1 && t1.length) ||
      (t2 && t2.length) ||
      (t3 && t3.length) ||
      (t4 && t4.length);

    if (!any) return;

    mount.appendChild(createTable('Nutrition',                        t1));
    mount.appendChild(createTable('Cognitive Benefits',               t2));
    mount.appendChild(createTable('Diet Compatibility',               t3));
    mount.appendChild(createTable('Gut Health / Microbiome Support',  t4));
  }

  // =========================
  // PUBLIC API
  // =========================
  window.BP = window.BP || {};

  window.BP.renderTables = async function (ingredientsArray) {
    try {
      await loadAll();
      renderAllTables(Array.isArray(ingredientsArray) ? ingredientsArray : []);
    } catch (err) {
      const mount = document.getElementById('bp-nutrition');
      if (mount) {
        mount.innerHTML = '';
        const e = document.createElement('div');
        e.className = 'error';
        e.textContent = 'Error rendering tables: ' + (err?.message || String(err));
        mount.appendChild(e);
      }
      console.error(err);
    }
  };

  window.BP.deriveIngredientsFromRecipe = function (text) {
    if (!text || typeof text !== 'string') return [];
    const hay = ' ' + norm(text) + ' ';
    const found = new Set();

    for (const canonName of DATA.masterIndex.values()) {
      const needle = ' ' + norm(canonName) + ' ';
      if (hay.indexOf(needle) !== -1) found.add(canonName);
    }
    for (const [aliasNorm, canonName] of DATA.aliasToCanon.entries()) {
      const needle = ' ' + aliasNorm + ' ';
      if (hay.indexOf(needle) !== -1) found.add(canonName);
    }
    return Array.from(found);
  };

  // =========================
  // UI ENHANCEMENT: Auto-inject "Number of recipes" (no edits to index.html)
  // =========================
  (function () {
    function injectNumChooser(){
      try {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => (b.getAttribute('onclick')||'').includes('generateFromSelections'));
        if (!btn) return;
        const btnRow = btn.closest('.btn-row') || btn.parentElement;
        if (!btnRow || document.getElementById('num-recipes-form')) return;

        const wrap = document.createElement('div');
        wrap.className = 'row';

        const label = document.createElement('label');
        label.setAttribute('for', 'num-recipes-form');
        label.textContent = 'Number of recipes (optional):';

        const input = document.createElement('input');
        input.id = 'num-recipes-form';
        input.type = 'number';
        input.min = '1';
        input.max = '10';
        input.placeholder = '3–5';

        wrap.appendChild(label);
        wrap.appendChild(input);

        btnRow.parentElement.insertBefore(wrap, btnRow);
      } catch (_) {}
    }

    function wrapGenerateFromSelections(){
      if (typeof window.generateFromSelections !== 'function' || window._bpPatchedSelections) return;
      const original = window.generateFromSelections;

      window.generateFromSelections = async function(...args){
        const numEl = document.getElementById('num-recipes-form');
        const n = numEl ? parseInt(numEl.value, 10) : NaN;

        if (Number.isFinite(n) && typeof window.callOpenAI === 'function') {
          const origCall = window.callOpenAI;
          window.callOpenAI = async function(messages, ...rest){
            try {
              const msgs = Array.isArray(messages) ? messages.map(m => ({...m})) : [];
              const i = msgs.findIndex(m => m && m.role === 'user' && typeof m.content === 'string');
              if (i >= 0) {
                msgs[i].content = msgs[i].content.replace(/^Generate\s+.*?recipes\.\s*\n?/i, '');
                msgs[i].content = `Generate ${n} recipes.\n` + msgs[i].content;
              }
              return await origCall.call(this, msgs, ...rest);
            } finally {
              window.callOpenAI = origCall;
            }
          };
        }
        return original.apply(this, args);
      };

      window._bpPatchedSelections = true;
    }

    if (document && document.addEventListener) {
      document.addEventListener('DOMContentLoaded', function(){
        injectNumChooser();
        wrapGenerateFromSelections();
      });
    }
  })();

  // Preload
  if (document && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', () => {
      loadAll().catch(() => {});
    });
  }
})();

/* ===== AutoChooser — deterministic, exclusion-aware category picker ===== */
(function () {
  async function loadCSV(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return [];
    const headers = lines[0].split(",").map(h => h.trim());
    return lines.slice(1).map(row => {
      const cells = row.split(",");
      const obj = {};
      headers.forEach((h, i) => obj[h] = (cells[i] ?? "").trim());
      return obj;
    });
  }
  function cleanDisplay(s) {
    if (!s) return s;
    return s.replace(/\uFFFD/g, "").replace(/Ã¢ÂÂ/g, "’").replace(/Ã‚Â/g, "").replace(/�+/g, "").replace(/\s+/g, " ").trim();
  }
  function mulberry32(seed) {
    return function () {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hashSeed(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function pickOneDeterministic(arr, seedText) {
    if (!arr.length) return null;
    const rng = mulberry32(hashSeed(seedText));
    const idx = Math.floor(rng() * arr.length);
    return arr[idx];
  }
  async function chooseForCategories(seedText, categoryModes, exclusions = []) {
    let master = [];
    try { master = await loadCSV("/data/master.csv"); } catch (_) {}
    let categories = [];
    try { categories = await loadCSV("/data/categories.csv"); } catch (_) {}
    if (!master.length && !categories.length) throw new Error("No data found. Ensure /data/master.csv or /data/categories.csv exist.");

    const norm = s => (s || "").toLowerCase().trim();
    const exSet = new Set(exclusions.map(norm));
    function extractRows(rows) {
      if (!rows.length) return [];
      const keys = Object.keys(rows[0]).map(k => k.trim());
      const colName = keys.find(k => norm(k) === "ingredient_name") || keys.find(k => norm(k) === "name") || keys[0];
      const colCat  = keys.find(k => norm(k) === "category")        || keys[1] || keys[0];
      return rows.map(r => ({ ingredient: cleanDisplay(r[colName] || ""), category: cleanDisplay(r[colCat] || "") }))
                 .filter(r => r.ingredient && r.category);
    }
    const baseRows = extractRows(master.length ? master : categories);
    const chosen = new Map(), skipped = [], details = [];
    for (const [category, mode] of Object.entries(categoryModes || {})) {
      if (String(mode).toUpperCase() !== "GPT") continue;
      const candidates = baseRows.filter(r => norm(r.category) === norm(category)).filter(r => !exSet.has(norm(r.ingredient)));
      const pick = pickOneDeterministic(candidates, `${seedText}::${category}`);
      if (pick) { chosen.set(category, pick.ingredient); details.push({ category, picked: pick.ingredient, poolSize: candidates.length }); }
      else { skipped.push({ category, reason: "No eligible candidates (after exclusions or missing category)" }); }
    }
    return { chosen, diagnostics: { skipped, details, totalRows: baseRows.length } };
  }
  window.AutoChooser = { chooseForCategories };
})();

/* ===== Keep tables AFTER recipe/summary (idempotent) ===== */
(function () {
  const SUMMARY_SELECTORS = ['.recipe-summary','#recipe-summary','.ingredients-summary','.generated-recipe','.generated-summary','.recipes-output','#recipes-output','#output','#results','.results','main'];
  function isVisible(el){ if(!el) return false; const s = getComputedStyle(el); if (s.display==='none'||s.visibility==='hidden') return false; return !!(el.offsetWidth||el.offsetHeight||el.getClientRects().length); }
  function findSummaryAnchor(){
    const nodes=[]; SUMMARY_SELECTORS.forEach(sel=>document.querySelectorAll(sel).forEach(n=>{ if(isVisible(n)) nodes.push(n); }));
    return nodes.length?nodes[nodes.length-1]:null;
  }
  function ensureAfter(){
    const mount=document.getElementById('bp-nutrition'); if(!mount) return;
    const anchor=findSummaryAnchor(); if(!anchor||!anchor.parentNode) return;
    if (anchor.nextSibling!==mount) anchor.parentNode.insertBefore(mount, anchor.nextSibling);
  }
  function wrap(){
    if (!window.BP || typeof window.BP.renderTables!=='function' || window._bpAfterSummaryPatched) return;
    const original=window.BP.renderTables;
    window.BP.renderTables=async function(...args){ ensureAfter(); const out=await original.apply(this,args); ensureAfter(); let tries=0; const t=setInterval(()=>{ ensureAfter(); if(++tries>=12) clearInterval(t); },200); return out; };
    window._bpAfterSummaryPatched = true;
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', wrap); else wrap();
})();

/* ===== Collapsible wrapper keeper (no buttons injected) ===== */
(function () {
  function findSelBtn(){ return Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('onclick')||'').includes('generateFromSelections')) || null; }
  function selectorRoot(anchor){
    if(!anchor) return null;
    const form = anchor.closest('form'); if (form) return form;
    let n = anchor.parentElement;
    while(n && n!==document.body){ if(['DIV','SECTION','ARTICLE','MAIN'].includes(n.tagName) && n.querySelectorAll('input,select,textarea').length>=4) return n; n=n.parentElement; }
    return null;
  }
  function ensureWrapper(){
    const btn = findSelBtn(); const root = selectorRoot(btn); if(!root) return;
    if (root.closest('details.bp-collapser')) return;
    const details = document.createElement('details'); details.className='bp-collapser'; details.open=false;
    const summary = document.createElement('summary'); summary.textContent='Ingredient Selector (click to open)';
    const host = document.createElement('div'); host.className='bp-collapser-host';
    details.appendChild(summary); details.appendChild(host);
    root.parentNode.insertBefore(details, root); host.appendChild(root);
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', ensureWrapper); else ensureWrapper();
})();

/* ===== Hide the "Clear Custom" button (idempotent) ===== */
(function () {
  function hide(){
    const els = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a[role="button"]'));
    els.forEach(el => { const label=(el.textContent||el.value||'').trim().toLowerCase(); if (label==='clear custom') el.style.display='none'; });
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', hide); else hide();
})();

/* ===== BP Clear Controls v2 — two buttons, correct clearing, no overrides ===== */
(function () {
  const $  = (s,r=document)=>r.querySelector(s);
  const $$ = (s,r=document)=>Array.from(r.querySelectorAll(s));
  const text = el => (el ? (el.textContent||el.value||'').trim() : '');

  function findSelBtn(){ return $$('button').find(b => (b.getAttribute('onclick')||'').toLowerCase().includes('generatefromselections')) || null; }
  function selectorRoot(anchor){
    if(!anchor) return null;
    const form = anchor.closest('form'); if (form) return form;
    let n=anchor.parentElement; while(n && n!==document.body){ if(['DIV','SECTION','ARTICLE','MAIN'].includes(n.tagName) && n.querySelectorAll('input,select,textarea').length>=4) return n; n=n.parentElement; }
    return null;
  }
  function tablesMount(){ return $('#bp-nutrition'); }

  // --- resets ---
  function resetNumToBlank(){
    const ids = ['#num-recipes-form','#num-recipes','[name="numRecipes"]','[data-bp="num-recipes"]'];
    let el = null; for (const sel of ids){ el=$(sel); if(el) break; }
    if (!el) el = $$('input[type="number"]').find(n => /recipe|num/i.test((n.id||'')+(n.name||'')));
    if (el) try{ el.value=''; }catch(_){}
  }
  function resetSelectorInputs(root){
    if(!root) return;
    $$('input[type="checkbox"]',root).forEach(cb=>cb.checked=false);
    $$('input[type="radio"]',root).forEach(rb=>rb.checked=false);
    $$('input[type="text"], input[type="search"], input[type="email"], input[type="number"], textarea',root).forEach(i=>{i.value='';});
    $$('select',root).forEach(sel=>{ if(sel.multiple) Array.from(sel.options).forEach(o=>o.selected=false); else sel.selectedIndex=0; });
    resetNumToBlank();
  }
  function recollapseCategoriesOnly(root){
    if(!root) return;
    $$('details.category',root).forEach(d=>d.open=false);
    $$('[aria-expanded="true"]',root).forEach(el=>el.setAttribute('aria-expanded','false'));
    $$('.category-group.open, .ingredient-category.open',root).forEach(el=>el.classList.remove('open'));
  }
  function clearPreview(){
    ['#promptPreview','#preview','.preview','.preview-pane','.bp-preview-block'].forEach(sel => $$(sel).forEach(n => { n.textContent=''; n.style.display='none'; }));
  }
  function clearRecipeAndSummary(){
    ['.generated-recipe','.recipe-summary','#recipe-summary','.recipes-output','#recipes-output'].forEach(sel => $$(sel).forEach(n => { n.innerHTML=''; n.style.display='none'; }));
  }
  function clearTables(){ const m=tablesMount(); if(m) m.innerHTML=''; }

  // --- actions ---
  function clearSelectorAction(){
    const root = selectorRoot(findSelBtn());
    resetSelectorInputs(root);
    clearPreview();
    recollapseCategoriesOnly(root); // wrapper stays as-is
  }
  function clearEverythingAction(){
    clearRecipeAndSummary();
    clearTables();
    clearSelectorAction();
    try { selectorRoot(findSelBtn())?.scrollIntoView({behavior:'smooth',block:'start'}); } catch(_){}
  }

  // --- buttons (idempotent) ---
  function ensureSelectorClear(){
    const btnRef = findSelBtn(); const root = selectorRoot(btnRef); if(!root) return;
    // place immediately after the wrapper if present; else after the root
    const wrapper = root.closest('details.bp-collapser');
    const anchor = wrapper || root;
    if ($('#bp-clear-selector')) return;
    const btn = document.createElement('button');
    btn.id='bp-clear-selector'; btn.type='button'; btn.textContent='Clear Form';
    Object.assign(btn.style,{background:'#2563eb',color:'#fff',border:'1px solid #1e40af',borderRadius:'12px',padding:'10px 16px',fontWeight:'700',cursor:'pointer',margin:'12px 0',float:'right'});
    btn.addEventListener('click', clearSelectorAction);
    if (anchor.nextSibling) anchor.parentNode.insertBefore(btn, anchor.nextSibling); else anchor.parentNode.appendChild(btn);
  }

  function placeBottomClearIfTables(){
    const mount=tablesMount(); if(!mount||!mount.parentNode) return;
    let btn = $('#bp-clear-bottom');
    if(!btn){
      btn=document.createElement('button'); btn.id='bp-clear-bottom'; btn.type='button'; btn.textContent='Clear Form';
      Object.assign(btn.style,{display:'block',margin:'24px auto',background:'#2563eb',color:'#fff',border:'1px solid #1e40af',borderRadius:'12px',padding:'10px 16px',fontWeight:'700',cursor:'pointer'});
      btn.addEventListener('click', clearEverythingAction);
    }
    if (mount.nextSibling!==btn) mount.parentNode.insertBefore(btn, mount.nextSibling);
    // show only if tables are present
    btn.style.display = mount.children.length>0 ? 'block' : 'none';
  }

  function hideStrayClearsAboveTables(){
    const mount=tablesMount(); if(!mount) return;
    $$('button').forEach(b=>{
      const label=(text(b).toLowerCase());
      if (label.startsWith('clear form') && b.compareDocumentPosition(mount) & Node.DOCUMENT_POSITION_FOLLOWING) {
        // b is before mount → hide (unless it's our #bp-clear-selector inside wrapper)
        const root=selectorRoot(findSelBtn());
        const keep = b.id==='bp-clear-selector' || (root && root.contains(b));
        if(!keep) b.style.display='none';
      }
    });
  }

  function observeTables(){
    const mount=tablesMount(); if(!mount) return;
    placeBottomClearIfTables();
    const mo = new MutationObserver(()=>placeBottomClearIfTables());
    mo.observe(mount,{childList:true});
  }

  function boot(){
    ensureSelectorClear();
    observeTables();
    hideStrayClearsAboveTables();
  }

  if (document.readyState==='loading') {
    document.addEventListener('DOMContentLoaded', ()=>{ boot(); setTimeout(boot,250); setTimeout(boot,800); });
  } else { boot(); setTimeout(boot,250); setTimeout(boot,800); }
})();
