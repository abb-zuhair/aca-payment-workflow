const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'payments.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL COLLATE NOCASE,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('requestor','supervisor','accountant','budget','finance','admin')),
  active INTEGER NOT NULL DEFAULT 1,
  extra_admin INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  requestor_id TEXT,
  requestor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  actor TEXT,
  action TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('supervisor','accountant','budget','finance')),
  policy TEXT NOT NULL DEFAULT 'any' CHECK (policy IN ('any','all')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
`);

/* migration: older databases have a users CHECK constraint without 'supervisor' */
(function migrateUsersRole() {
  const master = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get();
  if (master && !master.sql.includes("'supervisor'")) {
    db.exec(`
      BEGIN;
      CREATE TABLE users_new (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL COLLATE NOCASE,
        email TEXT,
        role TEXT NOT NULL CHECK (role IN ('requestor','supervisor','accountant','budget','finance','admin')),
        active INTEGER NOT NULL DEFAULT 1,
        password_hash TEXT NOT NULL,
        must_change_password INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_new SELECT id,name,email,role,active,password_hash,must_change_password,created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      COMMIT;
    `);
    console.log('DB migration: users table now accepts the supervisor role');
  }
})();

/* migration: multi-role — users can hold their primary role plus an admin extra */
(function migrateExtraAdmin() {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
  if (!cols.includes('extra_admin')) {
    db.exec(`ALTER TABLE users ADD COLUMN extra_admin INTEGER NOT NULL DEFAULT 0`);
    console.log('DB migration: users.extra_admin added');
  }
})();

/* migration: attachments may live in OneDrive/SharePoint — add drive_id/item_id.
   Also make `path` nullable-in-practice (cloud attachments have no local path). */
(function migrateAttachmentsCloud() {
  const cols = db.prepare(`PRAGMA table_info(attachments)`).all().map(c => c.name);
  if (!cols.includes('drive_id')) {
    db.exec(`ALTER TABLE attachments ADD COLUMN drive_id TEXT`);
    console.log('DB migration: attachments.drive_id added');
  }
  if (!cols.includes('item_id')) {
    db.exec(`ALTER TABLE attachments ADD COLUMN item_id TEXT`);
    console.log('DB migration: attachments.item_id added');
  }
})();
function seedAdmin() {
  const existing = db.prepare(`SELECT id FROM users WHERE role='admin'`).get();
  if (existing) return null;
  const pass = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const id = 'u_admin_' + Date.now();
  db.prepare(`INSERT INTO users (id,name,email,role,active,password_hash,must_change_password)
              VALUES (?,?,?,?,1,?,1)`)
    .run(id, 'admin', '', 'admin', bcrypt.hashSync(pass, 10));
  return { name: 'admin', password: pass };
}

const DEFAULT_WORKFLOW = [
  { key: 'supervisor', enabled: true, minAmount: 0 },
  { key: 'accountant', enabled: true, minAmount: 0 },
  { key: 'budget', enabled: true, minAmount: 0 },
  { key: 'finance', enabled: true, minAmount: 0 },
];

const DEFAULT_CUSTOM_FIELDS = [];

/* the built-in request fields available for the printable layout, in their default order */
const STANDARD_PRINT_FIELDS = [
  { key: 'department', label: 'Department' },
  { key: 'requestDate', label: 'Request Date' },
  { key: 'requestorName', label: 'Requestor Name' },
  { key: 'requestorPhone', label: 'Requestor Phone' },
  { key: 'payeeName', label: 'Payee Name' },
  { key: 'payeeAddress', label: 'Payee Address / Phone' },
  { key: 'paymentType', label: 'Payment Type' },
  { key: 'paymentMethod', label: 'Payment Method' },
  { key: 'amount', label: 'Amount' },
  { key: 'currency', label: 'Currency' },
  { key: 'description', label: 'Payment Description' },
  { key: 'budgetLine', label: 'Budget Line' },
  { key: 'documents', label: 'Documents Enclosed' },
  { key: 'financeRequestNo', label: 'Request #' },
  { key: 'financeVoucherNo', label: 'Voucher #' },
  { key: 'financeVendorNo', label: 'Vendor #' },
];

const DEFAULT_PRINT = {
  orgName: 'Sama Educational Co.',
  logoInitial: 'S',
  formTitle: 'PAYMENT REQUEST',
  headerNote: '',
  showBanner: true,
  showApprovals: true,
  showAttachments: true,
  footerLine: 'Physical signature required below to complete filing',
  signatoryLabel: 'Authorized Signatory',
  footerNote: '',
};

function getConfig(key, fallback) {
  const row = db.prepare(`SELECT json FROM config WHERE key=?`).get(key);
  return row ? JSON.parse(row.json) : fallback;
}
function setConfig(key, val) {
  db.prepare(`INSERT INTO config (key,json) VALUES (?,?)
              ON CONFLICT(key) DO UPDATE SET json=excluded.json`)
    .run(key, JSON.stringify(val));
}

function audit(requestId, actor, action) {
  db.prepare(`INSERT INTO audit_log (request_id, actor, action) VALUES (?,?,?)`)
    .run(requestId, actor, action);
}

/* WAL-safe backup: checkpoint the write-ahead log into the main file, then copy.
   Using db.backup() writes a consistent single-file snapshot that includes every
   committed change (a plain file copy could miss data still sitting in the WAL). */
async function backupTo(destPath) {
  await db.backup(destPath);
  return destPath;
}

module.exports = { db, DATA_DIR, DB_PATH, backupTo, seedAdmin, getConfig, setConfig, audit, DEFAULT_WORKFLOW, DEFAULT_PRINT, DEFAULT_CUSTOM_FIELDS, STANDARD_PRINT_FIELDS, bcrypt };
