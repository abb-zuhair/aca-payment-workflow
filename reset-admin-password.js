#!/usr/bin/env node
/**
 * Reset the admin account's password directly in the database.
 * Use this only when locked out (forgot the password) — if you still know
 * it, use the in-app "Change password" instead.
 *
 * Usage:
 *   node reset-admin-password.js NewPassword123!
 *   node reset-admin-password.js NewPassword123! --name admin
 *
 * On Railway, run this against the deployed database with:
 *   railway run node reset-admin-password.js NewPassword123!
 * (requires DATA_DIR to be set the same way the app itself is configured)
 */
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const newPassword = args.find(a => !a.startsWith('--'));
const nameIdx = args.indexOf('--name');
const targetName = nameIdx !== -1 ? args[nameIdx + 1] : null;

if (!newPassword || newPassword.length < 8) {
  console.error('Usage: node reset-admin-password.js <new-password (min 8 chars)> [--name <username>]');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'payments.db');
if (!fs.existsSync(dbPath)) {
  console.error('Database not found at ' + dbPath + ' — is DATA_DIR set correctly?');
  process.exit(1);
}

const db = new Database(dbPath);
const hash = bcrypt.hashSync(newPassword, 10);

let info;
if (targetName) {
  info = db.prepare(`UPDATE users SET password_hash=?, must_change_password=1 WHERE name=? AND role='admin'`).run(hash, targetName);
} else {
  info = db.prepare(`UPDATE users SET password_hash=?, must_change_password=1 WHERE role='admin'`).run(hash);
}

if (info.changes === 0) {
  console.error('No matching admin account found' + (targetName ? ` named "${targetName}"` : '') + '.');
  const admins = db.prepare(`SELECT name FROM users WHERE role='admin'`).all();
  console.error('Existing admin accounts: ' + (admins.length ? admins.map(a => a.name).join(', ') : '(none)'));
  process.exit(1);
}

console.log(`✓ Password reset for ${info.changes} admin account(s)${targetName ? ` (${targetName})` : ''}.`);
console.log('They will be asked to set their own password on next login.');
