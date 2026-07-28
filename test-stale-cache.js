/**
 * Unit test for the budget stale-cache fallback.
 *
 * Verifies that when a live workbook read fails (e.g. the file is open/locked),
 * getDeptLines() returns the last-known-good cached data flagged stale=true,
 * instead of throwing — and that a first-ever failure with no cache DOES throw.
 *
 * We drive this through a temporary local-mode department: seed the cache from a
 * good file, then point the department at a missing file so the fresh read fails.
 */
process.env.DATA_DIR = '/tmp/stale_test_data';
const fs = require('fs');
const path = require('path');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const budget = require('./budget');

async function main() {
  const good = path.join(__dirname, 'samples', 'sample-budget-workbook.xlsx');
  const tmp = '/tmp/stale_test_book.xlsx';
  fs.copyFileSync(good, tmp);

  // register a local department pointing at the good file
  const cfg = budget.getBudgetConfig();
  cfg.departments = [{ id: 'dept_stale', name: 'StaleTest', mode: 'local', localPath: tmp }];
  cfg.cacheMinutes = 60;
  budget.setBudgetConfig(cfg);

  // 1) first read succeeds and populates the cache
  const first = await budget.getDeptLines('dept_stale', true);
  if (!first.lines.length) throw new Error('expected lines on first read');
  if (first.stale) throw new Error('first read should not be stale');
  console.log('first read OK:', first.lines.length, 'lines, stale=', !!first.stale);

  // 2) now make the underlying file unreadable and force a refresh
  fs.unlinkSync(tmp); // file gone -> fresh read will fail
  const second = await budget.getDeptLines('dept_stale', true); // force bypasses TTL
  if (!second.lines.length) throw new Error('stale fallback should still return cached lines');
  if (!second.stale) throw new Error('expected stale=true when live read fails');
  console.log('fallback OK: served', second.lines.length, 'cached lines, stale=', second.stale);

  // 3) a department with NO prior cache should throw (nothing to fall back to)
  const cfg2 = budget.getBudgetConfig();
  cfg2.departments.push({ id: 'dept_nocache', name: 'NoCache', mode: 'local', localPath: '/tmp/does_not_exist.xlsx' });
  budget.setBudgetConfig(cfg2);
  let threw = false;
  try { await budget.getDeptLines('dept_nocache', true); }
  catch (e) { threw = true; }
  if (!threw) throw new Error('a first-ever failed read with no cache should throw');
  console.log('no-cache read correctly throws');

  console.log('ALL STALE-CACHE CHECKS PASSED');
}
main().then(() => process.exit(0)).catch(e => { console.error('FAIL:', e.message); process.exit(1); });
