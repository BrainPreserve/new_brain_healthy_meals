/* BrainPreserve tables module — strict render-on-ingredients only
   Behavior:
   - Renders tables ONLY when called with >=1 ingredient.
   - Filters to ONLY those ingredients (case-insensitive; alias-aware via master.csv).
   - If called with no/empty/unknown ingredients → renders nothing (no full-table dump, no note).
   - Cleans mojibake (Â, Ã‚, â€“/—/…/smart quotes, including "Ã¢ÂÂ").
   - Drops blank CSV rows (commas-only) and hides always-empty/phantom columns.

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
      master:   '/data/master.csv',
      nutrition:'/data/table_nutrition.csv',
      cognitive:'/data/table_cognitive_benefits.csv',
      diet:     '/data/table_diet_compatibility.csv',
      micro:    '/data/table_microbiome.csv'
    },
    keyColumns:   ['ingredient_name', 'ingredient', 'food', 'item', 'name'],
    aliasColumns: ['aliases', 'alias', 'also_known_as']
  };

  // =========================
  // DATA
  // =========================
  const DATA = {
    loaded: false,
    master: [],
    masterIndex: new Map(),   // normName -> CanonicalName (preserve CSV casing for display)
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

  function csv(path) {
    return new Promise((resolve, reject) => {
      Papa.parse(path, {
        download: true,
        header: true,
        dynamicTyping: false,
        skipEmptyLines: true,
        complete: res => resolve(res.data || []),
        error: reject
      });
    });
  }

  // Remove lines that are effectively blank (e.g., ",,,,,,,")
  function dropEmptyRows(rows) {
    return (rows || []).filter(row =>
      Object.values(row).some(v => String(v ?? '').trim() !== '')
    );
  }

  // Clean mojibake & typography glitches for display
  // REPLACE your existing cleanDisplay with this version
function cleanDisplay(val) {
  let s = String(val ?? '');

  // Normalize line breaks and spaces
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(/\u00A0/g, ' '); // NBSP → space

  // Quick removals of common stray chars that appear with mojibake
  s = s.replace(/Â/g, '');   // stray Â
  s = s.replace(/Ã‚/g, '');  // stray Ã‚

  // Targeted mojibake fixes (UTF-8 seen as Latin-1 -> rendered as odd sequences)
  // Covers your specific issue "Ã¢ÂÂ" plus related punctuation families.
  const map = {
    // SINGLE QUOTES (’ ‘)
    'Ã¢ÂÂ': '’', 'Ã¢Â€Â™': '’', 'â€™': '’', 'â': '’',
    'Ã¢ÂÂ˜': '‘', 'Ã¢Â€Â˜': '‘', 'â€˜': '‘', 'â˜': '‘',

    // DOUBLE QUOTES (“ ”)
    'Ã¢ÂÂœ': '“', 'Ã¢Â€Âœ': '“', 'â€œ': '“',
    'Ã¢ÂÂ�': '”', 'Ã¢Â€Â�': '”', 'â€': '”', 'â': '”',

    // DASHES (– —)
    'Ã¢ÂÂ“': '–', 'Ã¢Â€Â“': '–', 'â€“': '–', 'â': '–',
    'Ã¢ÂÂ”': '—', 'Ã¢Â€Â”': '—', 'â€”': '—', 'â': '—',

    // ELLIPSIS (…)
    'Ã¢ÂÂ¦': '…', 'Ã¢Â€Â¦': '…', 'â€¦': '…', 'â¦': '…',

    // Directional / formatting marks sometimes leaking into CSVs
    'Ã¢Â€Âª': '', 'Ã¢Â€Â«': '', 'Ã¢Â€Â¬': '',
    'â€ª': '',   'â€«': '',   'â€¬': ''
  };

  for (const [bad, good] of Object.entries(map)) {
    if (s.includes(bad)) s = s.split(bad).join(good);
  }

  // Collapse repeated spaces that can result from replacements
  s = s.replace(/[ \t]{2,}/g, ' ');

  return s.trim();
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
    return String(val)
      .split(/[;,]/g)
      .map(x => norm(x))
      .filter(Boolean);
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
    for (const r of rows) Object.keys(r).forEach(k => all.add(k));
    // Drop bad/phantom headers and those empty for ALL rows
    let headers = Array.from(all).filter(isHeaderNameOk);
    headers = headers.filter(h => rows.some(r => String(r[h] ?? '').trim() !== ''));
    return headers;
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
  // LOAD & RENDER
  // =========================
  async function loadAll() {
    if (DATA.loaded) return;

    // Load master first (aliases)
    DATA.master = dropEmptyRows(await csv(CFG.paths.master));
    buildMasterIndexes();

    // Load the four tables
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

    // Clear existing
    mount.innerHTML = '';

    // Canonicalize supplied ingredients (from recipe or selections)
    const canonList = canonicalizeList(ingredientList);
    const ingredientSet = new Set(canonList);

    // STRICT GATE: if no valid ingredients, render nothing
    if (ingredientSet.size === 0) return;

    // Filter each table
    const t1 = filterByIngredients(DATA.tables.nutrition, ingredientSet);
    const t2 = filterByIngredients(DATA.tables.cognitive, ingredientSet);
    const t3 = filterByIngredients(DATA.tables.diet,      ingredientSet);
    const t4 = filterByIngredients(DATA.tables.micro,     ingredientSet);

    // If literally nothing matched, do nothing
    const any =
      (t1 && t1.length) ||
      (t2 && t2.length) ||
      (t3 && t3.length) ||
      (t4 && t4.length);

    if (!any) return;

    // Render only the matched data
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

  // Phrase-based detector for your page (optional use by your app)
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

  // Preload data so it's ready when you call renderTables(…)
  if (document && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', () => {
      loadAll().catch(() => {});
    });
  }
})();
