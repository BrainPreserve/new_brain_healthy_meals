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
    // In normal app use (ingredients are passed), filtering still applies.
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
/* ========= BrainPreserve UI Enhancer (Standalone) v1.1 =========
   - Collapsible Ingredient Selector (closed by default)
   - Patch existing "Clear Form" to fully reset + recollapse + reset #num-recipes-form
   - Add bottom "Clear Form" after output renders
   - Works even if UI renders late (waits & observes)
*/
(() => {
  const DEBUG = true; // set to false to silence logs later
  const log = (...a) => DEBUG && console.log('[BP-Enhancer]', ...a);

  // ---- CONFIG: adjust only if still not detected ----
  const CFG = {
    ingredientFormCandidates: [
      '#ingredient-selector',
      'form#ingredient-form',
      'form[data-role="ingredient"]',
      '.ingredient-form',
      'form' // fallback: first form on page
    ],
    clearButtonCandidates: [
      '#clear-form',
      '[data-action="clear-form"]',
      'button.clear-form',
      'button', 'input[type="button"]' // will filter by text
    ],
    clearButtonTextLike: ['clear form', 'clear', 'reset'],
    numberOfRecipesCandidates: [
      '#num-recipes-form',           // ← your current auto-injected field
      '#num-recipes',
      '[name="numRecipes"]',
      '[data-bp="num-recipes"]',
      'input[type="number"][name*="recipe"]',
      'select[name*="recipe"]'
    ],
    numDefault: '5',
    outputRootCandidates: [
      '#output',
      '#results',
      '#tables-container',
      '.recipes-output',
      '.results',
      'main', // loose fallback
      'body'  // ultimate fallback
    ],
    // A “category group” is any container with checkboxes inside (used for recollapse)
    categoryGroupCandidates: [
      '.category-group',
      '.ingredient-category',
      '[data-category]',
      'details.category',
      'fieldset',
      'div' // will be filtered by presence of checkboxes
    ],
    bottomClearText: 'Clear Form (Bottom)'
  };

  // ---- small helpers ----
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const first = (sels, r = document) => sels.map(sel => $(sel, r)).find(Boolean) || null;
  const byTextLike = (els, needles) => {
    const needle = (t) => (t||'').trim().toLowerCase();
    const keys = needles.map(needle);
    return els.find(el => {
      const t = needle(el.textContent || el.value);
      return keys.some(k => t === k || t.includes(k));
    }) || null;
  };
  const isGroup = (el) => !!el && el.querySelector && el.querySelector('input[type="checkbox"]');

  // ---- core queries ----
  function findIngredientForm() {
    // Don’t wrap twice
    const already = $('.bp-collapser-host');
    if (already) return already;
    return first(CFG.ingredientFormCandidates);
  }
  function findClearButton() {
    // try explicit selectors
    for (const sel of CFG.clearButtonCandidates) {
      const list = $$(sel);
      if (sel === 'button' || sel === 'input[type="button"]') {
        const hit = byTextLike(list, CFG.clearButtonTextLike);
        if (hit) return hit;
      } else if (list.length) {
        return list[0];
      }
    }
    // fallback: scan all buttons
    return byTextLike($$('button, input[type="button"]'), CFG.clearButtonTextLike);
  }
  function findNumRecipes() {
    return first(CFG.numberOfRecipesCandidates);
  }
  function findOutputRoot() {
    return first(CFG.outputRootCandidates) || document.body;
  }
  function getCategoryGroups(root) {
    const raw = CFG.categoryGroupCandidates.flatMap(sel => $$(sel, root));
    const uniq = Array.from(new Set(raw)).filter(isGroup);
    return uniq;
  }

  // ---- actions ----
  function collapseGroup(el) {
    if (!el) return;
    if (el.tagName && el.tagName.toLowerCase() === 'details') { el.open = false; return; }
    el.style.display = 'none';
  }
  function recollapseAll(root) {
    getCategoryGroups(root).forEach(g => {
      // uncheck
      $$('input[type="checkbox"]', g).forEach(cb => cb.checked = false);
      collapseGroup(g);
    });
  }
  function resetRadios(root) { $$('input[type="radio"]', root).forEach(r => r.checked = false); }
  function resetTextish(root) {
    $$('input[type="text"], input[type="search"], input[type="email"], input[type="number"], textarea', root)
      .forEach(i => i.value = '');
    $$('select', root).forEach(sel => { if (sel.multiple) Array.from(sel.options).forEach(o => o.selected=false); else sel.selectedIndex = 0; });
  }
  function resetNum() {
    const el = findNumRecipes();
    if (!el) return;
    if (el.tagName.toLowerCase() === 'select') {
      const i = Array.from(el.options).findIndex(o => (o.value || o.textContent).trim() == CFG.numDefault);
      el.selectedIndex = i >= 0 ? i : 0;
    } else {
      el.value = CFG.numDefault;
    }
  }
  function fullClear(root) {
    resetTextish(root);
    resetRadios(root);
    recollapseAll(root);
    resetNum();
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

    if (!$('#bp-enhancer-style')) {
      const st = document.createElement('style');
      st.id = 'bp-enhancer-style';
      st.textContent = `
        .bp-collapser > summary {
          list-style: none; cursor: pointer; user-select: none;
          padding: 10px 14px; margin: 0 0 10px 0;
          border: 1px solid #ddd; border-radius: 10px; background: #fafafa; font-weight: 600;
        }
        .bp-collapser[open] > summary { background: #f0f0f0; }
      `;
      document.head.appendChild(st);
    }
  }

  function wireClearButton(root) {
    const btn = findClearButton();
    if (!btn) { log('No existing Clear Form button found'); return; }
    if (btn.dataset.bpBound === '1') return;
    btn.dataset.bpBound = '1';
    btn.addEventListener('click', () => {
      // If your app has its own clear handler, let it run first, then augment
      setTimeout(() => {
        log('Augmenting existing Clear: full reset');
        fullClear(root);
      }, 0);
    });
    log('Existing Clear Form button wired');
  }

  function installBottomClear(root) {
    const out = findOutputRoot();
    if (!out || $('.bp-bottom-clear', out)) return;
    const b = document.createElement('button');
    b.className = 'bp-bottom-clear';
    b.type = 'button';
    b.textContent = CFG.bottomClearText;
    Object.assign(b.style, {
      display: 'block', margin: '24px auto', padding: '10px 16px',
      border: '1px solid #ccc', borderRadius: '10px',
      background: '#f7f7f7', cursor: 'pointer'
    });
    b.addEventListener('click', () => {
      fullClear(root);
      // scroll to top of selector
      root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    out.appendChild(b);
    log('Bottom Clear button installed');
  }

  // Observe the page so if output re-renders, we ensure the bottom clear exists.
  let outputObserverStarted = false;
  function observeOutputForBottomClear(root) {
    if (outputObserverStarted) return;
    outputObserverStarted = true;
    const mo = new MutationObserver(() => {
      installBottomClear(root);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // Boot sequence that keeps trying until it succeeds
  let tries = 0;
  function tryInit() {
    tries++;
    const form = findIngredientForm();
    if (!form) {
      if (tries <= 40) return setTimeout(tryInit, 250); // wait up to ~10s
      log('Gave up: Ingredient form not found');
      return;
    }
    log('Ingredient form detected:', form);

    ensureCollapsible(form);
    wireClearButton(form);
    installBottomClear(form);
    observeOutputForBottomClear(form);

    // expose a version flag for you to check quickly
    window._bpEnhancerVersion = '1.1';
    log('Enhancer initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInit);
  } else {
    tryInit();
  }
})();
