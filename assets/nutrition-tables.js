/* BrainPreserve tables module — single drop-in file
   - Loads: /data/master.csv + 4 table CSVs
   - Filters tables to ONLY supplied/detected ingredients (case-insensitive; alias-aware)
   - If no ingredients are supplied, shows a small note (does NOT dump all rows)
   - Cleans mojibake artifacts on display (Â, â€“, smart quotes, NBSP)
   - Drops blank CSV rows (commas-only) and hides always-empty/phantom columns

   Requirements in index.html:
     <script src="https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js"></script>
     <script src="/assets/nutrition-tables.js"></script>
     <div id="bp-nutrition"></div>
*/
(function () {
  // =========================
  // CONFIG
  // =========================
  const CFG = {
    paths: {
      master: '/data/master.csv',
      nutrition: '/data/table_nutrition.csv',
      cognitive: '/data/table_cognitive_benefits.csv',
      diet:      '/data/table_diet_compatibility.csv',
      micro:     '/data/table_microbiome.csv'
    },
    keyColumns:   ['ingredient_name', 'ingredient', 'food', 'item', 'name'],
    aliasColumns: ['aliases', 'alias', 'also_known_as'],
    renderWhenNoIngredients: false  // <- do NOT show all rows if none provided
  };

  // =========================
  // DATA CONTAINERS
  // =========================
  const DATA = {
    loaded: false,
    master: [],
    masterIndex: new Map(),  // normName -> CanonicalName (as written in CSV)
    aliasToCanon: new Map(), // normAlias -> CanonicalName
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

  function csv(path) {
    return new Promise((resolve, reject) => {
      Papa.parse(path, {
        download: true,
        header: true,
        dynamicTyping: false,
        skipEmptyLines: true,
        complete: (res) => resolve(res.data || []),
        error: reject
      });
    });
  }

  // Remove rows that are effectively empty: every cell blank after trim
  function dropEmptyRows(rows) {
    return (rows || []).filter(row =>
      Object.values(row).some(v => String(v ?? '').trim() !== '')
    );
  }

  // Clean mojibake & typography glitches for display
  function cleanDisplay(val) {
    return String(val ?? '')
      .replace(/\u00A0/g, ' ')          // NBSP → space
      .replace(/Ã‚Â/g, '')              // stray Â
      // en-dash / em-dash common mojibake → proper
      .replace(/ÂÂ|â€“|Ã¢â‚¬â€œ/g, '–')
      .replace(/ÂÂ|â€”|Ã¢â‚¬”/g, '—')
      // ellipsis
      .replace(/ÂÂ¦|â€¦|Ã¢â‚¬Â¦/g, '…')
      // smart quotes → straight
      .replace(/â€œ|â€|Ã¢â‚¬Å“|Ã¢â‚¬Â/g, '"')
      .replace(/â€˜|â€™|Ã¢â‚¬Ëœ|Ã¢â‚¬â„¢/g, "'")
      .trim();
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

  function isHeaderNameOk(name) {
    if (!name) return false;
    const t = String(name).trim();
    if (!t) return false;
    const l = t.toLowerCase();
    if (l === '_' || /^_+\d*$/.test(l)) return false;        // _ or __ or _1
    if (/^unnamed/i.test(t)) return false;                   // Unnamed: 1
    if (/^column\d+$/i.test(t)) return false;                // column1, column2
    return true;
  }

  function chooseHeaders(rows) {
    if (!rows || rows.length === 0) return [];
    // Union of keys across all rows (some CSVs vary per row)
    const all = new Set();
    for (const r of rows) {
      Object.keys(r).forEach(k => all.add(k));
    }
    // Drop bad/phantom headers
    let headers = Array.from(all).filter(isHeaderNameOk);
    // Drop headers that are empty for ALL rows
    headers = headers.filter(h => rows.some(r => String(r[h] ?? '').trim() !== ''));
    return headers;
  }

  function buildMasterIndexes() {
    DATA.masterIndex.clear();
    DATA.aliasToCanon.clear();

    for (const row of DATA.master) {
      const rawName = getKeyValue(row);
      if (!rawName) continue;
      const canonName = String(rawName).trim(); // preserve original case for display
      const normName = norm(rawName);

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
    // If we are not supposed to render when empty, return [] immediately
    if (!ingredientSet || ingredientSet.size === 0) return [];
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
  // LOADING & RENDERING
  // =========================
  async function loadAll() {
    if (DATA.loaded) return;

    // Master first (aliases)
    DATA.master = dropEmptyRows(await csv(CFG.paths.master));
    buildMasterIndexes();

    // The four per-table CSVs
    DATA.tables.nutrition = dropEmptyRows(await csv(CFG.paths.nutrition));
    DATA.tables.cognitive = dropEmptyRows(await csv(CFG.paths.cognitive));
    DATA.tables.diet      = dropEmptyRows(await csv(CFG.paths.diet));
    DATA.tables.micro     = dropEmptyRows(await csv(CFG.paths.micro));

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

    // Clear mount
    mount.innerHTML = '';

    // Canonicalize supplied ingredients (from recipe or selections)
    const canonList = canonicalizeList(ingredientList);
    const ingredientSet = new Set(canonList);

    // If we require ingredients but none are present, show a small note and stop
    if (!CFG.renderWhenNoIngredients && ingredientSet.size === 0) {
      const note = document.createElement('div');
      note.className = 'status';
      note.textContent = 'Tables will appear after ingredients are detected or selected.';
      mount.appendChild(note);
      return;
    }

    // Filter each table
    const t1 = filterByIngredients(DATA.tables.nutrition, ingredientSet);
    const t2 = filterByIngredients(DATA.tables.cognitive, ingredientSet);
    const t3 = filterByIngredients(DATA.tables.diet,      ingredientSet);
    const t4 = filterByIngredients(DATA.tables.micro,     ingredientSet);

    // Optional: status line listing detected ingredients
    if (ingredientSet.size > 0) {
      const status = document.createElement('div');
      status.className = 'status';
      status.textContent = `Showing tables for: ${Array.from(ingredientSet).join(', ')}`;
      mount.appendChild(status);
    }

    // Render only if there are matches; otherwise show a gentle message
    const any =
      (t1 && t1.length) ||
      (t2 && t2.length) ||
      (t3 && t3.length) ||
      (t4 && t4.length);

    if (!any) {
      const p = document.createElement('div');
      p.className = 'status';
      p.textContent = 'No matching rows were found for the selected ingredients.';
      mount.appendChild(p);
      return;
    }

    mount.appendChild(createTable('Nutrition',                     t1));
    mount.appendChild(createTable('Cognitive Benefits',            t2));
    mount.appendChild(createTable('Diet Compatibility',            t3));
    mount.appendChild(createTable('Gut Health / Microbiome Support', t4));
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

  // Stronger phrase-based detector (used by your page if it calls this)
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

  // Preload data shortly after page load so lookups are ready
  if (document && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', () => {
      loadAll().catch(() => {});
    });
  }
})();
