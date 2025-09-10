/* BrainPreserve tables module — mojibake fix edition
   Focus: aggressively fix encoding artifacts (e.g., Ã¢ÂÂ) coming from CSV exports.
   - Pre-fix CSV text before PapaParse reads it (beforeFirstChunk)
   - Sanitize again on display (cleanDisplay)
   - Leaves your rendering behavior otherwise unchanged

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

  // --- Robust mojibake fixer ---
  // If text contains typical mojibake markers (Ã, Â, â, etc.), reinterpret
  // its 0–255 char codes as bytes and decode as UTF-8. Then apply targeted replacements.
  function maybeRecodeUTF8(s) {
    const suspect = /[ÃÂâ€¢]|â|Ã¢Â|Ãƒ|ï¿½/.test(s); // includes replacement char pattern and common combos
    if (!suspect) return s;

    try {
      // Re-interpret current string's code points as Latin-1 bytes, then decode as UTF-8
      const bytes = Uint8Array.from([...s].map(ch => ch.charCodeAt(0) & 0xFF));
      const decoded = new TextDecoder('utf-8').decode(bytes);

      // Choose the version with fewer mojibake markers
      const score = (t) => (t.match(/[ÃÂâ€¢]|â|Ã¢Â|Ãƒ|ï¿½/g) || []).length;
      if (score(decoded) <= score(s)) s = decoded;
    } catch (_) {
      // ignore and keep original
    }

    // Also strip UTF-8 BOM if present
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);

    return s;
  }

  // REPLACE your existing cleanDisplay with this version
function cleanDisplay(val) {
  let s = String(val ?? '');

  // Normalize basic whitespace
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(/\u00A0/g, ' '); // NBSP → space

  // Try a robust re-decode if the string looks garbled
  s = (function maybeRecodeUTF8(x) {
    const suspect = /[ÃÂâ€¢]|â|Ã¢Â|Ãƒ|ï¿½/.test(x);
    if (!suspect) return x;
    try {
      const bytes = Uint8Array.from([...x].map(ch => ch.charCodeAt(0) & 0xFF));
      const decoded = new TextDecoder('utf-8').decode(bytes);
      const score = t => (t.match(/[ÃÂâ€¢]|â|Ã¢Â|Ãƒ|ï¿½/g) || []).length;
      if (score(decoded) <= score(x)) x = decoded;
    } catch (_) {}
    if (x.charCodeAt(0) === 0xFEFF) x = x.slice(1); // strip BOM
    return x;
  })(s);

  // ---- Hard fixes for known mojibake sequences ----
  const map = {
    // SINGLE QUOTES (’ ‘) — includes your exact issue "Ã¢ÂÂ"
    'Ã¢ÂÂ': '’', 'Ã¢Â€Â™': '’', 'â€™': '’', 'â': '’',
    'Ã¢ÂÂ˜': '‘', 'Ã¢Â€Â˜': '‘', 'â€˜': '‘', 'â˜': '‘',
    // DOUBLE QUOTES (“ ”)
    'Ã¢ÂÂœ': '“', 'Ã¢Â€Âœ': '“', 'â€œ': '“', 'â': '“',
    'Ã¢ÂÂ�': '”', 'Ã¢Â€Â�': '”', 'â€': '”', 'â': '”',
    // DASHES (– —)
    'Ã¢ÂÂ“': '–', 'Ã¢Â€Â“': '–', 'â€“': '–', 'â': '–',
    'Ã¢ÂÂ”': '—', 'Ã¢Â€Â”': '—', 'â€”': '—', 'â': '—',
    // ELLIPSIS (…)
    'Ã¢ÂÂ¦': '…', 'Ã¢Â€Â¦': '…', 'â€¦': '…', 'â¦': '…',
    // Stray “Â”/“Ã‚”
    'Â': '', 'Ã‚': ''
  };
  for (const [bad, good] of Object.entries(map)) {
    if (s.includes(bad)) s = s.split(bad).join(good);
  }

  // ---- Explicitly remove the Unicode replacement char (� = U+FFFD) ----
  // Handle combos like "�–" or "–�" first, then drop any remaining � safely.
  s = s.replace(/\uFFFD\s*–/g, '–');  // �– → –
  s = s.replace(/–\s*\uFFFD/g, '–');  // –� → –
  s = s.replace(/\uFFFD\s*-\s*/g, '-'); // �- → -
  s = s.replace(/-\s*\uFFFD/g, '-');    // -� → -
  s = s.replace(/\uFFFD+/g, '');        // remove any leftover �

  // Collapse extra spaces created by replacements
  s = s.replace(/[ \t]{2,}/g, ' ');

  return s.trim();
}


    // Collapse excessive spaces created by replacements
    s = s.replace(/[ \t]{2,}/g, ' ');

    return s.trim();
  }

  // Remove lines that are effectively blank (e.g., ",,,,,,,")
  function dropEmptyRows(rows) {
    return (rows || []).filter(row =>
      Object.values(row).some(v => String(v ?? '').trim() !== '')
    );
  }

  // Hide phantom headers: _1, Unnamed: 1, Column3, or columns empty for every row
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

  // --- CSV loader with pre-parse mojibake repair ---
  function csv(path) {
    return new Promise((resolve, reject) => {
      Papa.parse(path, {
        download: true,
        header: true,
        dynamicTyping: false,
        skipEmptyLines: true,
        beforeFirstChunk: function (chunk) {
          // Strip BOM and try re-decode if garbled, then normalize line endings
          let fixed = chunk;
          if (fixed && fixed.charCodeAt(0) === 0xFEFF) fixed = fixed.slice(1);
          fixed = maybeRecodeUTF8(fixed);
          fixed = fixed.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          return fixed;
        },
        complete: (res) => {
          const rows = dropEmptyRows(res.data || []);
          // Clean all string fields once up-front (light pass)
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

    // If no valid ingredients, render nothing (no full-table dump)
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
