/**
 * Multi-department budget workbook integration.
 *
 * The admin registers any number of DEPARTMENTS, each pointing at its own
 * workbook (IT.xlsx, HR.xlsx, Maintenance.xlsx, …) on OneDrive or a local copy.
 * Each workbook is self-maintaining: every "<Entity> <Type> Tracker" sheet
 * computes Utilized via SUMIF over its paired "<Entity> <Type> Log" sheet, so
 * this module never edits tracker cells — it only APPENDS a row to the right Log
 * sheet and the workbook's own formulas handle the deduction.
 *
 * A request may charge MULTIPLE budget lines, but all within ONE department, and
 * the split amounts must sum to the request total.
 *
 * Config shape (config key 'budget'):
 *   { policy:'block'|'warn', required:bool, cacheMinutes:int,
 *     departments: [ { id, name, mode:'off'|'local'|'onedrive',
 *                      localPath, shareLink, driveId, itemId, fileName } ] }
 *
 * Per-user access (config key 'deptAccess:<userId>'): { departments:[deptId,...] }
 * Empty / missing = access to all departments (back-compat default for admins).
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { graphFetch, graphConfigured } = require('./graph');
const { db, getConfig, setConfig, audit } = require('./db');

const DEFAULT_BUDGET_CONFIG = {
  policy: 'block',        // block | warn (when amount > available)
  required: true,         // budget line mandatory on new requests while any dept is on
  cacheMinutes: 5,
  departments: [],        // list of department workbooks
};

function getBudgetConfig() {
  const c = Object.assign({}, DEFAULT_BUDGET_CONFIG, getConfig('budget', {}));
  if (!Array.isArray(c.departments)) c.departments = [];
  return c;
}
function setBudgetConfig(c) { setConfig('budget', c); }

/* Any department actually connected? */
function anyDeptOn() { return getBudgetConfig().departments.some(d => d.mode && d.mode !== 'off'); }
function getDept(deptId) { return getBudgetConfig().departments.find(d => d.id === deptId) || null; }

/* ---------- per-user department access ---------- */
function getUserDepartments(userId) {
  const rec = getConfig('deptAccess:' + userId, null);
  // null record OR empty list both mean "no restriction" (access to all)
  if (!rec || !Array.isArray(rec.departments) || rec.departments.length === 0) return null;
  return rec.departments;
}
function setUserDepartments(userId, deptIds) {
  setConfig('deptAccess:' + userId, { departments: Array.isArray(deptIds) ? deptIds : [] });
}
/* departments a user is allowed to see (full dept objects that are switched on) */
function departmentsForUser(userId, includeOff) {
  const cfg = getBudgetConfig();
  const allowed = getUserDepartments(userId); // null = all
  return cfg.departments.filter(d =>
    (includeOff || (d.mode && d.mode !== 'off')) &&
    (allowed === null || allowed.includes(d.id))
  );
}

/* ---------- share link -> drive item ---------- */
function encodeShareLink(url) {
  const b64 = Buffer.from(url, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return 'u!' + b64;
}
async function resolveShareLink(url) {
  const item = await graphFetch(`/shares/${encodeShareLink(url)}/driveItem?$select=id,name,parentReference`);
  return { driveId: item.parentReference.driveId, itemId: item.id, fileName: item.name };
}

/* ---------- cell value helpers (local/exceljs) ---------- */
function cellVal(cell) {
  const v = cell.value;
  if (v == null) return null;
  if (typeof v === 'object') {
    if ('result' in v) return v.result == null ? null : v.result;
    if ('richText' in v) return v.richText.map(t => t.text).join('');
    if (v instanceof Date) return v;
    if ('error' in v) return null;
  }
  return v;
}
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
/* sub-category = the tracker sheet's name without its "Tracker" suffix,
   e.g. "ACAH Consumables Tracker" -> "ACAH Consumables" */
function categoryOf(sheetName) { return String(sheetName || '').replace(/\s*tracker\s*$/i, '').trim() || 'General'; }

/* ---------- backends ---------- */
async function readWorkbookLocal(localPath) {
  if (!localPath || !fs.existsSync(localPath)) throw new Error('Budget file not found at ' + localPath);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(localPath);
  const sheets = {};
  wb.eachSheet(ws => {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const r = [];
      for (let c = 1; c <= 8; c++) r.push(cellVal(row.getCell(c)));
      rows[rowNumber - 1] = r;
    });
    sheets[ws.name] = rows;
  });
  return { sheets, _wb: wb };
}
async function readSheetGraph(dept, sheetName) {
  const base = `/drives/${dept.driveId}/items/${dept.itemId}/workbook/worksheets('${encodeURIComponent(sheetName)}')`;
  const range = await graphFetch(`${base}/usedRange(valuesOnly=true)?$select=values,rowCount`);
  return range.values || [];
}
async function listSheetNamesGraph(dept) {
  const data = await graphFetch(`/drives/${dept.driveId}/items/${dept.itemId}/workbook/worksheets?$select=name`);
  return (data.value || []).map(w => w.name);
}

/* ---------- tracker parsing ---------- */
function parseTrackerRows(rows, trackerSheet, logSheet, dept, computeUtilizedFromLog) {
  const lines = [];
  for (let i = 3; i < rows.length; i++) {
    const r = rows[i] || [];
    const code = r[0] == null ? '' : String(r[0]).trim();
    if (!code) continue;
    if (/total/i.test(code)) continue;
    if (!/^[A-Z]{2,6}-[A-Z]{2,5}-\d+/i.test(code)) continue;
    const budget = num(r[4]);
    const adjust = num(r[6]);
    let utilized = num(r[5]);
    if (computeUtilizedFromLog) utilized = computeUtilizedFromLog(code);
    const available = budget + adjust - utilized;
    lines.push({
      code,
      line: r[1] == null ? '' : String(r[1]).trim(),
      description: r[2] == null ? '' : String(r[2]).trim(),
      gl: r[3] == null ? '' : String(r[3]).trim(),
      budget, utilized, adjust, available,
      trackerSheet, logSheet, category: categoryOf(trackerSheet),
      deptId: dept.id, deptName: dept.name,
    });
  }
  return lines;
}
function sumLogByCode(logRows) {
  const sums = {};
  for (let i = 3; i < logRows.length; i++) {
    const r = logRows[i] || [];
    const code = r[3] == null ? '' : String(r[3]).trim();
    if (!code) continue;
    sums[code] = (sums[code] || 0) + num(r[5]);
  }
  return code => sums[code] || 0;
}
function trackerPairs(sheetNames) {
  return sheetNames
    .filter(n => /tracker$/i.test(n.trim()))
    .map(n => ({ trackerSheet: n, logSheet: n.replace(/tracker\s*$/i, 'Log').replace(/\s+Log$/, ' Log') }))
    .filter(p => sheetNames.includes(p.logSheet));
}

/* ---------- per-department lines cache ---------- */
const linesCacheByDept = {}; // deptId -> { at, lines, key }
function deptCacheKey(dept) { return dept.mode + '|' + dept.localPath + '|' + dept.itemId; }
function clearLinesCache(deptId) {
  if (deptId) delete linesCacheByDept[deptId];
  else for (const k of Object.keys(linesCacheByDept)) delete linesCacheByDept[k];
}

/**
 * Holds: a split line's amount is reserved from the moment the Budget Supervisor
 * approves until the request is rejected or finalized. Keyed by "deptId|code".
 */
function heldKey(deptId, code) { return deptId + '|' + code; }
function computeHeldAmounts() {
  const rows = db.prepare(`SELECT json FROM requests`).all();
  const held = {};
  for (const row of rows) {
    let r;
    try { r = JSON.parse(row.json); } catch (e) { continue; }
    if (r.status === 'rejected' || r.status === 'cancelled') continue;
    if (r.paymentFinalized) continue;
    const budgetApproved = r.approvals && r.approvals.budget && r.approvals.budget.decision === 'approved';
    if (!budgetApproved) continue;
    for (const ln of budgetLinesOf(r)) {
      held[heldKey(ln.deptId, ln.code)] = (held[heldKey(ln.deptId, ln.code)] || 0) + Number(ln.amount || 0);
    }
  }
  return held;
}

/* normalize a request's budget selection to an array of {deptId,code,amount,...} */
function budgetLinesOf(r) {
  if (Array.isArray(r.budgetLines) && r.budgetLines.length) return r.budgetLines;
  if (r.budget && r.budget.code) { // legacy single-line shape
    return [Object.assign({ amount: Number(r.amount || 0) }, r.budget)];
  }
  return [];
}

/* ---------- database-backed budgets ----------
   Lines live in budget_lines; spend lives in budget_ledger (the DB equivalent
   of a Log sheet). Utilized is summed from the ledger, exactly as the workbook's
   SUMIF did, so the arithmetic matches what finance is used to. */
function dbLinesFor(dept) {
  const rows = db.prepare(`SELECT * FROM budget_lines WHERE dept_id=? ORDER BY code`).all(dept.id);
  const spent = db.prepare(`SELECT code, SUM(amount) total FROM budget_ledger WHERE dept_id=? GROUP BY code`).all(dept.id);
  const byCode = {};
  for (const s of spent) byCode[s.code] = Number(s.total) || 0;
  return rows.map(r => {
    const utilized = byCode[r.code] || 0;
    return {
      code: r.code,
      line: r.line_no || '',
      description: r.description || '',
      gl: r.gl || '',
      budget: Number(r.budget) || 0,
      utilized,
      adjust: Number(r.adjust) || 0,
      available: (Number(r.budget) || 0) + (Number(r.adjust) || 0) - utilized,
      trackerSheet: r.sheet || '',
      logSheet: r.sheet || '',
      category: categoryOf(r.sheet),
      deptId: dept.id, deptName: dept.name,
    };
  });
}

/* record a request's split line against a database-backed department */
function addLedgerEntry(deptId, entry) {
  const id = 'bl_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
  /* every row carries a content fingerprint, so an export → re-import round trip
     never duplicates it — whether it came from a spreadsheet, a finalized
     payment, or a manual correction */
  const key = entry.importKey || importKeyFor(deptId, entry.code, entry.date || '', entry.ref || '', Number(entry.amount) || 0, entry.description || '');
  db.prepare(`INSERT INTO budget_ledger (id,dept_id,code,entry_date,ref,description,amount,remarks,source,request_id,import_key)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, deptId, entry.code, entry.date || '', entry.ref || '', entry.description || '',
         Number(entry.amount) || 0, entry.remarks || '', entry.source || 'app',
         entry.requestId || null, key);
  return id;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Read a department's tracker lines from its backend (local file or Graph),
   with retry-on-failure and stale-cache fallback so a workbook that's briefly
   locked (e.g. someone has it open in Excel) doesn't surface as an error. */
async function readDeptLinesFresh(dept) {
  let lines = [];
  if (dept.mode === 'local') {
    const { sheets } = await readWorkbookLocal(dept.localPath);
    const names = Object.keys(sheets);
    for (const pair of trackerPairs(names)) {
      const utilFn = sumLogByCode(sheets[pair.logSheet] || []);
      lines = lines.concat(parseTrackerRows(sheets[pair.trackerSheet], pair.trackerSheet, pair.logSheet, dept, utilFn));
    }
  } else if (dept.mode === 'onedrive') {
    const names = await listSheetNamesGraph(dept);
    for (const pair of trackerPairs(names)) {
      const rows = await readSheetGraph(dept, pair.trackerSheet);
      lines = lines.concat(parseTrackerRows(rows, pair.trackerSheet, pair.logSheet, dept, null));
    }
  }
  return lines;
}

async function readDeptLinesRaw(dept, force) {
  /* database-backed departments are local and instant — no cache, no retry,
     no chance of a locked workbook, so read them directly every time. */
  if (dept.mode === 'db') {
    return { lines: dbLinesFor(dept), stale: false, cachedAt: Date.now() };
  }
  const cached = linesCacheByDept[dept.id];
  const cfg = getBudgetConfig();
  const ttl = Math.max(1, Number(cfg.cacheMinutes || 5)) * 60000;
  // fresh-enough cache → serve immediately (unless a forced refresh is requested)
  if (!force && cached && cached.key === deptCacheKey(dept) && Date.now() - cached.at < ttl) {
    return { lines: cached.lines, stale: false, cachedAt: cached.at };
  }
  // otherwise read live, retrying a couple of times for transient locks/throttling
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const lines = await readDeptLinesFresh(dept);
      linesCacheByDept[dept.id] = { at: Date.now(), lines, key: deptCacheKey(dept) };
      return { lines, stale: false, cachedAt: Date.now() };
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) await sleep(600 * attempt); // 0.6s, 1.2s backoff
    }
  }
  // all attempts failed — fall back to last-known-good data if we have any
  if (cached && cached.key === deptCacheKey(dept)) {
    return { lines: cached.lines, stale: true, cachedAt: cached.at, error: lastErr.message };
  }
  // nothing cached to fall back to — surface the error
  throw lastErr;
}

/* Lines for a single department (with live holds applied). */
async function getDeptLines(deptId, force) {
  const dept = getDept(deptId);
  if (!dept || dept.mode === 'off') return { deptId, lines: [] };
  const raw = await readDeptLinesRaw(dept, force);
  const held = computeHeldAmounts();
  const lines = raw.lines.map(l => {
    const h = held[heldKey(l.deptId, l.code)] || 0;
    return Object.assign({}, l, { rawAvailable: l.available, held: h, available: l.available - h });
  });
  return { deptId, deptName: dept.name, lines, stale: raw.stale, cachedAt: raw.cachedAt, staleError: raw.error };
}

/* All lines across departments a user may access (used by admin + budget views). */
async function getBudgetLinesForUser(userId, force) {
  const depts = departmentsForUser(userId, false);
  let lines = [];
  const errors = [];
  const staleDepts = [];
  for (const d of depts) {
    try {
      const res = await getDeptLines(d.id, force);
      lines = lines.concat(res.lines);
      if (res.stale) staleDepts.push({ dept: d.name, cachedAt: res.cachedAt });
    }
    catch (e) { errors.push({ dept: d.name, error: e.message }); }
  }
  return { lines, errors, stale: staleDepts, departments: depts.map(d => ({ id: d.id, name: d.name, mode: d.mode })) };
}

/* ---------- append the PRQ log rows (the actual deduction) ---------- */
function firstEmptyLogRowIndex(logRows) {
  for (let i = 3; i < Math.max(logRows.length, 4); i++) {
    const r = logRows[i] || [];
    const hasData = [0, 1, 2, 3, 5].some(c => r[c] != null && String(r[c]).trim() !== '');
    if (!hasData) return i + 1;
  }
  return Math.max(logRows.length, 4) + 1;
}

/* write ONE split line into its department workbook; returns {sheet,row} */
async function appendOneLine(dept, request, ln) {
  const dateStr = (request.completedAt || new Date().toISOString()).slice(0, 10);
  const desc = `${request.payeeName} — ${request.description}`.slice(0, 200);
  const remark = 'Auto: payment workflow';
  if (dept.mode === 'db') {
    /* guard against a double-write if a retry lands twice for the same line */
    const existing = db.prepare(`SELECT id FROM budget_ledger WHERE request_id=? AND code=? AND dept_id=?`)
      .get(request.id, ln.code, dept.id);
    if (existing) return { sheet: 'database', row: 0, ledgerId: existing.id };
    const id = addLedgerEntry(dept.id, {
      code: ln.code, date: dateStr, ref: request.id, description: desc,
      amount: Number(ln.amount), remarks: remark, source: 'app', requestId: request.id,
    });
    return { sheet: 'database', row: 0, ledgerId: id };
  }
  if (dept.mode === 'local') {
    const { sheets, _wb } = await readWorkbookLocal(dept.localPath);
    if (!sheets[ln.logSheet]) throw new Error(`Log sheet "${ln.logSheet}" not found in ${dept.name} workbook`);
    const rowNo = firstEmptyLogRowIndex(sheets[ln.logSheet]);
    const ws = _wb.getWorksheet(ln.logSheet);
    const row = ws.getRow(rowNo);
    row.getCell(1).value = new Date(dateStr + 'T00:00:00Z');
    row.getCell(2).value = request.id;
    row.getCell(3).value = desc;
    row.getCell(4).value = ln.code;
    row.getCell(6).value = Number(ln.amount);
    row.getCell(8).value = remark;
    row.commit();
    await _wb.xlsx.writeFile(dept.localPath);
    return { sheet: ln.logSheet, row: rowNo };
  }
  const logRows = await readSheetGraph(dept, ln.logSheet);
  const rowNo = firstEmptyLogRowIndex(logRows);
  const base = `/drives/${dept.driveId}/items/${dept.itemId}/workbook/worksheets('${encodeURIComponent(ln.logSheet)}')`;
  await graphFetch(`${base}/range(address='A${rowNo}:D${rowNo}')`, { method: 'PATCH', body: JSON.stringify({ values: [[dateStr, request.id, desc, ln.code]] }) });
  await graphFetch(`${base}/range(address='F${rowNo}:F${rowNo}')`, { method: 'PATCH', body: JSON.stringify({ values: [[Number(ln.amount)]] }) });
  await graphFetch(`${base}/range(address='H${rowNo}:H${rowNo}')`, { method: 'PATCH', body: JSON.stringify({ values: [[remark]] }) });
  return { sheet: ln.logSheet, row: rowNo };
}

/* write ALL split lines for a request (idempotent per line via synced flag) */
async function appendLogEntries(request) {
  const lines = budgetLinesOf(request);
  if (!lines.length) return { skipped: 'no budget line selected' };
  const results = [];
  for (const ln of lines) {
    if (ln._synced) { results.push({ code: ln.code, sheet: ln.logSheet, row: ln._row, already: true }); continue; }
    const dept = getDept(ln.deptId);
    if (!dept || dept.mode === 'off') throw new Error(`Department for line ${ln.code} is not connected`);
    const res = await appendOneLine(dept, request, ln);
    ln._synced = true; ln._row = res.row;
    clearLinesCache(dept.id);
    results.push({ code: ln.code, sheet: res.sheet, row: res.row, deptName: dept.name });
  }
  return { results };
}

/* ---------- fire-and-forget sync on finalize + manual retry ---------- */
function syncRequestToBudget(r, saveRequest) {
  const lines = budgetLinesOf(r);
  if (!lines.length) return;
  r.budgetSync = { status: 'pending', at: new Date().toISOString() };
  saveRequest(r);
  appendLogEntries(r)
    .then(res => {
      if (res.skipped) {
        r.budgetSync = { status: 'skipped', reason: res.skipped, at: new Date().toISOString() };
      } else {
        const summary = res.results.map(x => `${x.code} → ${x.sheet} row ${x.row}`).join('; ');
        r.budgetSync = { status: 'synced', at: new Date().toISOString(), results: res.results };
        r.log.push({ who: 'System', role: 'Budget', action: `PRQ ${r.id} recorded: ${summary}`, at: r.budgetSync.at });
        audit(r.id, 'System', `Budget log written: ${summary}`);
      }
      saveRequest(r);
    })
    .catch(err => {
      r.budgetSync = { status: 'failed', error: String(err.message).slice(0, 300), at: new Date().toISOString() };
      r.log.push({ who: 'System', role: 'Budget', action: 'Budget sync FAILED — use "Retry budget sync": ' + r.budgetSync.error, at: r.budgetSync.at });
      audit(r.id, 'System', 'Budget sync FAILED: ' + r.budgetSync.error);
      saveRequest(r);
    });
}

/* ---------- import an Excel workbook into a database-backed department ----------
   Upserts budget lines by code (keeping existing spend) and brings the Log
   sheet rows across as ledger entries. Re-importing the same file is safe:
   each imported row carries a content hash, so duplicates are ignored. */
function importKeyFor(deptId, code, date, ref, amount, desc) {
  return crypto.createHash('sha1')
    .update([deptId, code, String(date), String(ref), Number(amount).toFixed(3), String(desc)].join('|'))
    .digest('hex');
}

async function importWorkbookIntoDept(deptId, filePath) {
  const dept = getDept(deptId);
  if (!dept) throw new Error('Department not found');
  const { sheets } = await readWorkbookLocal(filePath);
  const names = Object.keys(sheets);
  const pairs = trackerPairs(names);
  if (!pairs.length) {
    throw new Error('No "… Tracker" / "… Log" sheet pairs found in that file. Each tracker sheet needs a matching log sheet with the same name ending in "Log".');
  }

  let linesAdded = 0, linesUpdated = 0, ledgerAdded = 0, ledgerSkipped = 0;
  const upsertLine = db.prepare(`
    INSERT INTO budget_lines (id,dept_id,code,description,gl,line_no,budget,adjust,sheet)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(dept_id,code) DO UPDATE SET
      description=excluded.description, gl=excluded.gl, line_no=excluded.line_no,
      budget=excluded.budget, adjust=excluded.adjust, sheet=excluded.sheet,
      updated_at=datetime('now')`);

  const run = db.transaction(() => {
    for (const pair of pairs) {
      // ---- budget lines from the tracker sheet
      const parsed = parseTrackerRows(sheets[pair.trackerSheet], pair.trackerSheet, pair.logSheet, dept, () => 0);
      for (const l of parsed) {
        const existing = db.prepare(`SELECT id FROM budget_lines WHERE dept_id=? AND code=?`).get(deptId, l.code);
        upsertLine.run(
          existing ? existing.id : 'bln_' + crypto.randomBytes(8).toString('hex'),
          deptId, l.code, l.description, l.gl, l.line || '', l.budget, l.adjust, pair.trackerSheet
        );
        if (existing) linesUpdated++; else linesAdded++;
      }
      // ---- spend history from the log sheet
      const logRows = sheets[pair.logSheet] || [];
      for (let i = 3; i < logRows.length; i++) {
        const r = logRows[i] || [];
        const code = r[3] == null ? '' : String(r[3]).trim();
        const amount = num(r[5]);
        if (!code || !amount) continue;
        const d = r[0] instanceof Date ? r[0].toISOString().slice(0, 10) : String(r[0] == null ? '' : r[0]).slice(0, 30);
        const ref = r[1] == null ? '' : String(r[1]).trim();
        const desc = r[2] == null ? '' : String(r[2]).trim();
        const key = importKeyFor(deptId, code, d, ref, amount, desc);
        const dup = db.prepare(`SELECT id FROM budget_ledger WHERE import_key=?`).get(key);
        if (dup) { ledgerSkipped++; continue; }
        /* don't re-import a row this app itself wrote back to the sheet */
        if (ref && db.prepare(`SELECT id FROM budget_ledger WHERE request_id=? AND code=? AND dept_id=?`).get(ref, code, deptId)) {
          ledgerSkipped++; continue;
        }
        addLedgerEntry(deptId, {
          code, date: d, ref, description: desc, amount,
          remarks: r[7] == null ? '' : String(r[7]).trim(),
          source: 'import', importKey: key,
        });
        ledgerAdded++;
      }
    }
  });
  run();
  clearLinesCache(deptId);
  return { linesAdded, linesUpdated, ledgerAdded, ledgerSkipped, sheets: pairs.length };
}

/* edit a database line's budget / adjustment / description */
function updateDbLine(deptId, code, fields) {
  const row = db.prepare(`SELECT * FROM budget_lines WHERE dept_id=? AND code=?`).get(deptId, code);
  if (!row) throw new Error('Unknown budget line: ' + code);
  const budgetV = fields.budget !== undefined ? Number(fields.budget) : row.budget;
  const adjustV = fields.adjust !== undefined ? Number(fields.adjust) : row.adjust;
  if (!isFinite(budgetV) || !isFinite(adjustV)) throw new Error('Budget and adjustment must be numbers');
  db.prepare(`UPDATE budget_lines SET budget=?, adjust=?, description=?, updated_at=datetime('now') WHERE id=?`)
    .run(budgetV, adjustV, fields.description !== undefined ? String(fields.description).slice(0, 200) : row.description, row.id);
  clearLinesCache(deptId);
  return db.prepare(`SELECT * FROM budget_lines WHERE id=?`).get(row.id);
}

/* manual ledger adjustment / correction by an admin */
function addManualLedgerEntry(deptId, code, amount, description, who) {
  if (!db.prepare(`SELECT id FROM budget_lines WHERE dept_id=? AND code=?`).get(deptId, code)) {
    throw new Error('Unknown budget line: ' + code);
  }
  try {
    return addLedgerEntry(deptId, {
      code, date: new Date().toISOString().slice(0, 10), ref: 'MANUAL',
      description: description || 'Manual adjustment', amount: Number(amount),
      remarks: 'Entered by ' + who, source: 'manual',
    });
  } catch (e) {
    if (/UNIQUE constraint failed: budget_ledger.import_key/.test(e.message)) {
      throw new Error('An identical entry (same line, amount and description) already exists today. If this is intentional, change the description slightly.');
    }
    throw e;
  }
}
function ledgerFor(deptId, code) {
  return code
    ? db.prepare(`SELECT * FROM budget_ledger WHERE dept_id=? AND code=? ORDER BY entry_date DESC, created_at DESC`).all(deptId, code)
    : db.prepare(`SELECT * FROM budget_ledger WHERE dept_id=? ORDER BY entry_date DESC, created_at DESC LIMIT 500`).all(deptId);
}

module.exports = {
  getBudgetConfig, setBudgetConfig, resolveShareLink,
  getDept, getDeptLines, getBudgetLinesForUser, clearLinesCache,
  departmentsForUser, getUserDepartments, setUserDepartments,
  anyDeptOn, budgetLinesOf, appendLogEntries, syncRequestToBudget,
  importWorkbookIntoDept, addManualLedgerEntry, ledgerFor, dbLinesFor, updateDbLine, categoryOf,
  computeHeldAmounts, DEFAULT_BUDGET_CONFIG, graphConfigured,
  newDeptId: () => 'dept_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'),
};
