/* BrainPreserve drop-in tables module (alias-aware, case-insensitive)
   Expects PapaParse on the page.
   index.html must include: <script src="https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js"></script>
   and then: <script src="/assets/nutrition-tables.js"></script>

   Your page should contain <div id="bp-nutrition"></div>.
   The host page calls window.BP.renderTables(ingredientsArray) after recipe generation or selection build.
   Optional: window.BP.deriveIngredientsFromRecipe(text) returns an array of matched ingredient names.
*/

(function () {
  const DATA = {
    loaded: false,
    master: [],                        // rows from master.csv
    masterIndex: new Map(),            // normName -> canonicalName
    aliasToCanon: new Map(),           // aliasNorm -> canonicalName
    tables: {
      nutrition: [],
      cognitive: [],
      diet: [],
      micro: []
    }
  };

  const CFG = {
    paths: {
      master: '/data/master.csv',
      nutrition: '/data/table_nutrition.csv',
      cognitive: '/data/table_cognitive_benefits.csv',
      diet: '/data/table_diet_compatibility.csv',
      micro: '/data/table_microbiome.csv'
    },
    // How we interpret key columns:
    keyColumns: ['ingredient_name', 'ingredient', 'food', 'item', 'name'],
    aliasColumns: ['aliases', 'alias', 'also_known_as']
  };

  // ---------- helpers ----------
  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[^\p{Letter}\p{Number}\s\-\/&']/gu, '') // keep letters, numbers, spaces, some joiners
      .replace(/\s+/g, ' ')
      .trim();
  }

  function splitAliases(val) {
    if (val == null || val === '') return [];
    // support both comma and semicolon
    return String(val)
      .split(/[;,]/g)
      .map(x => norm(x))
      .filter(Boolean);
  }

  function pick(obj, candidates) {
    for (const k of candidates) {
      const hit = Object.keys(obj).find(h => h.toLowerCase() === k.toLowerCase());
      if (hit) return { key: hit, value: obj[hit] };
    }
    return undefined;
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

  function getKeyValue(row) {
    const p = pick(row, CFG.keyColumns);
    return p ? String(p.value) : '';
  }

  function buildMasterIndexes() {
    DATA.masterIndex.clear();
    DATA.aliasToCanon.clear();

    for (const row of DATA.master) {
      const rawName = getKeyValue(row);
      if (!rawName) continue;
      const canonName = rawName.trim(); // preserve original casing for display
      const normName = norm(rawName);

      // primary name
      if (!DATA.masterIndex.has(normName)) {
        DATA.masterIndex.set(normName, canonName);
      }

      // aliases
      const aliasField = pick(row, CFG.aliasColumns);
      if (aliasField && aliasField.value) {
        for (const a of splitAliases(aliasField.value)) {
          if (!a) continue;
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

    // conservative partial fallback: look for exact word match in master keys
    // (e.g., "salad" might match "salad greens" if no exact)
    for (const k of DATA.masterIndex.keys()) {
      if (k === n) return DATA.masterIndex.get(k);
    }
    return undefined;
  }

  function ensureArray(a) {
    return Array.isArray(a) ? a : (a ? [a] : []);
  }

  function chooseHeaders(rows) {
    if (!rows || !rows.length) return [];
    // Keep original column order from the first row
    return Object.keys(rows[0]);
  }

  function createTable(title, rows) {
    const box = document.createElement('div');
    box.className = 'card';
    const h = document.createElement('h3');
    h.textContent = title;
    box.appendChild(h);

    if (!rows || !rows.length) {
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
      th.textContent = col;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach(row => {
      const tr = document.createElement('tr');
      headers.forEach(col => {
        const td = document.createElement('td');
        // preserve raw value; do not coerce
        td.textContent = row[col] != null && row[col] !== '' ? String(row[col]) : '—';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);
    return box;
  }

  function filterByIngredients(tableRows, ingredientSet) {
    if (!ingredientSet || ingredientSet.size === 0) return tableRows; // show all if none supplied

    const out = [];
    for (const row of tableRows) {
      const keyVal = getKeyValue(row);
      if (!keyVal) continue;
      const canon = lookupCanonical(keyVal) || keyVal.trim();
      if (ingredientSet.has(canon)) out.push(row);
    }
    return out;
  }

  async function loadAll() {
    if (DATA.loaded) return;

    // 1) master
    DATA.master = await csv(CFG.paths.master);
    buildMasterIndexes();

    // 2) per-table files
    DATA.tables.nutrition = await csv(CFG.paths.nutrition);
    DATA.tables.cognitive = await csv(CFG.paths.cognitive);
    DATA.tables.diet      = await csv(CFG.paths.diet);
    DATA.tables.micro     = await csv(CFG.paths.micro);

    DATA.loaded = true;
  }

  function renderAllTables(ingredientList) {
    const mount = document.getElementById('bp-nutrition');
    if (!mount) return;

    // Clear
    mount.innerHTML = '';

    // Normalize and map to canonical names
    const canonList = [];
    ensureArray(ingredientList).forEach(name => {
      const c = lookupCanonical(name) || name;
      if (c) canonList.push(c);
    });
    const ingredientSet = new Set(canonList);

    // Status header
    const status = document.createElement('div');
    status.className = 'status';
    if (ingredientSet.size > 0) {
      status.textContent = `Rendering tables for: ${Array.from(ingredientSet).join(', ')}`;
    } else {
      status.textContent = `No specific ingredients supplied — showing all rows.`;
    }
    mount.appendChild(status);

    // Render each table (filtered if ingredients were supplied)
    const t1 = filterByIngredients(DATA.tables.nutrition, ingredientSet);
    const t2 = filterByIngredients(DATA.tables.cognitive, ingredientSet);
    const t3 = filterByIngredients(DATA.tables.diet,      ingredientSet);
    const t4 = filterByIngredients(DATA.tables.micro,     ingredientSet);

    mount.appendChild(createTable('Nutrition', t1));
    mount.appendChild(createTable('Cognitive Benefits', t2));
    mount.appendChild(createTable('Diet Compatibility', t3));
    mount.appendChild(createTable('Gut Health / Microbiome Support', t4));
  }

  // very simple heuristic ingredient finder from free text
  function deriveIngredientsFromRecipe(text) {
    if (!text || typeof text !== 'string') return [];
    const tokens = Array.from(
      new Set(
        text
          .split(/[\s,.;:()\[\]\-–—]+/g)
          .map(norm)
          .filter(t => t && t.length >= 3)
      )
    );

    const matches = new Set();
    for (const t of tokens) {
      const canon = lookupCanonical(t);
      if (canon) matches.add(canon);
    }
    return Array.from(matches);
  }

  // ---------- public API ----------
  window.BP = window.BP || {};
  window.BP.renderTables = async function (ingredientsArray) {
    try {
      await loadAll();
      renderAllTables(ingredientsArray);
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
    return deriveIngredientsFromRecipe(text);
  };
})();

