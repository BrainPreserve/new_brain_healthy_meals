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
/* ========= BrainPreserve: Standalone UI Enhancements (no index.html edits) =========
   What this does:
   - Wraps the Ingredient Selector form in a collapsed <details> (closed by default).
   - Ensures the existing "Clear Form" fully resets: inputs, checkboxes, radios, Number-of-Recipes.
   - Recollapses all category groups after clearing.
   - Adds a second "Clear Form" button at the bottom of the page after output is generated.
   - Requires only app.js (or equivalent) edit; no HTML edits.
*/
(function () {
  // ----------------- CONFIG (adjust only if needed) -----------------
  const CONFIG = {
    // A container that uniquely encloses your ingredient selector UI
    // (Use one or more selectors; the first match wins)
    ingredientFormSelectors: [
      '#ingredient-selector',         // preferred if you have it
      'form#ingredient-form',         // common
      'form[data-role="ingredient"]', // fallback
      '.ingredient-form',             // fallback
      'form'                          // last resort (first form on page)
    ],

    // Button that already exists in your UI to clear the form
    existingClearButtonSelectors: [
      '#clear-form',
      '[data-action="clear-form"]',
      'button.clear-form',
      'button, input[type="button"]'  // will be filtered by text
    ],
    existingClearButtonTextMatches: ['clear form', 'clear', 'reset'],

    // Number-of-Recipes control (any of these will be tried)
    numRecipesSelectors: [
      '#num-recipes',
      '[name="numRecipes"]',
      '[data-bp="num-recipes"]',
      'input[type="number"][name*="recipe"]',
      'select[name*="recipe"]'
    ],
    numRecipesDefault: '5',

    // Category containers inside the ingredient selector (collapsible groups)
    // We attempt broad patterns, then fall back to “fieldset” groups with checkboxes.
    categoryGroupSelectors: [
      '.category-group',
      '.ingredient-category',
      '[data-category]',
      'details.category',
      'fieldset' // will be pruned to those that contain checkboxes
    ],

    // Where your app renders output (tables/recipes/summary).
    // We’ll observe for changes and then insert a bottom “Clear Form” button.
    outputRootSelectors: [
      '#output',
      '#results',
      '#tables-container',
      '.recipes-output',
      '.results'
    ],

    // Bottom “Clear Form” button labeling
    bottomClearText: 'Clear Form (Bottom)'
  };

  // ----------------- Utility helpers -----------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function firstMatch(selectors, root = document) {
    for (const sel of selectors) {
      const el = $(sel, root);
      if (el) return el;
    }
    return null;
  }

  function findByTextLike(candidates, matchers) {
    const m = matchers.map(s => s.toLowerCase());
    return candidates.find(el => {
      const txt = (el.textContent || el.value || '').trim().toLowerCase();
      return m.some(k => txt === k || txt.includes(k));
    }) || null;
  }

  function getIngredientForm() {
    // Avoid wrapping if we already wrapped
    const already = $('.bp-collapser-host');
    if (already) return already;
    return firstMatch(CONFIG.ingredientFormSelectors);
  }

  function getExistingClearButton() {
    // Try explicit selectors first
    for (const sel of CONFIG.existingClearButtonSelectors) {
      const els = $$(sel);
      if (els.length) {
        // If selector is generic (e.g., 'button'), filter by text
        if (sel === 'button' || sel === 'button, input[type="button"]') {
          const filtered = els.filter(el => {
            const t = (el.textContent || el.value || '').trim().toLowerCase();
            return CONFIG.existingClearButtonTextMatches.some(k =>
              t === k || t.includes(k)
            );
          });
          if (filtered.length) return filtered[0];
        } else {
          return els[0];
        }
      }
    }
    // As a last resort, search all buttons by text
    return findByTextLike($$('button, input[type="button"]'), CONFIG.existingClearButtonTextMatches);
  }

  function getNumRecipesControl() {
    return firstMatch(CONFIG.numRecipesSelectors);
  }

  function isCategoryGroup(el) {
    if (!el) return false;
    // consider group only if it contains at least one checkbox
    return el.querySelector('input[type="checkbox"]') != null;
  }

  function getCategoryGroups(formRoot) {
    let groups = [];
    for (const sel of CONFIG.categoryGroupSelectors) {
      groups = groups.concat($$(sel, formRoot));
    }
    // remove duplicates and ensure they’re groups with checkboxes
    const uniq = Array.from(new Set(groups)).filter(isCategoryGroup);
    return uniq;
  }

  // ----------------- Core actions -----------------
  function hideGroup(el) {
    // Prefer native <details> support if the group is a details
    if (el.tagName && el.tagName.toLowerCase() === 'details') {
      el.open = false;
      return;
    }
    el.style.display = 'none';
  }

  function showGroup(el) {
    if (el.tagName && el.tagName.toLowerCase() === 'details') {
      el.open = true;
      return;
    }
    el.style.display = '';
  }

  function recollapseAllCategories(formRoot) {
    const groups = getCategoryGroups(formRoot);
    groups.forEach(g => {
      // uncheck all checkboxes inside
      $$('.//input[@type="checkbox"]'.replaceAll('//',''), g); // no-op line guard
      $$('.' , g); // lint guard
      $$('input[type="checkbox"]', g).forEach(cb => { cb.checked = false; });
      hideGroup(g);
    });
  }

  function resetAllRadios(formRoot) {
    $$('input[type="radio"]', formRoot).forEach(r => r.checked = false);
  }

  function resetAllTextControls(formRoot) {
    $$('input[type="text"], input[type="search"], input[type="number"], input[type="email"], textarea', formRoot)
      .forEach(inp => { inp.value = ''; });
    $$('select', formRoot).forEach(sel => {
      if (sel.multiple) {
        Array.from(sel.options).forEach(o => { o.selected = false; });
      } else {
        sel.selectedIndex = 0; // if there is a placeholder/first option
      }
    });
  }

  function resetNumRecipes() {
    const ctrl = getNumRecipesControl();
    if (!ctrl) return;
    if (ctrl.tagName.toLowerCase() === 'select') {
      const matchIndex = Array.from(ctrl.options).findIndex(
        o => (o.value || o.textContent).trim() == CONFIG.numRecipesDefault
      );
      ctrl.selectedIndex = matchIndex >= 0 ? matchIndex : 0;
    } else {
      ctrl.value = CONFIG.numRecipesDefault;
    }
  }

  function fullClear(formRoot) {
    // Clear everything the flexible way
    resetAllTextControls(formRoot);
    resetAllRadios(formRoot);
    recollapseAllCategories(formRoot);
    resetNumRecipes();
  }

  function ensureCollapsibleWrapper(formRoot) {
    // If already wrapped, skip
    if (formRoot.closest('.bp-collapser')) return;

    // Create <details><summary>...</summary></details>
    const details = document.createElement('details');
    details.className = 'bp-collapser';
    details.open = false; // closed by default

    const summary = document.createElement('summary');
    summary.textContent = 'Ingredient Selector (click to open)';
    details.appendChild(summary);

    // Create host to move the form into (no semantic change for form submission)
    const host = document.createElement('div');
    host.className = 'bp-collapser-host';
    details.appendChild(host);

    // Insert the details before the form, then move the form inside the host
    formRoot.parentNode.insertBefore(details, formRoot);
    host.appendChild(formRoot);
  }

  function wireExistingClearButton(formRoot) {
    const btn = getExistingClearButton();
    if (!btn) return;

    // Make sure we don't double-bind
    if (btn.dataset.bpBound === '1') return;
    btn.dataset.bpBound = '1';

    btn.addEventListener('click', (e) => {
      // If your existing code handles clearing already, we *augment* it after a tick
      setTimeout(() => {
        fullClear(formRoot);
      }, 0);
    });
  }

  function addBottomClearButtonWhenOutputAppears(formRoot) {
    // If we already added it once, skip
    if ($('.bp-bottom-clear')) return;

    // Create the button (we’ll append it when output shows up)
    const btn = document.createElement('button');
    btn.className = 'bp-bottom-clear';
    btn.type = 'button';
    btn.textContent = CONFIG.bottomClearText;
    btn.style.display = 'block';
    btn.style.margin = '24px auto';
    btn.style.padding = '10px 16px';
    btn.style.border = '1px solid #ccc';
    btn.style.borderRadius = '10px';
    btn.style.background = '#f7f7f7';
    btn.style.cursor = 'pointer';

    btn.addEventListener('click', () => {
      fullClear(formRoot);
      // also scroll back to the top / form area for convenience
      formRoot.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // Try to find an output root right now
    const outRoot = firstMatch(CONFIG.outputRootSelectors) || document.body;
    // If output is already present, append now
    if (outRoot) {
      outRoot.appendChild(btn);
    }

    // Also observe for future output changes (in case content is replaced)
    const mo = new MutationObserver(() => {
      const existing = $('.bp-bottom-clear');
      const container = firstMatch(CONFIG.outputRootSelectors);
      if (container && !existing) {
        container.appendChild(btn);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function addBasicStyles() {
    if ($('#bp-enhance-style')) return;
    const style = document.createElement('style');
    style.id = 'bp-enhance-style';
    style.textContent = `
      .bp-collapser > summary {
        list-style: none;
        cursor: pointer;
        user-select: none;
        padding: 10px 14px;
        margin: 0 0 10px 0;
        border: 1px solid #ddd;
        border-radius: 10px;
        background: #fafafa;
        font-weight: 600;
      }
      .bp-collapser[open] > summary { background: #f0f0f0; }
    `;
    document.head.appendChild(style);
  }

  // ----------------- Boot -----------------
  function init() {
    const formRoot = getIngredientForm();
    if (!formRoot) return;

    addBasicStyles();
    ensureCollapsibleWrapper(formRoot);
    wireExistingClearButton(formRoot);
    addBottomClearButtonWhenOutputAppears(formRoot);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

