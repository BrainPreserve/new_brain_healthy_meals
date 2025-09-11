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
    // If text looks garbled (Latin-1 mis-decoded UTF-8), reinterpret.
    const suspect = /[ÃÂâ€¢]|â|Ã¢Â|Ãƒ|ï¿½/.test(s);
    if (!suspect) return s;
    try {
      const bytes = Uint8Array.from([...s].map(ch => ch.charCodeAt(0) & 0xFF));
      const decoded = new TextDecoder('utf-8').decode(bytes);
      const score = t => (t.match(/[ÃÂâ€¢]|â|Ã¢Â|Ãƒ|ï¿½/g) || []).length;
      if (score(decoded) <= score(s)) s = decoded;
    } catch (_) {}
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // strip BOM
    return s;
  }

  // Display sanitizer — includes stubborn sequences + U+FFFD (�) removal
  function cleanDisplay(val) {
    let s = String(val ?? '');
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    s = s.replace(/\u00A0/g, ' ');      // NBSP → space
    s = maybeRecodeUTF8(s);

    const replacements = [
      // Single quotes (’ ‘) — includes exact "Ã¢ÂÂ"
      [/Ã¢ÂÂ|Ã¢Â€Â™|â€™|â/g, '’'],
      [/Ã¢ÂÂ˜|Ã¢Â€Â˜|â€˜|â˜/g, '‘'],
      // Double quotes (“ ”)
      [/Ã¢ÂÂœ|Ã¢Â€Âœ|â€œ|â/g, '“'],
      [/Ã¢ÂÂ�|Ã¢Â€Â�|â€|â/g, '”'],
      // Dashes
      [/Ã¢ÂÂ“|Ã¢Â€Â“|â€“|â/g, '–'],
      [/Ã¢ÂÂ”|Ã¢Â€Â”|â€”|â/g, '—'],
      // Ellipsis
      [/Ã¢ÂÂ¦|Ã¢Â€Â¦|â€¦|â¦/g, '…'],
      // Stray "Â"/"Ã‚"
      [/Ã‚|Â/g, '']
    ];
    for (const [pat, rep] of replacements) s = s.replace(pat, rep);

    // Explicitly remove the Unicode replacement char (�) and common combos
    s = s.replace(/\uFFFD\s*–/g, '–');  // �– → –
    s = s.replace(/–\s*\uFFFD/g, '–');  // –� → –
    s = s.replace(/\uFFFD\s*-\s*/g, '-'); // �- → -
    s = s.replace(/-\s*\uFFFD/g, '-');    // -� → -
    s = s.replace(/\uFFFD+/g, '');        // any remaining �

    s = s.replace(/[ \t]{2,}/g, ' ');
    return s.trim();
  }

  // Hide phantom headers (_1, Unnamed: 1, Column3) and empty-for-all columns
  function isHeaderNameOk(name) {
    if (!name) return false;
    const t = String(name).trim();
    if (!t) return false;
    const l = t.toLowerCase();
    if (l === '_' || /^_+\d*$/.test(l)) return false;        // _ or __ or _1
    if (/^unnamed/i.test(t)) return false;                   // Unnamed: 1
    if (/^column\d+$/i.test(t)) return false;                // Column1, Column2
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

  // Drop rows where every cell is blank
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
          // Light clean pass for all string fields
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
    return Array.from(new Set(out)); // unique
  }

  function filterByIngredients(tableRows, ingredientSet) {
    if (!ingredientSet || ingredientSet.size === 0) return tableRows.slice(); // fallback: ALL
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

    // Load master first (aliases)
    DATA.master = await csv(CFG.paths.master);
    buildMasterIndexes();

    // Load the four tables
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

    // Clear existing
    mount.innerHTML = '';

    // Canonicalize supplied ingredients (from recipe or selections)
    const canonList = canonicalizeList(ingredientList);
    const ingredientSet = new Set(canonList);

    // Filter each table (ALL if empty set and fallback enabled)
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

  // Main entry: call with an array of ingredient names (strings)
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

  // Phrase-based detector (optional use by your page)
  window.BP.deriveIngredientsFromRecipe = function (text) {
    if (!text || typeof text !== 'string') return [];
    const hay = ' ' + norm(text) + ' ';
    const found = new Set();

    // Try canonical names
    for (const canonName of DATA.masterIndex.values()) {
      const needle = ' ' + norm(canonName) + ' ';
      if (hay.indexOf(needle) !== -1) found.add(canonName);
    }
    // Try aliases
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
        if (!btnRow || document.getElementById('num-recipes-form')) return; // avoid duplicates

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

  // Preload data so it's ready when renderTables(...) is called
  if (document && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', () => {
      loadAll().catch(() => {});
    });
  }
})();

/* ========= BrainPreserve UI Enhancer (Standalone) v1.3 =========
   Anchor strategy:
   - Locate the button whose onclick contains "generateFromSelections"
   - Treat the nearest <form> as the selector; if none, use nearest container with multiple inputs
   Features:
   - Collapsible wrapper (closed by default)
   - Clear Form (Top) wired or injected; Clear Form (Bottom) always injected under results
   - Full reset (inputs/radios/checkboxes), recollapse groups, reset Number-of-Recipes to 5
   - Retries for late rendering; exposes window._bpEnhancerVersion = "1.3"
*/
(() => {
  const DEBUG = true;
  const log = (...a) => DEBUG && console.log('[BP-Enhancer v1.3]', ...a);

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const first = (sels, r = document) => sels.map(sel => $(sel, r)).find(Boolean) || null;

  function findSelectionsButton() {
    // Same heuristic used by the number-chooser above
    const buttons = $$('button');
    return buttons.find(b => (b.getAttribute('onclick') || '').includes('generateFromSelections')) || null;
  }

  function nearestContainer(el) {
    if (!el) return null;
    const form = el.closest('form');
    if (form) return form;
    let node = el;
    while (node && node !== document.body) {
      if (['DIV','SECTION','ARTICLE','MAIN'].includes(node.tagName)) {
        const inputs = node.querySelectorAll('input,select,textarea').length;
        if (inputs >= 4) return node; // looks like the selector pane
      }
      node = node.parentElement;
    }
    return null;
  }

  function findOutputRoot() {
    return (
      $('#output') ||
      $('#results') ||
      $('#tables-container') ||
      $('.recipes-output') ||
      $('.results') ||
      $('main') ||
      document.body
    );
  }

  function groupCandidates(root) {
    const raw = [
      ...$$('details.category', root),
      ...$$('.category-group', root),
      ...$$('.ingredient-category', root),
      ...$$('[data-category]', root),
      ...$$('fieldset', root),
      ...$$('section', root),
      ...$$('div', root)
    ];
    const uniq = Array.from(new Set(raw)).filter(el =>
      el.querySelector && el.querySelector('input[type="checkbox"]')
    );
    return uniq;
  }

  // ---------- reset actions ----------
  function collapse(el) {
    if (!el) return;
    if (el.tagName && el.tagName.toLowerCase() === 'details') { el.open = false; return; }
    el.style.display = 'none';
  }
  function recollapseAll(root) {
    groupCandidates(root).forEach(g => {
      $$('input[type="checkbox"]', g).forEach(cb => cb.checked = false);
      collapse(g);
    });
  }
  function resetRadios(root) { $$('input[type="radio"]', root).forEach(r => r.checked = false); }
  function resetTextish(root) {
    $$('input[type="text"], input[type="search"], input[type="email"], input[type="number"], textarea', root)
      .forEach(i => i.value = '');
    $$('select', root).forEach(sel => { if (sel.multiple) Array.from(sel.options).forEach(o => o.selected=false); else sel.selectedIndex = 0; });
  }
  function resetNumRecipes() {
    const candidates = [
      '#num-recipes-form', '#num-recipes', '[name="numRecipes"]', '[data-bp="num-recipes"]'
    ];
    let el = first(candidates) ||
             $$('input[type="number"], select').find(e =>
               /recipe|num/i.test(e.name || '') || /recipe|num/i.test(e.id || '')
             );
    if (!el) return;
    if (el.tagName && el.tagName.toLowerCase() === 'select') {
      const idx = Array.from(el.options).findIndex(o => (o.value || o.textContent).trim() === '5');
      el.selectedIndex = idx >= 0 ? idx : 0;
    } else {
      el.value = '5';
    }
  }
  function fullClear(root) {
    resetTextish(root);
    resetRadios(root);
    recollapseAll(root);
    resetNumRecipes();
  }

  // ---------- UI injection ----------
  function ensureStyles() {
    if ($('#bp-enhancer-style')) return;
    const st = document.createElement('style');
    st.id = 'bp-enhancer-style';
    st.textContent = `
      .bp-collapser > summary {
        list-style: none; cursor: pointer; user-select: none;
        padding: 10px 14px; margin: 0 0 10px 0;
        border: 1px solid #ddd; border-radius: 10px; background: #fafafa; font-weight: 600;
      }
      .bp-collapser[open] > summary { background: #f0f0f0; }
      .bp-btn-clear {
        border: 1px solid #ccc; border-radius: 10px; padding: 8px 12px;
        font-size: 14px; cursor: pointer; background: #f7f7f7;
      }
      .bp-btn-clear:hover { background: #efefef; }
      .bp-top-clear-wrap { margin: 10px 0 16px 0; text-align: right; }
    `;
    document.head.appendChild(st);
  }

  function ensureCollapsible(root) {
    if (root.closest('.bp-collapser')) return;
    const details = document.createElement('details');
    details.className = 'bp-collapser';
    details.open = false;
    const summary = document.createElement('summary');
    summary.textContent = 'Ingredient Selector (click to open)';
    const host = document.createElement('div');
    host.className = 'bp-collapser-host';
    details.appendChild(summary);
    details.appendChild(host);
    root.parentNode.insertBefore(details, root);
    host.appendChild(root);
  }

  function ensureTopClear(root) {
    // If a Clear button already exists near the selector, wire it; otherwise inject our own.
    let btn = root.querySelector('#clear-form, [data-action="clear-form"], button.clear-form');
    if (!btn) {
      const wrap = document.createElement('div');
      wrap.className = 'bp-top-clear-wrap';
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bp-btn-clear';
      btn.textContent = 'Clear Form';
      wrap.appendChild(btn);
      const details = root.closest('.bp-collapser') || root;
      details.parentNode.insertBefore(wrap, details.nextSibling);
    }
    if (!btn.dataset.bpBound) {
      btn.dataset.bpBound = '1';
      btn.addEventListener('click', () => fullClear(root));
    }
  }

  function ensureBottomClear(root) {
    const out = findOutputRoot();
    if (!out || $('.bp-bottom-clear', out)) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bp-bottom-clear bp-btn-clear';
    btn.textContent = 'Clear Form (Bottom)';
    Object.assign(btn.style, { display: 'block', margin: '24px auto' });
    btn.addEventListener('click', () => {
      fullClear(root);
      root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    out.appendChild(btn);
  }

  // ---------- Boot (anchor to generateFromSelections button) ----------
  function initOnce() {
    const selBtn = findSelectionsButton();
    if (!selBtn) { log('Selections button not found yet'); return false; }
    const root = nearestContainer(selBtn);
    if (!root) { log('Could not determine selector container near the button'); return false; }

    ensureStyles();
    ensureCollapsible(root);
    ensureTopClear(root);
    ensureBottomClear(root);

    // Persist bottom clear across re-renders
    const mo = new MutationObserver(() => ensureBottomClear(root));
    mo.observe(document.body, { childList: true, subtree: true });

    window._bpEnhancerVersion = '1.3';
    log('Initialized on container:', root);
    return true;
  }

  // Retry for late-rendered UIs
  let attempts = 0;
  function spin() {
    if (initOnce()) return;
    attempts++;
    if (attempts < 50) setTimeout(spin, 200);
    else log('Stopped retrying (no selections button / container found).');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', spin);
  } else {
    spin();
  }
})();
/* ===== AutoChooser — deterministic, exclusion-aware category picker =====
   What this adds:
   - window.AutoChooser.chooseForCategories(seedText, categoryModes, exclusions)
   - Deterministically picks ONE ingredient for each category whose mode is "GPT"
   - Looks up candidates from master.csv (preferred) or categories.csv (fallback)
   - Excludes anything listed in exclusions (case-insensitive match on ingredient_name)
   - Returns { chosen: Map<category, ingredient>, diagnostics: {...} }

   How to use (later, in your own submit/collect code):
     const result = await window.AutoChooser.chooseForCategories(
       seedText,                                  // e.g., 'session-1' or your recipe prompt
       { Vegetables: "GPT", Fruit: "GPT" },       // categories where app should choose
       ["Dairy", "Red Meat"]                      // ingredient-level exclusions (optional)
     );
     // Merge result.chosen into your final ingredient list before building the prompt.
*/

(function () {
  // ---- tiny CSV loader (no external libs) ----
  async function loadCSV(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return [];
    const headers = lines[0].split(",").map(h => h.trim());
    return lines.slice(1).map(row => {
      const cells = row.split(","); // simple CSV; if your CSV has quoted commas, use a proper parser later
      const obj = {};
      headers.forEach((h, i) => obj[h] = (cells[i] ?? "").trim());
      return obj;
    });
  }

  // ---- mojibake cleaner (safe; no HTML changes) ----
  function cleanDisplay(s) {
    if (!s) return s;
    return s
      .replace(/\uFFFD/g, "")             // remove replacement char �
      .replace(/Ã¢ÂÂ/g, "’")
      .replace(/Ã‚Â/g, "")                 // stray "Â"
      .replace(/�+/g, "")                  // any remaining sequences of �
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---- deterministic PRNG (mulberry32) ----
  function mulberry32(seed) {
    return function () {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hashSeed(text) {
    // simple 32-bit hash for deterministic seeding
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // ---- pick one item deterministically from an array ----
  function pickOneDeterministic(arr, seedText) {
    if (!arr.length) return null;
    const rng = mulberry32(hashSeed(seedText));
    const idx = Math.floor(rng() * arr.length);
    return arr[idx];
  }

  // ---- core: choose 1 ingredient per "GPT" category ----
  async function chooseForCategories(seedText, categoryModes, exclusions = []) {
    // Load data: prefer master.csv; fallback to categories.csv if needed
    let master = [];
    try {
      master = await loadCSV("/data/master.csv");
    } catch (e) {
      // ignore; try categories.csv
    }
    let categories = [];
    try {
      categories = await loadCSV("/data/categories.csv");
    } catch (e) {
      // ignore
    }

    if (!master.length && !categories.length) {
      throw new Error("No data found. Ensure /data/master.csv or /data/categories.csv exist.");
    }

    // Flexible column detection
    // Expected in master: ingredient_name, category  (case-insensitive)
    // Expected in categories: ingredient_name, category  (or 'name' + 'category')
    const norm = s => (s || "").toLowerCase().trim();
    const exSet = new Set(exclusions.map(norm));

    function extractRows(rows) {
      if (!rows.length) return [];
      // find column names
      const keys = Object.keys(rows[0]).map(k => k.trim());
      const colName = keys.find(k => norm(k) === "ingredient_name") || keys.find(k => norm(k) === "name") || keys[0];
      const colCat  = keys.find(k => norm(k) === "category") || keys[1] || keys[0];
      return rows.map(r => ({
        ingredient: cleanDisplay(r[colName] || ""),
        category: cleanDisplay(r[colCat]   || "")
      })).filter(r => r.ingredient && r.category);
    }

    const baseRows = extractRows(master.length ? master : categories);

    const chosen = new Map();
    const skipped = [];
    const details = [];

    for (const [category, mode] of Object.entries(categoryModes || {})) {
      if (String(mode).toUpperCase() !== "GPT") continue;

      const candidates = baseRows.filter(r => norm(r.category) === norm(category))
        .filter(r => !exSet.has(norm(r.ingredient)));

      const pick = pickOneDeterministic(candidates, `${seedText}::${category}`);
      if (pick) {
        chosen.set(category, pick.ingredient);
        details.push({ category, picked: pick.ingredient, poolSize: candidates.length });
      } else {
        skipped.push({ category, reason: "No eligible candidates (after exclusions or missing category)" });
      }
    }

    return { chosen, diagnostics: { skipped, details, totalRows: baseRows.length } };
  }

  // expose to your app
  window.AutoChooser = { chooseForCategories };
})();
/* ===== FIX: Always place tables AFTER the ingredients/recipe/summary =====
   What this does:
   - Wraps BP.renderTables() without changing its behavior.
   - Before and after each render, it moves #bp-nutrition to sit immediately
     AFTER the most relevant "summary/recipe" container.
   - Retries briefly to catch late-rendered summaries (e.g., after OpenAI returns).
   - If no plausible summary container is found, it does nothing.

   How to remove (if ever needed):
   - Delete this entire block only (from this comment to the closing IIFE).
*/
(function () {
  // Choose the most likely “summary/recipe” container already on your page
  const SUMMARY_SELECTORS = [
    // Most specific → least specific; last visible match wins
    '.recipe-summary',
    '#recipe-summary',
    '.ingredients-summary',
    '.generated-recipe',
    '.generated-summary',
    '.recipes-output',
    '#recipes-output',
    '#output',
    '#results',
    '.results',
    'main'
  ];

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    // Treat elements with layout size or fixed position as visible
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function findSummaryAnchor() {
    const nodes = [];
    SUMMARY_SELECTORS.forEach(sel => {
      document.querySelectorAll(sel).forEach(n => { if (isVisible(n)) nodes.push(n); });
    });
    // Prefer the last visible candidate (most “recent” output area on the page)
    return nodes.length ? nodes[nodes.length - 1] : null;
  }

  function ensureTablesAfterSummary() {
    const mount = document.getElementById('bp-nutrition');
    if (!mount) return;

    const anchor = findSummaryAnchor();
    if (!anchor || !anchor.parentNode) return;

    // If #bp-nutrition is already immediately after the anchor, do nothing
    if (anchor.nextSibling === mount) return;

    // Move #bp-nutrition so it sits directly AFTER the summary anchor
    anchor.parentNode.insertBefore(mount, anchor.nextSibling);
  }

  // Wrap BP.renderTables (non-destructive)
  function wrapRenderTables() {
    if (!window.BP || typeof window.BP.renderTables !== 'function' || window._bpAfterSummaryPatched) return;

    const original = window.BP.renderTables;
    window.BP.renderTables = async function (...args) {
      // Try to place mount after any existing summary before rendering
      ensureTablesAfterSummary();
      const out = await original.apply(this, args);
      // Do it again immediately after render
      ensureTablesAfterSummary();
      // Retry briefly to catch late-rendered summaries (e.g., async recipe text)
      let tries = 0;
      const timer = setInterval(() => {
        ensureTablesAfterSummary();
        if (++tries >= 12) clearInterval(timer); // ~12*200ms = ~2.4s
      }, 200);
      return out;
    };
    window._bpAfterSummaryPatched = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wrapRenderTables);
  } else {
    wrapRenderTables();
  }
})();
/* ===== BP Phase A (CSS-only via injection): hide empty post-Generate box + stray Clear buttons ===== */
(function () {
  if (document.getElementById('bp-phase-a-style')) return; // prevent duplicate adds

  const css = `
    /* 1) Hide the blank box directly under the Generate Recipes button row, but ONLY if it's truly empty. */
    .btn-row + :empty { display: none !important; }
    .btn-row + .preview:empty,
    .btn-row + #preview:empty,
    .btn-row + .bp-preview-block:empty,
    .btn-row + .bp-placeholder:empty { display: none !important; }

    /* 2) Hide the Clear Form button that sits right below the custom-input box (common safe targets). */
    /* If your custom input area uses a textarea, hide a typical Clear control right after it. */
    textarea + button.clear-form,
    textarea + .bp-clear-wrap,
    textarea + .bp-btn-clear { display: none !important; }

    /* Also hide Clear buttons that advertise themselves via common attributes. */
    button[aria-label="Clear Form"],
    button[title="Clear Form"],
    input[type="button"][value="Clear Form"],
    input[type="submit"][value="Clear Form"] { display: none !important; }

    /* 3) Hide duplicate bottom Clear buttons that appear AFTER the tables mount (#bp-nutrition). */
    #bp-nutrition ~ #bp-clear-bottom-wrap,
    #bp-nutrition ~ .bp-clear-bottom-wrap,
    #bp-nutrition ~ .bp-bottom-clear { display: none !important; }

    /* (Harmless if absent) Hide older helper wrappers from previous experiments. */
    #bp-clear-top-wrap,
    #bp-clear-bottom-wrap { display: none !important; }

    /* Ensure remaining buttons are fully visible (undo any accidental low-opacity styles). */
    button,
    input[type="button"],
    input[type="submit"] {
      opacity: 1 !important;
      filter: none !important;
    }
  `;

  const st = document.createElement('style');
  st.id = 'bp-phase-a-style';
  st.textContent = css;
  document.head.appendChild(st);
})();
/* ===== BP Minimal Prune — keep only the first "Clear Form" inside the selector; hide the rest ===== */
(function () {
  function txt(el) {
    return (el ? (el.textContent || el.value || '') : '').trim().toLowerCase();
  }
  function findSelectionsButton() {
    // Look for the button wired to your ingredient selector submit
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find(b => (b.getAttribute('onclick') || '').toLowerCase().includes('generatefromselections')) || null;
  }
  function nearestSelectorContainer(anchor) {
    if (!anchor) return null;
    // Prefer the nearest <form>; otherwise walk up to a container with multiple inputs
    const form = anchor.closest('form');
    if (form) return form;
    let n = anchor.parentElement;
    while (n && n !== document.body) {
      if (['DIV','SECTION','ARTICLE','MAIN'].includes(n.tagName)) {
        const inputs = n.querySelectorAll('input,select,textarea').length;
        if (inputs >= 4) return n;
      }
      n = n.parentElement;
    }
    return null;
  }
  function pruneClearButtons() {
    const selBtn = findSelectionsButton();
    const selectorRoot = nearestSelectorContainer(selBtn);
    const all = Array.from(document.querySelectorAll('button, input[type="button"], a[role="button"]'));

    let keptInsideSelector = 0;

    all.forEach(el => {
      const label = txt(el);
      if (label === 'clear form') {
        const insideSelector = selectorRoot ? selectorRoot.contains(el) : false;
        if (insideSelector && keptInsideSelector === 0) {
          // Keep the very first "Clear Form" that lives inside the selector
          keptInsideSelector = 1;
        } else {
          // Hide any others (e.g., under custom input, extra bottom copies)
          el.style.display = 'none';
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pruneClearButtons);
  } else {
    pruneClearButtons();
  }
})();
/* ===== BP UI prune: hide only the "Clear Custom" button (safe, append-only) ===== */
(function () {
  function hideClearCustom() {
    // Look for typical clickable elements and hide ones whose visible label is exactly "Clear Custom"
    const els = Array.from(document.querySelectorAll(
      'button, input[type="button"], input[type="submit"], a[role="button"]'
    ));
    els.forEach(el => {
      const label = (el.textContent || el.value || '').trim().toLowerCase();
      if (label === 'clear custom') {
        el.style.display = 'none';   // non-destructive; can be undone by removing this snippet
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hideClearCustom);
  } else {
    hideClearCustom();
  }
})();
/* ===== BP Bottom Refresh Button — append-only; idempotent; no overrides ===== */
(function(){
  const BTN_ID = 'bp-hard-refresh';

  function tablesMount(){ return document.getElementById('bp-nutrition'); }

  function haveRecipeOrSummary() {
    return !!document.querySelector(
      '.generated-recipe, .recipe-summary, #recipe-summary, .recipes-output, #recipes-output'
    );
  }

  function ensureButton(){
    const mount = tablesMount();
    if (!mount || !mount.parentNode) return;

    let btn = document.getElementById(BTN_ID);
    if (!btn){
      btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      btn.textContent = 'Clear Form — Refresh Page';
      Object.assign(btn.style, {
        display: 'none',
        margin: '24px auto',
        background: '#2563eb',
        color: '#fff',
        border: '1px solid #1e40af',
        borderRadius: '12px',
        padding: '10px 16px',
        fontWeight: '700',
        cursor: 'pointer'
      });
      btn.addEventListener('click', () => {
        try { location.reload(); } catch (_) { window.location.href = window.location.href; }
      });
    }

    // Always keep it immediately AFTER #bp-nutrition (which your other code already moves under the summary)
    if (mount.nextSibling !== btn) {
      mount.parentNode.insertBefore(btn, mount.nextSibling);
    }

    // Show only when there are tables OR a recipe/summary present
    const show = (mount.children.length > 0) || haveRecipeOrSummary();
    btn.style.display = show ? 'block' : 'none';
  }

  function observe(){
    const mount = tablesMount();
    if (!mount) return;

    ensureButton();

    // Update visibility/placement when tables render or change
    const mo = new MutationObserver(ensureButton);
    mo.observe(mount, { childList: true });

    // Cover delayed recipe/summary rendering
    setTimeout(ensureButton, 400);
    setTimeout(ensureButton, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe);
  } else {
    observe();
  }
})();
/* ===== BP — Hide legacy Clear buttons (non-destructive, append-only) ===== */
(function () {
  const REFRESH_ID = 'bp-hard-refresh'; // your working refresh button

  const qall = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const label = (el) => (el ? (el.textContent || el.value || '').trim().toLowerCase() : '');

  function shouldHide(el) {
    if (!el) return false;
    if (el.id === REFRESH_ID) return false;                 // keep the working refresh button
    const txt = label(el);
    // Only target the two legacy variants you showed
    return txt === 'clear form' || txt === 'clear form (bottom)';
  }

  function hideLegacyClears() {
    // 1) Hide any “Clear Form (Bottom)” anywhere (legacy)
    qall('button, input[type="button"], a[role="button"]').forEach((el) => {
      if (shouldHide(el)) el.style.display = 'none';
    });

    // 2) Specifically remove the “Clear Form” next to “Generate Recipes from Selections”
    const gen = qall('button').find((b) =>
      (b.getAttribute('onclick') || '').toLowerCase().includes('generatefromselections')
    );
    if (gen) {
      const row = gen.closest('.btn-row') || gen.parentElement;
      if (row) {
        qall('button, input[type="button"], a[role="button"]', row).forEach((el) => {
          if (shouldHide(el)) el.style.display = 'none';
        });
      }
    }
  }

  function boot() {
    hideLegacyClears();
    // Re-apply if the UI re-renders (recipes/tables added)
    new MutationObserver(() => hideLegacyClears()).observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
