const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, DATA_DIR, DB_PATH, backupTo, seedAdmin, getConfig, setConfig, audit, DEFAULT_WORKFLOW, DEFAULT_PRINT, DEFAULT_CUSTOM_FIELDS, STANDARD_PRINT_FIELDS, bcrypt } = require('./db');
const { notify, isConfigured: mailConfigured, mailFrom } = require('./notify');
const budget = require('./budget');
const attachStore = require('./attachments');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1',
    maxAge: 8 * 60 * 60 * 1000, // 8h
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- upload handling ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, 'uploads'),
    filename: (req, file, cb) => cb(null, Date.now() + '_' + crypto.randomBytes(6).toString('hex') + path.extname(file.originalname || '')),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 }, // 10MB per file
  fileFilter: (req, file, cb) => {
    const ok = /^(application\/pdf|image\/(jpeg|png|webp))$/.test(file.mimetype);
    cb(ok ? null : new Error('Only PDF, JPG, PNG or WEBP files are allowed'), ok);
  },
});

// ---------- logo upload handling ----------
const BRANDING_DIR = path.join(DATA_DIR, 'branding');
fs.mkdirSync(BRANDING_DIR, { recursive: true });
const uploadLogo = multer({
  storage: multer.diskStorage({
    destination: BRANDING_DIR,
    filename: (req, file, cb) => cb(null, 'logo_' + Date.now() + path.extname(file.originalname || '.png')),
  }),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /^(image\/(png|jpeg|webp))$/.test(file.mimetype);
    cb(ok ? null : new Error('Logo must be PNG, JPG or WEBP'), ok);
  },
});

// signatures + stamps, one folder, filename encodes the user id + kind
const SIG_DIR = path.join(DATA_DIR, 'signatures');
fs.mkdirSync(SIG_DIR, { recursive: true });
const uploadSig = multer({
  storage: multer.diskStorage({
    destination: SIG_DIR,
    filename: (req, file, cb) => cb(null, `${req.params.kind}_${req.session.user.id}_${Date.now()}` + path.extname(file.originalname || '.png')),
  }),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /^(image\/(png|jpeg|webp))$/.test(file.mimetype);
    cb(ok ? null : new Error('Signature/stamp must be PNG, JPG or WEBP'), ok);
  },
});

// ---------- helpers ----------
const ALL_STAGES = ['supervisor', 'accountant', 'budget', 'finance'];
const STAGE_LABELS = { supervisor: 'Supervisor', accountant: 'Accountant', budget: 'Budget Supervisor', finance: 'Finance Manager' };
const APPROVER_ROLES = ['supervisor', 'accountant', 'budget', 'finance'];

/**
 * The workflow is an ordered list of stages the admin can reorder and toggle.
 * Order is whatever's saved; any of the four roles missing from saved config
 * are appended in canonical order so upgrades never drop a stage.
 */
function normalizedWorkflow() {
  const stored = getConfig('workflow', DEFAULT_WORKFLOW);
  const result = [];
  const seen = new Set();
  for (const s of stored) {
    if (ALL_STAGES.includes(s.key) && !seen.has(s.key)) {
      result.push({ key: s.key, enabled: !!s.enabled, minAmount: Number(s.minAmount || 0) });
      seen.add(s.key);
    }
  }
  for (const k of ALL_STAGES) {
    if (!seen.has(k)) result.push({ key: k, enabled: true, minAmount: 0 });
  }
  return result;
}
/* the ordered list of enabled-by-default stage keys (used where an order is needed) */
function stageOrder() { return normalizedWorkflow().map(s => s.key); }

/**
 * The printable form layout is an ordered list of blocks the admin can reorder,
 * show/hide, relabel, or add to (section headers, fixed text). Standard request
 * fields and active custom fields are auto-added the first time they're seen so
 * new custom fields show up without the admin having to remember to add them —
 * but once a block exists, it's never silently removed (hiding is explicit).
 */
function mergedPrintLayout() {
  const saved = getConfig('printLayout', []);
  const seen = new Set(saved.map(b => b.id));
  const result = saved.slice();
  for (const f of STANDARD_PRINT_FIELDS) {
    const id = 'std_' + f.key;
    if (!seen.has(id)) { result.push({ id, kind: 'standard', sourceKey: f.key, label: f.label, visible: true }); seen.add(id); }
  }
  const cfields = getConfig('customFields', DEFAULT_CUSTOM_FIELDS);
  for (const cf of cfields) {
    const id = 'cf_' + cf.id;
    if (!seen.has(id)) { result.push({ id, kind: 'custom', sourceKey: cf.id, label: cf.label, visible: true }); seen.add(id); }
  }
  return result;
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}
/* a user's effective roles: their primary role, plus 'admin' if they have the admin extra */
function effectiveRoles(sessionUser) {
  const roles = [sessionUser.role];
  if (sessionUser.extraAdmin && sessionUser.role !== 'admin') roles.push('admin');
  return roles;
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const mine = effectiveRoles(req.session.user);
    if (!roles.some(r => mine.includes(r))) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, extraAdmin: !!u.extra_admin, active: !!u.active, mustChangePassword: !!u.must_change_password };
}
function loadRequest(id) {
  const row = db.prepare(`SELECT json FROM requests WHERE id=?`).get(id);
  if (!row) return null;
  return JSON.parse(row.json);
}
function saveRequest(r) {
  db.prepare(`INSERT INTO requests (id,status,requestor_id,requestor_name,created_at,json)
              VALUES (@id,@status,@requestor_id,@requestor_name,@created_at,@json)
              ON CONFLICT(id) DO UPDATE SET status=excluded.status, json=excluded.json`)
    .run({ id: r.id, status: r.status, requestor_id: r.requestorUserId || null, requestor_name: r.requestorName, created_at: r.createdAt, json: JSON.stringify(r) });
}
function attachmentsFor(requestId) {
  return db.prepare(`SELECT id,idx,name,type,size FROM attachments WHERE request_id=? ORDER BY idx`).all(requestId);
}
function chainFor(r) { return (r.chain && r.chain.length) ? r.chain : stageOrder(); }
function currentStageKey(r) { return r.status.startsWith('pending_') ? r.status.slice(8) : null; }
function groupWithMembers(gid) {
  const g = db.prepare(`SELECT * FROM groups WHERE id=?`).get(gid);
  if (!g) return null;
  const members = db.prepare(`
    SELECT u.id, u.name, u.email FROM group_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id=? AND u.active=1 AND u.role=?`).all(gid, g.role);
  return { id: g.id, name: g.name, role: g.role, policy: g.policy, members };
}
/* who may act on a stage right now (used for permission checks and queues) */
function canActOn(r, stageKey, user) {
  if (user.role !== stageKey) return false;
  const a = r.assigned && r.assigned[stageKey];
  if (!a) return true; // unassigned: any active holder of the role
  if (a.type === 'group') {
    if (!(a.members || []).some(m => m.id === user.id)) return false;
    if (a.policy === 'all') {
      const ap = r.approvals[stageKey];
      if (ap && ap.votes && ap.votes[user.id]) return false; // already voted
    }
    return true;
  }
  return a.id === user.id; // single user assignment (also covers legacy shape without type)
}
/* emails of who should act on a stage */
function stageRecipients(r, stageKey) {
  const a = r.assigned && r.assigned[stageKey];
  if (a && a.type === 'group') {
    return (a.members || []).map(m => {
      const u = db.prepare(`SELECT email FROM users WHERE id=? AND active=1`).get(m.id);
      return u && u.email;
    }).filter(Boolean);
  }
  if (a) {
    const u = db.prepare(`SELECT email FROM users WHERE id=? AND active=1`).get(a.id);
    return u && u.email ? [u.email] : [];
  }
  return db.prepare(`SELECT email FROM users WHERE role=? AND active=1 AND email!=''`).all(stageKey).map(x => x.email);
}
function requestorEmail(r) {
  const u = r.requestorUserId ? db.prepare(`SELECT email FROM users WHERE id=?`).get(r.requestorUserId) : null;
  return u && u.email ? [u.email] : [];
}

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
  const u = db.prepare(`SELECT * FROM users WHERE name=?`).get(String(name).trim());
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Invalid name or password' });
  if (!u.active) return res.status(403).json({ error: 'This account has been deactivated by the administrator' });
  req.session.user = { id: u.id, name: u.name, role: u.role, extraAdmin: !!u.extra_admin };
  audit(null, u.name, 'Logged in');
  res.json({ user: publicUser(u) });
});
app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.session.user.id);
  if (!u || !u.active) { req.session.destroy(() => {}); return res.json({ user: null }); }
  // keep session capabilities in sync with the DB (role or admin-extra may have changed)
  req.session.user.role = u.role;
  req.session.user.extraAdmin = !!u.extra_admin;
  res.json({ user: publicUser(u) });
});
app.post('/api/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.session.user.id);
  if (!bcrypt.compareSync(currentPassword || '', u.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
  db.prepare(`UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?`).run(bcrypt.hashSync(newPassword, 10), u.id);
  audit(null, u.name, 'Changed password');
  res.json({ ok: true });
});

// ---------- users (admin) ----------
app.get('/api/users', requireAuth, (req, res) => {
  // non-admins get a slim list; admin-capable (primary or extra) get the rich list
  if (!effectiveRoles(req.session.user).includes('admin')) {
    const users = db.prepare(`SELECT id,name,role,active FROM users WHERE role!='admin'`).all();
    return res.json({ users: users.map(u => ({ id: u.id, name: u.name, role: u.role, active: !!u.active })) });
  }
  const users = db.prepare(`SELECT * FROM users ORDER BY created_at`).all();
  res.json({ users: users.map(publicUser) });
});
app.post('/api/users', requireRole('admin'), (req, res) => {
  const { name, email, role, password, extraAdmin } = req.body || {};
  if (!name || !role) return res.status(400).json({ error: 'Name and role are required' });
  if (!['requestor', 'supervisor', 'accountant', 'budget', 'finance', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Initial password must be at least 8 characters' });
  const exists = db.prepare(`SELECT id FROM users WHERE name=?`).get(String(name).trim());
  if (exists) return res.status(409).json({ error: 'A user with this name already exists' });
  const id = 'u_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
  const extra = (extraAdmin && role !== 'admin') ? 1 : 0;
  db.prepare(`INSERT INTO users (id,name,email,role,extra_admin,active,password_hash,must_change_password) VALUES (?,?,?,?,?,1,?,1)`)
    .run(id, String(name).trim(), email || '', role, extra, bcrypt.hashSync(password, 10));
  audit(null, req.session.user.name, `Added user ${name} (${role}${extra ? ' + admin' : ''})`);
  res.json({ user: publicUser(db.prepare(`SELECT * FROM users WHERE id=?`).get(id)) });
});
app.patch('/api/users/:id', requireRole('admin'), (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const { role, active, resetPassword, extraAdmin } = req.body || {};
  if (role !== undefined) {
    if (u.role === 'admin') return res.status(400).json({ error: "Cannot change the admin's role" });
    db.prepare(`UPDATE users SET role=? WHERE id=?`).run(role, u.id);
    audit(null, req.session.user.name, `Changed ${u.name} role to ${role}`);
  }
  if (extraAdmin !== undefined) {
    if (u.role === 'admin') return res.status(400).json({ error: 'The primary administrator already has full admin rights' });
    db.prepare(`UPDATE users SET extra_admin=? WHERE id=?`).run(extraAdmin ? 1 : 0, u.id);
    audit(null, req.session.user.name, `${extraAdmin ? 'Granted' : 'Removed'} admin rights ${extraAdmin ? 'to' : 'from'} ${u.name}`);
  }
  if (active !== undefined) {
    if (u.role === 'admin') return res.status(400).json({ error: 'Cannot deactivate the admin account' });
    db.prepare(`UPDATE users SET active=? WHERE id=?`).run(active ? 1 : 0, u.id);
    audit(null, req.session.user.name, `${active ? 'Reactivated' : 'Deactivated'} ${u.name}`);
  }
  if (resetPassword) {
    if (resetPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    db.prepare(`UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?`).run(bcrypt.hashSync(resetPassword, 10), u.id);
    audit(null, req.session.user.name, `Reset password for ${u.name}`);
  }
  res.json({ user: publicUser(db.prepare(`SELECT * FROM users WHERE id=?`).get(u.id)) });
});
app.delete('/api/users/:id', requireRole('admin'), (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.role === 'admin') return res.status(400).json({ error: 'Cannot remove the admin account' });
  db.prepare(`DELETE FROM users WHERE id=?`).run(u.id);
  audit(null, req.session.user.name, `Removed user ${u.name}`);
  res.json({ ok: true });
});

// ---------- workflow + routing config ----------
app.get('/api/workflow', requireAuth, (req, res) => res.json({ workflow: normalizedWorkflow() }));
app.put('/api/workflow', requireRole('admin'), (req, res) => {
  const wf = req.body.workflow;
  if (!Array.isArray(wf) || !wf.some(s => s.enabled)) return res.status(400).json({ error: 'At least one stage must stay enabled' });
  /* keep the exact order the admin submitted; validate keys and de-dupe */
  const clean = [];
  const seen = new Set();
  for (const s of wf) {
    if (!ALL_STAGES.includes(s.key) || seen.has(s.key)) continue;
    clean.push({ key: s.key, enabled: !!s.enabled, minAmount: Number(s.minAmount || 0) });
    seen.add(s.key);
  }
  for (const k of ALL_STAGES) {
    if (!seen.has(k)) clean.push({ key: k, enabled: false, minAmount: 0 });
  }
  setConfig('workflow', clean);
  audit(null, req.session.user.name, 'Updated workflow order/stages: ' + clean.filter(s => s.enabled).map(s => STAGE_LABELS[s.key]).join(' → '));
  res.json({ workflow: clean });
});
app.get('/api/routing', requireRole('admin'), (req, res) => res.json({ routing: getConfig('routing', []) }));
app.put('/api/routing', requireRole('admin'), (req, res) => {
  const rules = Array.isArray(req.body.routing) ? req.body.routing : [];
  setConfig('routing', rules);
  audit(null, req.session.user.name, 'Updated routing rules');
  res.json({ routing: rules });
});

// ---------- requests ----------
app.get('/api/requests', requireAuth, (req, res) => {
  const me = req.session.user;
  let rows;
  if (me.role === 'requestor' && !me.extraAdmin) {
    rows = db.prepare(`SELECT json FROM requests WHERE requestor_id=? OR requestor_name=? ORDER BY created_at DESC`).all(me.id, me.name);
  } else {
    rows = db.prepare(`SELECT json FROM requests ORDER BY created_at DESC`).all();
  }
  const list = rows.map(x => {
    const r = JSON.parse(x.json);
    r.attachments = attachmentsFor(r.id);
    return r;
  });
  res.json({ requests: list });
});

app.post('/api/requests', requireRole('requestor', 'admin'), upload.array('files', 10), async (req, res) => {
  try {
    const b = req.body;
    const required = ['department', 'payeeName', 'amount', 'description', 'paymentType', 'paymentMethod'];
    for (const f of required) if (!b[f] || !String(b[f]).trim()) return res.status(400).json({ error: 'Missing field: ' + f });
    if (b.paymentMethod === 'Bank Transfer' && !String(b.currency || '').trim()) {
      return res.status(400).json({ error: 'Currency is mandatory for bank transfers' });
    }
    const me = req.session.user;
    const id = 'ACA-' + Date.now().toString().slice(-8);
    const amt = Number(b.amount || 0);
    if (!(amt > 0)) return res.status(400).json({ error: 'Amount must be greater than zero' });

    const workflow = normalizedWorkflow();
    const chain = workflow.filter(s => s.enabled && amt >= Number(s.minAmount || 0)).map(s => s.key);

    const routing = getConfig('routing', []);
    const rule = routing.find(x => x.requestorId === me.id) || routing.find(x => x.requestorId === '*') || null;
    const assigned = {};
    if (rule) {
      for (const k of chain) {
        const val = rule[k];
        if (!val) continue;
        if (String(val).startsWith('g:')) {
          const g = groupWithMembers(String(val).slice(2));
          if (g && g.role === k && g.members.length) {
            assigned[k] = { type: 'group', id: g.id, name: g.name, policy: g.policy, members: g.members.map(m => ({ id: m.id, name: m.name })) };
          }
        } else {
          const uid = String(val).startsWith('u:') ? String(val).slice(2) : String(val); // legacy plain ids = users
          const u = db.prepare(`SELECT id,name,active,role FROM users WHERE id=?`).get(uid);
          if (u && u.active && u.role === k) assigned[k] = { type: 'user', id: u.id, name: u.name };
        }
      }
    }

    const now = new Date().toISOString();

    /* freeze the custom-field definitions + values as they were at submission time */
    const fieldDefs = getConfig('customFields', DEFAULT_CUSTOM_FIELDS);
    let cfValues = {};
    try { cfValues = b.customFieldValues ? JSON.parse(b.customFieldValues) : {}; } catch (e) { cfValues = {}; }
    const customFields = [];
    for (const f of fieldDefs) {
      const val = String(cfValues[f.id] || '').trim();
      if (f.required && !val) return res.status(400).json({ error: 'Missing field: ' + f.label });
      if (f.type === 'select' && val && !f.options.includes(val)) return res.status(400).json({ error: 'Invalid value for field: ' + f.label });
      customFields.push({ id: f.id, label: f.label, type: f.type, value: val });
    }

    /* budget lines: accept a split (array) within a single department; validate + freeze */
    const bcfg = budget.getBudgetConfig();
    let budgetLines = null;
    let budgetDeptId = '';
    if (budget.anyDeptOn()) {
      let sel = [];
      if (b.budgetLines) { try { sel = JSON.parse(b.budgetLines); } catch (e) { sel = []; } }
      else if (b.budgetCode) { sel = [{ code: String(b.budgetCode).trim(), amount: amt }]; } // legacy single
      sel = (Array.isArray(sel) ? sel : []).filter(x => x && x.code);
      if (!sel.length && bcfg.required) return res.status(400).json({ error: 'Select at least one budget line' });
      if (sel.length) {
        // all lines must be in the same department the user can access
        const deptId = String(sel[0].deptId || b.budgetDept || '').trim();
        if (!deptId) return res.status(400).json({ error: 'Choose a department for the budget line(s)' });
        if (!budget.departmentsForUser(me.id, false).some(d => d.id === deptId)) return res.status(403).json({ error: 'You do not have access to that department budget' });
        if (sel.some(x => x.deptId && x.deptId !== deptId)) return res.status(400).json({ error: 'All budget lines in one request must be from the same department' });
        let linesData;
        try { linesData = await budget.getDeptLines(deptId, false); }
        catch (e) { return res.status(502).json({ error: 'Could not verify budget lines: ' + e.message }); }
        let splitTotal = 0;
        const frozen = [];
        for (const s of sel) {
          const line = linesData.lines.find(l => l.code === s.code);
          if (!line) return res.status(400).json({ error: 'Unknown budget line: ' + s.code });
          const lineAmt = Number(s.amount);
          if (!(lineAmt > 0)) return res.status(400).json({ error: 'Each budget line needs an amount greater than zero (' + s.code + ')' });
          if (lineAmt > line.available && bcfg.policy === 'block') {
            return res.status(400).json({ error: `Insufficient budget on ${s.code} — available ${line.available.toFixed(3)} KD, allocated ${lineAmt.toFixed(3)} KD` });
          }
          splitTotal += lineAmt;
          frozen.push({
            deptId, deptName: line.deptName, code: line.code, description: line.description, gl: line.gl,
            trackerSheet: line.trackerSheet, logSheet: line.logSheet,
            amount: lineAmt, availableAtSubmit: line.available, overBudget: lineAmt > line.available,
          });
        }
        if (Math.abs(splitTotal - amt) > 0.0005) {
          return res.status(400).json({ error: `Budget split (${splitTotal.toFixed(3)}) must equal the request amount (${amt.toFixed(3)})` });
        }
        budgetLines = frozen;
        budgetDeptId = deptId;
      }
    }

    const r = {
      id, createdAt: now, chain, assigned,
      status: chain.length ? 'pending_' + chain[0] : 'approved',
      requestorUserId: me.id, requestorName: me.name,
      department: b.department, requestorPhone: b.requestorPhone || '',
      payeeName: b.payeeName, payeeAddress: b.payeeAddress || '', payeePhone: b.payeePhone || '',
      paymentType: b.paymentType, paymentTypeOther: b.paymentTypeOther || '',
      paymentMethod: b.paymentMethod, amount: amt, currency: (b.currency || 'KWD').trim(),
      description: b.description,
      documents: b.documents ? JSON.parse(b.documents) : [],
      customFields,
      budgetLines, budgetDeptId,
      financeUse: { requestNo: '', voucherNo: '', vendorNo: '' },
      approvals: {}, log: [],
    };
    if (!chain.length) r.completedAt = now;
    r.log.push({ who: me.name, role: 'Requestor', action: 'Submitted request', at: now });
    if (budgetLines) {
      const dn = budgetLines[0].deptName;
      r.log.push({ who: 'System', role: 'Budget', action: `Charged to ${dn} budget: ` + budgetLines.map(l => `${l.code} (${l.amount.toFixed(3)} KD${l.overBudget ? ', OVER BUDGET' : ''})`).join(', '), at: now });
    }
    if (Object.keys(assigned).length) {
      r.log.push({ who: 'System', role: 'Workflow', action: 'Routed to: ' + chain.map(k => {
        const a = assigned[k];
        if (!a) return STAGE_LABELS[k] + ' → any';
        if (a.type === 'group') return STAGE_LABELS[k] + ' → team "' + a.name + '" (' + (a.policy === 'all' ? 'all ' + a.members.length + ' must approve' : 'any member') + ')';
        return STAGE_LABELS[k] + ' → ' + a.name;
      }).join(', '), at: now });
    }
    if (!chain.length) r.log.push({ who: 'System', role: 'Workflow', action: 'Auto-approved (no stages configured for this amount)', at: now });

    saveRequest(r);
    let idx = 0;
    for (const f of (req.files || [])) {
      let loc;
      try { loc = await attachStore.persistUpload(f, id, idx); }
      catch (e) {
        console.error('Attachment upload failed:', e.message);
        /* fall back to keeping the local temp file so the attachment isn't lost */
        loc = { path: f.path, driveId: null, itemId: null };
        r.log.push({ who: 'System', role: 'Workflow', action: `Attachment "${f.originalname}" could not be sent to OneDrive (${String(e.message).slice(0, 120)}) — kept on the server instead`, at: new Date().toISOString() });
      }
      db.prepare(`INSERT INTO attachments (id,request_id,idx,name,type,size,path,drive_id,item_id) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run('att_' + Date.now() + '_' + idx, id, idx, f.originalname, f.mimetype, f.size, loc.path || '', loc.driveId, loc.itemId);
      idx++;
    }
    saveRequest(r);
    audit(id, me.name, 'Submitted request for ' + r.payeeName + ' — ' + r.currency + ' ' + amt);
    if (chain.length) notify('stage', r, stageRecipients(r, chain[0]), { stage: chain[0] });
    else notify('approved', r, requestorEmail(r).concat(stageRecipients(r, 'accountant')), {});
    r.attachments = attachmentsFor(id);
    res.json({ request: r });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create request' });
  }
});

/* Budget Supervisor may edit most fields of a request while it's at their stage,
   before approving/rejecting. Requester and attachments are off-limits. Earlier
   approvals are kept; the change is logged. */
app.patch('/api/requests/:id/edit', requireRole('budget', 'admin'), async (req, res) => {
  const r = loadRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  const me = req.session.user;
  const cur = currentStageKey(r);
  if (me.role === 'budget') {
    if (cur !== 'budget') return res.status(409).json({ error: 'You can only edit while the request is at the Budget Supervisor stage' });
    /* editing is allowed for any assigned budget holder / team member while the
       stage is open — unlike voting, it's fine if they've already cast a vote */
    const a = r.assigned && r.assigned.budget;
    let allowed = true;
    if (a) {
      if (a.type === 'group') allowed = (a.members || []).some(m => m.id === me.id);
      else allowed = a.id === me.id;
    }
    if (!allowed) return res.status(403).json({ error: 'This request is assigned to someone else' });
  }
  const b = req.body || {};
  const changes = [];
  const setIf = (field, label, transform) => {
    if (b[field] === undefined) return;
    const nv = transform ? transform(b[field]) : String(b[field]);
    if (String(r[field] == null ? '' : r[field]) !== String(nv == null ? '' : nv)) { changes.push(label); r[field] = nv; }
  };
  setIf('payeeName', 'Payee name');
  setIf('payeeAddress', 'Payee address');
  setIf('payeePhone', 'Payee phone');
  setIf('paymentType', 'Payment type');
  setIf('paymentTypeOther', 'Payment type (other)');
  setIf('paymentMethod', 'Payment method');
  setIf('description', 'Description');

  if (b.amount !== undefined) {
    const amt = Number(b.amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'Amount must be greater than zero' });
    if (amt !== Number(r.amount)) { changes.push(`Amount ${r.amount} → ${amt}`); r.amount = amt; }
  }
  if (b.currency !== undefined && String(b.currency).trim()) {
    if (String(b.currency).trim() !== r.currency) { changes.push('Currency'); r.currency = String(b.currency).trim(); }
  }

  // custom fields
  if (b.customFieldValues) {
    let vals = {}; try { vals = JSON.parse(b.customFieldValues); } catch (e) {}
    const defs = getConfig('customFields', DEFAULT_CUSTOM_FIELDS);
    (r.customFields || []).forEach(cf => {
      if (vals[cf.id] !== undefined) {
        const def = defs.find(d => d.id === cf.id);
        const nv = String(vals[cf.id]).trim();
        if (def && def.type === 'select' && nv && !def.options.includes(nv)) return;
        if (nv !== cf.value) { changes.push('Field: ' + cf.label); cf.value = nv; }
      }
    });
  }

  // budget lines (multi-line split within one department)
  if (b.budgetLines !== undefined) {
    let sel = []; try { sel = JSON.parse(b.budgetLines); } catch (e) { sel = []; }
    sel = (Array.isArray(sel) ? sel : []).filter(x => x && x.code);
    if (sel.length) {
      const deptId = String(sel[0].deptId || r.budgetDeptId || '').trim();
      if (sel.some(x => x.deptId && x.deptId !== deptId)) return res.status(400).json({ error: 'All budget lines must be from the same department' });
      let linesData;
      try { linesData = await budget.getDeptLines(deptId, false); } catch (e) { return res.status(502).json({ error: 'Could not verify budget lines: ' + e.message }); }
      const bcfg = budget.getBudgetConfig();
      let splitTotal = 0; const frozen = [];
      for (const s of sel) {
        const line = linesData.lines.find(l => l.code === s.code);
        if (!line) return res.status(400).json({ error: 'Unknown budget line: ' + s.code });
        const la = Number(s.amount);
        if (!(la > 0)) return res.status(400).json({ error: 'Each budget line needs an amount > 0 (' + s.code + ')' });
        if (la > line.available && bcfg.policy === 'block') return res.status(400).json({ error: `Insufficient budget on ${s.code} — available ${line.available.toFixed(3)}` });
        splitTotal += la;
        frozen.push({ deptId, deptName: line.deptName, code: line.code, description: line.description, gl: line.gl, trackerSheet: line.trackerSheet, logSheet: line.logSheet, amount: la, availableAtSubmit: line.available, overBudget: la > line.available });
      }
      if (Math.abs(splitTotal - Number(r.amount)) > 0.0005) return res.status(400).json({ error: `Budget split (${splitTotal.toFixed(3)}) must equal the request amount (${Number(r.amount).toFixed(3)})` });
      changes.push('Budget lines → ' + frozen.map(f => f.code + ':' + f.amount.toFixed(3)).join(', '));
      r.budgetLines = frozen; r.budgetDeptId = deptId; r.budget = null;
    }
  }

  /* if the amount changed but the budget split wasn't re-submitted, the two would
     no longer agree — reject rather than silently leaving a mismatched split */
  if (b.amount !== undefined && b.budgetLines === undefined) {
    const existing = budget.budgetLinesOf(r);
    if (existing.length) {
      const sum = existing.reduce((a, l) => a + Number(l.amount || 0), 0);
      if (Math.abs(sum - Number(r.amount)) > 0.0005) {
        return res.status(400).json({ error: `Changing the amount to ${Number(r.amount).toFixed(3)} leaves the budget split (${sum.toFixed(3)}) unbalanced — resubmit the budget lines with the new amount.` });
      }
    }
  }

  if (!changes.length) return res.json({ request: Object.assign({}, r, { attachments: attachmentsFor(r.id) }) });

  const now = new Date().toISOString();
  const priorApprovals = Object.keys(r.approvals).filter(k => r.approvals[k]).map(k => STAGE_LABELS[k]);
  r.log.push({
    who: me.name, role: STAGE_LABELS[me.role] || 'Admin',
    action: `Edited request before decision — changed: ${changes.join(', ')}` + (priorApprovals.length ? ` (earlier approvals kept: ${priorApprovals.join(', ')})` : ''),
    at: now,
  });
  r.editedAfterApproval = { by: me.name, at: now, changes };
  saveRequest(r);
  audit(r.id, me.name, 'Edited request fields: ' + changes.join('; '));
  res.json({ request: Object.assign({}, r, { attachments: attachmentsFor(r.id) }) });
});

app.post('/api/requests/:id/decision', requireRole('supervisor', 'accountant', 'budget', 'finance'), (req, res) => {
  const r = loadRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  const me = req.session.user;
  const cur = currentStageKey(r);
  if (!cur || cur !== me.role) return res.status(409).json({ error: 'This request is not at your stage (it may have been actioned already)' });
  const a = r.assigned && r.assigned[cur];
  if (a && a.type === 'group' && !(a.members || []).some(m => m.id === me.id)) {
    return res.status(403).json({ error: 'This request is assigned to team "' + a.name + '" and you are not a member' });
  }
  if (a && a.type !== 'group' && a.id !== me.id) {
    return res.status(403).json({ error: 'This request is assigned to ' + a.name });
  }
  const { decision, comment, financeUse } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
  if (decision === 'rejected' && !(comment || '').trim()) return res.status(400).json({ error: 'A reason is required when rejecting' });

  const now = new Date().toISOString();
  if (cur === 'accountant' && financeUse) {
    r.financeUse = {
      requestNo: String(financeUse.requestNo || ''),
      voucherNo: String(financeUse.voucherNo || ''),
      vendorNo: String(financeUse.vendorNo || ''),
    };
  }

  const isParallelGroup = a && a.type === 'group' && a.policy === 'all';
  let stageComplete = false;

  if (isParallelGroup) {
    /* parallel team approval: every member must approve; any rejection rejects */
    if (!r.approvals[cur]) r.approvals[cur] = { group: true, name: a.name, policy: 'all', votes: {} };
    const ap = r.approvals[cur];
    if (ap.votes[me.id]) return res.status(409).json({ error: 'You have already voted on this request' });
    ap.votes[me.id] = { by: me.name, byId: me.id, decision, comment: comment || '', at: now };
    r.log.push({ who: me.name, role: STAGE_LABELS[cur] + ' (team ' + a.name + ')', action: decision === 'approved' ? 'Approved' : 'Rejected', comment: comment || '', at: now });
    if (decision === 'rejected') {
      ap.decision = 'rejected'; ap.at = now; ap.by = 'Team ' + a.name;
      stageComplete = true;
    } else {
      const votedIds = Object.keys(ap.votes);
      const allVoted = (a.members || []).every(m => votedIds.includes(m.id));
      if (allVoted) {
        ap.decision = 'approved'; ap.at = now;
        ap.by = a.members.map(m => ap.votes[m.id].by).join(', ');
        r.log.push({ who: 'System', role: 'Workflow', action: `Team "${a.name}" stage complete — all ${a.members.length} members approved`, at: now });
        stageComplete = true;
      } else {
        r.log.push({ who: 'System', role: 'Workflow', action: `Team "${a.name}": ${votedIds.length} of ${a.members.length} approvals received — waiting for the rest`, at: now });
      }
    }
  } else {
    /* single approver, 'any member' group, or unassigned role */
    r.approvals[cur] = { by: me.name, byId: me.id, decision, comment: comment || '', at: now };
    if (a && a.type === 'group') r.approvals[cur].viaTeam = a.name;
    r.log.push({ who: me.name, role: STAGE_LABELS[cur] + (a && a.type === 'group' ? ' (team ' + a.name + ')' : ''), action: decision === 'approved' ? 'Approved' : 'Rejected', comment: comment || '', at: now });
    stageComplete = true;
  }

  if (stageComplete) {
    const stageDecision = r.approvals[cur].decision;
    if (stageDecision === 'approved') {
      const chain = chainFor(r);
      const next = chain[chain.indexOf(cur) + 1];
      if (next) {
        r.status = 'pending_' + next;
        notify('stage', r, stageRecipients(r, next), { stage: next });
      } else {
        r.status = 'approved';
        r.completedAt = now;
        r.log.push({ who: 'System', role: 'Workflow', action: 'ALL APPROVALS COMPLETE — form ready for printing and final signature', at: now });
        notify('approved', r, [...new Set(requestorEmail(r).concat(stageRecipients(r, 'accountant')))], {});
      }
    } else {
      r.status = 'rejected';
      r.rejectedStage = STAGE_LABELS[cur] + (isParallelGroup ? ' (team ' + a.name + ')' : '');
      r.rejectionReason = comment;
      notify('rejected', r, requestorEmail(r), {});
    }
  }

  saveRequest(r);
  audit(r.id, me.name, `${STAGE_LABELS[cur]} ${decision}` + (isParallelGroup && !stageComplete ? ' (partial team vote)' : '') + (comment ? ` — "${comment}"` : ''));
  r.attachments = attachmentsFor(r.id);
  res.json({ request: r });
});

/* ---------- recall / send back / cancel ----------
 * recall (requester) and send-back (approver) both RESET the request to the start
 * of its chain and clear every approval, per the configured behavior. Any budget
 * hold releases automatically because holds are computed live from approvals+status.
 * Admin cancel is a terminal state (like rejected) that stops the request. */
function resetToStart(r, now) {
  r.approvals = {};
  const chain = chainFor(r);
  r.status = chain.length ? 'pending_' + chain[0] : 'approved';
  delete r.completedAt;
  delete r.rejectedStage;
  delete r.rejectionReason;
}

app.post('/api/requests/:id/recall', requireAuth, (req, res) => {
  const r = loadRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  const me = req.session.user;
  if (r.requestorUserId !== me.id && me.role !== 'admin') {
    return res.status(403).json({ error: 'Only the requester (or an admin) can recall this request' });
  }
  if (['approved', 'rejected', 'cancelled'].includes(r.status)) {
    return res.status(409).json({ error: 'This request can no longer be recalled — it is already ' + r.status });
  }
  if (r.paymentFinalized) return res.status(409).json({ error: 'This request has been finalized and cannot be recalled' });
  const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
  const now = new Date().toISOString();
  const hadApprovals = Object.keys(r.approvals || {}).length > 0;
  resetToStart(r, now);
  r.log.push({ who: me.name, role: me.role === 'admin' ? 'Admin' : 'Requestor', action: 'Recalled the request — all approvals cleared, returned to the start of the chain' + (hadApprovals ? '' : ' (no approvals had been given yet)'), comment: reason, at: now });
  saveRequest(r);
  audit(r.id, me.name, 'Recalled request' + (reason ? ' — "' + reason + '"' : ''));
  const first = currentStageKey(r);
  if (first) notify('stage', r, stageRecipients(r, first), { stage: first });
  r.attachments = attachmentsFor(r.id);
  res.json({ request: r });
});

app.post('/api/requests/:id/send-back', requireRole('supervisor', 'accountant', 'budget', 'finance', 'admin'), (req, res) => {
  const r = loadRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  const me = req.session.user;
  const cur = currentStageKey(r);
  if (!cur) return res.status(409).json({ error: 'This request is not pending at any stage' });
  /* the approver acting must be at the current stage (admins may act on any pending stage) */
  if (me.role !== 'admin') {
    if (cur !== me.role) return res.status(409).json({ error: 'This request is not at your stage' });
    if (!canActOn(r, cur, me)) return res.status(403).json({ error: 'This request is assigned to someone else' });
  }
  const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: 'A reason is required when sending a request back' });
  const now = new Date().toISOString();
  resetToStart(r, now);
  r.log.push({ who: me.name, role: (me.role === 'admin' ? 'Admin' : STAGE_LABELS[cur]), action: 'Sent the request back for rework — all approvals cleared, returned to the start of the chain', comment: reason, at: now });
  saveRequest(r);
  audit(r.id, me.name, 'Sent request back — "' + reason + '"');
  notify('rejected', r, requestorEmail(r), {}); // reuse: notifies requester it needs attention
  const first = currentStageKey(r);
  if (first) notify('stage', r, stageRecipients(r, first), { stage: first });
  r.attachments = attachmentsFor(r.id);
  res.json({ request: r });
});

app.post('/api/requests/:id/cancel', requireRole('admin'), (req, res) => {
  const r = loadRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (['rejected', 'cancelled'].includes(r.status)) return res.status(409).json({ error: 'This request is already ' + r.status });
  if (r.paymentFinalized) return res.status(409).json({ error: 'This request has been finalized — the payment has already been recorded, so it cannot be cancelled here' });
  const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: 'A reason is required to cancel a request' });
  const me = req.session.user;
  const now = new Date().toISOString();
  r.status = 'cancelled';
  r.cancelledBy = me.name;
  r.cancelledAt = now;
  r.cancellationReason = reason;
  delete r.completedAt;
  r.log.push({ who: me.name, role: 'Admin', action: 'Cancelled the request', comment: reason, at: now });
  saveRequest(r);
  audit(r.id, me.name, 'Cancelled request — "' + reason + '"');
  notify('rejected', r, requestorEmail(r), {});
  r.attachments = attachmentsFor(r.id);
  res.json({ request: r });
});

// ---------- attachments ----------
app.get('/api/files/:id', requireAuth, async (req, res) => {
  const a = db.prepare(`SELECT * FROM attachments WHERE id=?`).get(req.params.id);
  if (!a) return res.status(404).send('Not found');
  // requestors may only access files on their own requests
  if (req.session.user.role === 'requestor') {
    const r = loadRequest(a.request_id);
    if (!r || (r.requestorUserId !== req.session.user.id && r.requestorName !== req.session.user.name)) {
      return res.status(403).send('Forbidden');
    }
  }
  try {
    await attachStore.serveAttachment(a, res);
  } catch (e) {
    if (!res.headersSent) res.status(502).send('Could not retrieve file: ' + e.message);
  }
});

// ---------- attachment storage (admin) ----------
app.get('/api/attach-store', requireRole('admin'), (req, res) => {
  res.json({ config: attachStore.getAttachStore(), graphConfigured: attachStore.graphConfigured() });
});
app.put('/api/attach-store', requireRole('admin'), async (req, res) => {
  try {
    const body = req.body.config || {};
    const cur = attachStore.getAttachStore();
    const c = Object.assign({}, cur);
    const mode = body.mode || 'local';
    if (!['local', 'onedrive'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
    c.mode = mode;
    if (mode === 'onedrive') {
      if (!attachStore.graphConfigured()) return res.status(400).json({ error: 'Microsoft Graph env vars are not set (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET)' });
      const link = String(body.shareLink || '').trim();
      if (!link) return res.status(400).json({ error: 'Paste the OneDrive/SharePoint share link of the attachments folder' });
      if (link !== cur.shareLink || !cur.itemId) {
        const resolved = await attachStore.resolveFolderLink(link);
        c.shareLink = link; c.driveId = resolved.driveId; c.itemId = resolved.itemId; c.folderName = resolved.folderName;
      }
    }
    attachStore.setAttachStore(c);
    audit(null, req.session.user.name, `Attachment storage set to ${c.mode}${c.folderName ? ' (folder: ' + c.folderName + ')' : ''}`);
    res.json({ config: c });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- groups / teams (admin) ----------
app.get('/api/groups', requireRole('admin'), (req, res) => {
  const groups = db.prepare(`SELECT * FROM groups ORDER BY created_at`).all().map(g => groupWithMembers(g.id));
  res.json({ groups });
});
app.post('/api/groups', requireRole('admin'), (req, res) => {
  const { name, role, policy } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Team name is required' });
  if (!APPROVER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role for a team' });
  if (!['any', 'all'].includes(policy)) return res.status(400).json({ error: 'Policy must be any or all' });
  if (db.prepare(`SELECT id FROM groups WHERE name=?`).get(String(name).trim())) return res.status(409).json({ error: 'A team with this name already exists' });
  const id = 'g_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
  db.prepare(`INSERT INTO groups (id,name,role,policy) VALUES (?,?,?,?)`).run(id, String(name).trim(), role, policy);
  audit(null, req.session.user.name, `Created team "${name}" (${STAGE_LABELS[role]}, policy: ${policy})`);
  res.json({ group: groupWithMembers(id) });
});
app.patch('/api/groups/:id', requireRole('admin'), (req, res) => {
  const g = db.prepare(`SELECT * FROM groups WHERE id=?`).get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Team not found' });
  const { policy } = req.body || {};
  if (policy) {
    if (!['any', 'all'].includes(policy)) return res.status(400).json({ error: 'Policy must be any or all' });
    db.prepare(`UPDATE groups SET policy=? WHERE id=?`).run(policy, g.id);
    audit(null, req.session.user.name, `Team "${g.name}" policy changed to ${policy}`);
  }
  res.json({ group: groupWithMembers(g.id) });
});
app.post('/api/groups/:id/members', requireRole('admin'), (req, res) => {
  const g = db.prepare(`SELECT * FROM groups WHERE id=?`).get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Team not found' });
  const u = db.prepare(`SELECT * FROM users WHERE id=?`).get((req.body || {}).userId);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.role !== g.role) return res.status(400).json({ error: `Only ${STAGE_LABELS[g.role]}s can join this team` });
  db.prepare(`INSERT OR IGNORE INTO group_members (group_id,user_id) VALUES (?,?)`).run(g.id, u.id);
  audit(null, req.session.user.name, `Added ${u.name} to team "${g.name}"`);
  res.json({ group: groupWithMembers(g.id) });
});
app.delete('/api/groups/:id/members/:userId', requireRole('admin'), (req, res) => {
  const g = db.prepare(`SELECT * FROM groups WHERE id=?`).get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Team not found' });
  db.prepare(`DELETE FROM group_members WHERE group_id=? AND user_id=?`).run(g.id, req.params.userId);
  audit(null, req.session.user.name, `Removed a member from team "${g.name}"`);
  res.json({ group: groupWithMembers(g.id) });
});
app.delete('/api/groups/:id', requireRole('admin'), (req, res) => {
  const g = db.prepare(`SELECT * FROM groups WHERE id=?`).get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Team not found' });
  db.prepare(`DELETE FROM group_members WHERE group_id=?`).run(g.id);
  db.prepare(`DELETE FROM groups WHERE id=?`).run(g.id);
  audit(null, req.session.user.name, `Deleted team "${g.name}" (in-flight requests keep their frozen assignment)`);
  res.json({ ok: true });
});

// ---------- budget workbook integration ----------
// ---------- budget departments (admin) ----------
app.get('/api/budget/config', requireRole('admin'), (req, res) => {
  res.json({ config: budget.getBudgetConfig(), graphConfigured: budget.graphConfigured() });
});
app.put('/api/budget/config', requireRole('admin'), (req, res) => {
  const body = req.body.config || {};
  const cur = budget.getBudgetConfig();
  const c = Object.assign({}, cur);
  if (body.policy !== undefined) { if (!['block', 'warn'].includes(body.policy)) return res.status(400).json({ error: 'Invalid policy' }); c.policy = body.policy; }
  if (body.required !== undefined) c.required = !!body.required;
  if (body.cacheMinutes !== undefined) c.cacheMinutes = Math.max(1, Number(body.cacheMinutes) || 5);
  budget.setBudgetConfig(c);
  audit(null, req.session.user.name, 'Budget global settings updated (policy: ' + c.policy + ', required: ' + c.required + ')');
  res.json({ config: c });
});
/* add / update / remove a department workbook */
app.post('/api/budget/departments', requireRole('admin'), async (req, res) => {
  try {
    const cfg = budget.getBudgetConfig();
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Department name is required' });
    const mode = body.mode || 'off';
    if (!['off', 'local', 'onedrive'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
    const dept = {
      id: body.id && cfg.departments.find(d => d.id === body.id) ? body.id : budget.newDeptId(),
      name, mode,
      localPath: String(body.localPath || '').trim(),
      shareLink: String(body.shareLink || '').trim(),
      driveId: '', itemId: '', fileName: '',
    };
    const existing = cfg.departments.find(d => d.id === dept.id);
    if (mode === 'onedrive') {
      if (!budget.graphConfigured()) return res.status(400).json({ error: 'Microsoft Graph env vars are not set (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET)' });
      if (!dept.shareLink) return res.status(400).json({ error: 'Paste the OneDrive share link for ' + name });
      if (!existing || existing.shareLink !== dept.shareLink || !existing.itemId) {
        const resolved = await budget.resolveShareLink(dept.shareLink);
        dept.driveId = resolved.driveId; dept.itemId = resolved.itemId; dept.fileName = resolved.fileName;
      } else { dept.driveId = existing.driveId; dept.itemId = existing.itemId; dept.fileName = existing.fileName; }
    }
    if (mode === 'local' && !dept.localPath) return res.status(400).json({ error: 'Set the local .xlsx path for ' + name });
    if (existing) Object.assign(existing, dept);
    else cfg.departments.push(dept);
    budget.setBudgetConfig(cfg);
    budget.clearLinesCache(dept.id);
    audit(null, req.session.user.name, `Budget department saved: ${name} (${mode})`);
    res.json({ config: budget.getBudgetConfig() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/budget/departments/:id', requireRole('admin'), (req, res) => {
  const cfg = budget.getBudgetConfig();
  const before = cfg.departments.length;
  cfg.departments = cfg.departments.filter(d => d.id !== req.params.id);
  if (cfg.departments.length === before) return res.status(404).json({ error: 'Department not found' });
  budget.setBudgetConfig(cfg);
  budget.clearLinesCache(req.params.id);
  audit(null, req.session.user.name, 'Budget department removed: ' + req.params.id);
  res.json({ config: budget.getBudgetConfig() });
});

/* which departments the current user may pick from, + their lines */
app.get('/api/budget/departments/mine', requireAuth, (req, res) => {
  const depts = budget.departmentsForUser(req.session.user.id, false);
  const cfg = budget.getBudgetConfig();
  res.json({ departments: depts.map(d => ({ id: d.id, name: d.name })), required: cfg.required, policy: cfg.policy });
});
app.get('/api/budget/lines', requireAuth, async (req, res) => {
  try {
    const cfg = budget.getBudgetConfig();
    if (req.query.dept) {
      /* enforce access to the requested department */
      const allowed = budget.departmentsForUser(req.session.user.id, false).some(d => d.id === req.query.dept);
      if (!allowed) return res.status(403).json({ error: 'No access to that department' });
      const data = await budget.getDeptLines(req.query.dept, req.query.force === '1');
      return res.json({ required: cfg.required, policy: cfg.policy, lines: data.lines });
    }
    const data = await budget.getBudgetLinesForUser(req.session.user.id, req.query.force === '1');
    res.json({ required: cfg.required, policy: cfg.policy, lines: data.lines, errors: data.errors, departments: data.departments });
  } catch (e) {
    res.status(502).json({ error: 'Could not read budget workbook: ' + e.message });
  }
});

/* per-user department access (admin) */
app.get('/api/users/:id/departments', requireRole('admin'), (req, res) => {
  res.json({ departments: budget.getUserDepartments(req.params.id), all: budget.getBudgetConfig().departments.map(d => ({ id: d.id, name: d.name })) });
});
app.put('/api/users/:id/departments', requireRole('admin'), (req, res) => {
  const ids = Array.isArray(req.body.departments) ? req.body.departments : [];
  budget.setUserDepartments(req.params.id, ids);
  audit(null, req.session.user.name, `Set budget department access for user ${req.params.id}: ${ids.length ? ids.join(', ') : '(all)'}`);
  res.json({ departments: budget.getUserDepartments(req.params.id) });
});

app.post('/api/requests/:id/finalize', requireRole('accountant', 'admin'), (req, res) => {
  const r = loadRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (r.status !== 'approved') return res.status(409).json({ error: 'Only fully approved requests can be finalized' });
  if (r.paymentFinalized) return res.status(409).json({ error: 'Already finalized on ' + r.paymentFinalized.at + ' by ' + r.paymentFinalized.by });
  const lines = budget.budgetLinesOf(r);
  if (!lines.length) return res.status(400).json({ error: 'This request has no budget line — nothing to finalize' });
  const paymentRef = String((req.body || {}).paymentRef || '').trim().slice(0, 100);
  const now = new Date().toISOString();
  r.paymentFinalized = { by: req.session.user.name, at: now, paymentRef };
  const summary = lines.map(l => `${l.code} (${Number(l.amount).toFixed(3)})`).join(', ');
  r.log.push({
    who: req.session.user.name, role: 'Accountant',
    action: `Finalized payment — deducting from: ${summary}` + (paymentRef ? ` (Ref: ${paymentRef})` : ''),
    at: now,
  });
  saveRequest(r);
  audit(r.id, req.session.user.name, 'Payment finalized' + (paymentRef ? ' — ref ' + paymentRef : ''));
  budget.syncRequestToBudget(r, saveRequest);
  res.json({ request: r });
});

app.post('/api/budget/sync/:id', requireRole('admin', 'accountant'), (req, res) => {
  const r = loadRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (r.status !== 'approved') return res.status(409).json({ error: 'Only fully approved requests are written to the budget sheet' });
  if (!r.paymentFinalized) return res.status(409).json({ error: 'Finalize the payment first — the budget sheet is only written once payment is finalized' });
  if (!budget.budgetLinesOf(r).length) return res.status(400).json({ error: 'This request has no budget line' });
  if (r.budgetSync && r.budgetSync.status === 'synced') return res.status(409).json({ error: 'Already synced' });
  audit(r.id, req.session.user.name, 'Manual budget sync retry triggered');
  budget.syncRequestToBudget(r, saveRequest);
  res.json({ ok: true, message: 'Sync started — refresh in a few seconds to see the result' });
});

// ---------- user signature & stamp (self-service) ----------
function sigMeta(userId) { return getConfig('sig:' + userId, {}); }
function setSigMeta(userId, m) { setConfig('sig:' + userId, m); }

app.get('/api/me/signature', requireAuth, (req, res) => {
  const m = sigMeta(req.session.user.id);
  res.json({ hasSignature: !!m.signature, hasStamp: !!m.stamp });
});
app.post('/api/me/:kind', requireAuth, (req, res, next) => {
  if (!['signature', 'stamp'].includes(req.params.kind)) return res.status(400).json({ error: 'Invalid kind' });
  next();
}, uploadSig.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const kind = req.params.kind;
  const m = sigMeta(req.session.user.id);
  if (m[kind]) { const old = path.join(SIG_DIR, m[kind].filename); if (fs.existsSync(old)) fs.unlink(old, () => {}); }
  m[kind] = { filename: req.file.filename, mime: req.file.mimetype, at: new Date().toISOString() };
  setSigMeta(req.session.user.id, m);
  audit(null, req.session.user.name, `Uploaded their ${kind}`);
  res.json({ ok: true });
});
app.delete('/api/me/:kind', requireAuth, (req, res) => {
  if (!['signature', 'stamp'].includes(req.params.kind)) return res.status(400).json({ error: 'Invalid kind' });
  const m = sigMeta(req.session.user.id);
  if (m[req.params.kind]) { const old = path.join(SIG_DIR, m[req.params.kind].filename); if (fs.existsSync(old)) fs.unlink(old, () => {}); delete m[req.params.kind]; setSigMeta(req.session.user.id, m); }
  res.json({ ok: true });
});
/* served to authenticated users so approver signatures can render on the printed form */
app.get('/api/signature/:userId/:kind', requireAuth, (req, res) => {
  if (!['signature', 'stamp'].includes(req.params.kind)) return res.status(400).send('bad kind');
  const m = sigMeta(req.params.userId);
  const rec = m[req.params.kind];
  if (!rec) return res.status(404).send('none');
  const p = path.join(SIG_DIR, rec.filename);
  if (!fs.existsSync(p)) return res.status(404).send('missing');
  res.setHeader('Content-Type', rec.mime || 'image/png');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(p).pipe(res);
});

// ---------- branding (org name + logo) ----------
/* Public — no auth — so the login screen can show the school's branding too */
app.get('/api/branding', (req, res) => {
  const print = Object.assign({}, DEFAULT_PRINT, getConfig('print', {}));
  const branding = getConfig('branding', {});
  res.json({ orgName: print.orgName, logoInitial: print.logoInitial, hasLogo: !!(branding.filename && fs.existsSync(path.join(BRANDING_DIR, branding.filename))) });
});
app.get('/api/logo', (req, res) => {
  const branding = getConfig('branding', {});
  if (!branding.filename) return res.status(404).send('No logo set');
  const p = path.join(BRANDING_DIR, branding.filename);
  if (!fs.existsSync(p)) return res.status(404).send('Logo file missing');
  res.setHeader('Content-Type', branding.mime || 'image/png');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(p).pipe(res);
});
app.post('/api/logo', requireRole('admin'), uploadLogo.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const old = getConfig('branding', {});
  if (old.filename) {
    const oldPath = path.join(BRANDING_DIR, old.filename);
    if (fs.existsSync(oldPath)) fs.unlink(oldPath, () => {});
  }
  setConfig('branding', { filename: req.file.filename, mime: req.file.mimetype, uploadedAt: new Date().toISOString() });
  audit(null, req.session.user.name, 'Uploaded a new logo');
  res.json({ ok: true });
});
app.delete('/api/logo', requireRole('admin'), (req, res) => {
  const old = getConfig('branding', {});
  if (old.filename) {
    const oldPath = path.join(BRANDING_DIR, old.filename);
    if (fs.existsSync(oldPath)) fs.unlink(oldPath, () => {});
  }
  setConfig('branding', {});
  audit(null, req.session.user.name, 'Removed the logo (reverted to letter mark)');
  res.json({ ok: true });
});

// ---------- custom fields ----------
const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select'];
app.get('/api/custom-fields', requireAuth, (req, res) => res.json({ fields: getConfig('customFields', DEFAULT_CUSTOM_FIELDS) }));
app.post('/api/custom-fields', requireRole('admin'), (req, res) => {
  const { label, type, required, options, placeholder } = req.body || {};
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'Field label is required' });
  if (!FIELD_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid field type' });
  let opts = [];
  if (type === 'select') {
    opts = (Array.isArray(options) ? options : String(options || '').split(',')).map(o => o.trim()).filter(Boolean);
    if (opts.length < 2) return res.status(400).json({ error: 'A dropdown field needs at least 2 options' });
  }
  const fields = getConfig('customFields', DEFAULT_CUSTOM_FIELDS);
  const field = {
    id: 'f_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'),
    label: String(label).trim(),
    type,
    required: !!required,
    options: opts,
    placeholder: String(placeholder || '').trim(),
  };
  fields.push(field);
  setConfig('customFields', fields);
  audit(null, req.session.user.name, `Added form field "${field.label}" (${field.type}${field.required ? ', required' : ''})`);
  res.json({ fields });
});
app.patch('/api/custom-fields/:id', requireRole('admin'), (req, res) => {
  const fields = getConfig('customFields', DEFAULT_CUSTOM_FIELDS);
  const f = fields.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Field not found' });
  const { label, type, required, options, placeholder } = req.body || {};
  if (label !== undefined) f.label = String(label).trim() || f.label;
  if (type !== undefined) { if (!FIELD_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid field type' }); f.type = type; }
  if (required !== undefined) f.required = !!required;
  if (placeholder !== undefined) f.placeholder = String(placeholder || '').trim();
  if (options !== undefined) {
    const opts = (Array.isArray(options) ? options : String(options || '').split(',')).map(o => o.trim()).filter(Boolean);
    if (f.type === 'select' && opts.length < 2) return res.status(400).json({ error: 'A dropdown field needs at least 2 options' });
    f.options = opts;
  }
  setConfig('customFields', fields);
  audit(null, req.session.user.name, `Updated form field "${f.label}"`);
  res.json({ fields });
});
app.delete('/api/custom-fields/:id', requireRole('admin'), (req, res) => {
  let fields = getConfig('customFields', DEFAULT_CUSTOM_FIELDS);
  const f = fields.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Field not found' });
  fields = fields.filter(x => x.id !== req.params.id);
  setConfig('customFields', fields);
  audit(null, req.session.user.name, `Removed form field "${f.label}" (existing requests keep their submitted values)`);
  res.json({ fields });
});

// ---------- print form layout (which fields appear, in what order) ----------
app.get('/api/print-layout', requireAuth, (req, res) => {
  res.json({
    layout: mergedPrintLayout(),
    standardFields: STANDARD_PRINT_FIELDS,
    customFields: getConfig('customFields', DEFAULT_CUSTOM_FIELDS).map(f => ({ id: f.id, label: f.label })),
  });
});
app.put('/api/print-layout', requireRole('admin'), (req, res) => {
  const layout = req.body.layout;
  if (!Array.isArray(layout)) return res.status(400).json({ error: 'Invalid layout' });
  const clean = [];
  for (const b of layout) {
    if (!['standard', 'custom', 'static', 'header'].includes(b.kind)) return res.status(400).json({ error: 'Invalid block kind' });
    const label = String(b.label || '').trim();
    if (!label) return res.status(400).json({ error: 'Every row needs a label' });
    const id = b.id && String(b.id).trim() ? String(b.id).trim() : (b.kind + '_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'));
    const clean_b = { id, kind: b.kind, label, visible: b.kind === 'header' ? true : !!b.visible };
    if (b.kind === 'standard' || b.kind === 'custom') clean_b.sourceKey = String(b.sourceKey || '');
    if (b.kind === 'static') clean_b.staticText = String(b.staticText || '').slice(0, 1000);
    clean.push(clean_b);
  }
  setConfig('printLayout', clean);
  audit(null, req.session.user.name, 'Updated print form layout (' + clean.length + ' rows)');
  res.json({ layout: mergedPrintLayout() });
});

// ---------- print form settings ----------
app.get('/api/print-settings', requireAuth, (req, res) => {
  res.json({ print: Object.assign({}, DEFAULT_PRINT, getConfig('print', {})) });
});
app.put('/api/print-settings', requireRole('admin'), (req, res) => {
  const p = req.body.print || {};
  const clean = {};
  for (const k of Object.keys(DEFAULT_PRINT)) {
    if (typeof DEFAULT_PRINT[k] === 'boolean') clean[k] = !!p[k];
    else clean[k] = String(p[k] == null ? DEFAULT_PRINT[k] : p[k]).slice(0, 500);
  }
  if (!clean.orgName.trim()) return res.status(400).json({ error: 'Organization name cannot be empty' });
  if (!clean.formTitle.trim()) return res.status(400).json({ error: 'Form title cannot be empty' });
  clean.logoInitial = (clean.logoInitial.trim() || clean.orgName.trim()[0]).slice(0, 2).toUpperCase();
  setConfig('print', clean);
  audit(null, req.session.user.name, 'Updated print form settings');
  res.json({ print: clean });
});

// ---------- Excel export (admin + finance + accountant) ----------
app.get('/api/export.xlsx', requireRole('admin', 'finance', 'accountant'), async (req, res) => {
  try {
    const rows = db.prepare(`SELECT json FROM requests ORDER BY created_at DESC`).all().map(x => JSON.parse(x.json));
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ACA Payment Workflow';
    const ws = wb.addWorksheet('Payment Requests', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Reference', key: 'id', width: 15 },
      { header: 'Request Date', key: 'created', width: 13 },
      { header: 'Status', key: 'status', width: 20 },
      { header: 'Requestor', key: 'requestor', width: 18 },
      { header: 'Department', key: 'dept', width: 14 },
      { header: 'Payee', key: 'payee', width: 22 },
      { header: 'Payment Type', key: 'ptype', width: 16 },
      { header: 'Method', key: 'method', width: 14 },
      { header: 'Amount', key: 'amount', width: 13 },
      { header: 'Currency', key: 'currency', width: 9 },
      { header: 'Description', key: 'desc', width: 36 },
      { header: 'Request #', key: 'reqno', width: 11 },
      { header: 'Voucher #', key: 'vouno', width: 11 },
      { header: 'Vendor #', key: 'venno', width: 11 },
      { header: 'Supervisor', key: 'sup', width: 22 },
      { header: 'Accountant', key: 'acc', width: 22 },
      { header: 'Budget Supervisor', key: 'bud', width: 22 },
      { header: 'Finance Manager', key: 'fin', width: 22 },
      { header: 'Completed', key: 'completed', width: 13 },
      { header: 'Rejected At / Reason', key: 'rej', width: 30 },
      { header: 'Budget Line', key: 'bline', width: 26 },
      { header: 'Payment Finalized', key: 'bfinal', width: 26 },
      { header: 'Budget Sync', key: 'bsync', width: 24 },
      { header: 'Custom Fields', key: 'custom', width: 34 },
      { header: 'Attachments', key: 'atts', width: 30 },
    ];
    const statusText = r =>
      r.status === 'approved' ? 'Approved' :
      r.status === 'rejected' ? 'Rejected' :
      r.status === 'cancelled' ? 'Cancelled' :
      'Awaiting ' + (STAGE_LABELS[r.status.slice(8)] || r.status);
    const apCell = (r, k) => {
      const ap = r.approvals && r.approvals[k];
      if (!ap) return '';
      if (ap.group && ap.votes) {
        const votes = Object.values(ap.votes).map(v => `${v.by}: ${v.decision} ${v.at.slice(0, 10)}`).join('; ');
        return `Team "${ap.name}" [${ap.decision || 'in progress'}] ${votes}`;
      }
      return `${ap.by}${ap.viaTeam ? ' (team ' + ap.viaTeam + ')' : ''} — ${ap.decision} ${ap.at.slice(0, 10)}`;
    };
    for (const r of rows) {
      ws.addRow({
        id: r.id,
        created: r.createdAt.slice(0, 10),
        status: statusText(r),
        requestor: r.requestorName,
        dept: r.department,
        payee: r.payeeName,
        ptype: r.paymentType + (r.paymentTypeOther ? ': ' + r.paymentTypeOther : ''),
        method: r.paymentMethod,
        amount: Number(r.amount),
        currency: r.currency,
        desc: r.description,
        reqno: r.financeUse.requestNo,
        vouno: r.financeUse.voucherNo,
        venno: r.financeUse.vendorNo,
        sup: apCell(r, 'supervisor'),
        acc: apCell(r, 'accountant'),
        bud: apCell(r, 'budget'),
        fin: apCell(r, 'finance'),
        completed: r.completedAt ? r.completedAt.slice(0, 10) : '',
        rej: r.status === 'rejected' ? `${r.rejectedStage}: ${r.rejectionReason}` : (r.status === 'cancelled' ? `Cancelled by ${r.cancelledBy}: ${r.cancellationReason}` : ''),
        bline: (budget.budgetLinesOf(r).length ? (budget.budgetLinesOf(r)[0].deptName ? budget.budgetLinesOf(r)[0].deptName + ': ' : '') + budget.budgetLinesOf(r).map(l => `${l.code} (${Number(l.amount).toFixed(3)})`).join(' + ') : ''),
        bfinal: r.paymentFinalized ? `${r.paymentFinalized.by} — ${r.paymentFinalized.at.slice(0, 10)}${r.paymentFinalized.paymentRef ? ' (Ref: ' + r.paymentFinalized.paymentRef + ')' : ''}` : '',
        bsync: r.budgetSync ? (r.budgetSync.status === 'synced' ? 'Synced: ' + ((r.budgetSync.results || []).map(x => x.sheet + ' r' + x.row).join('; ') || 'ok') : r.budgetSync.status + (r.budgetSync.error ? ': ' + r.budgetSync.error.slice(0, 60) : '')) : '',
        custom: (r.customFields || []).filter(f => f.value).map(f => `${f.label}: ${f.value}`).join('; '),
        atts: attachmentsFor(r.id).map(a => a.name).join(', '),
      });
    }
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFF1EEE4' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12283D' } };
    head.height = 20;
    ws.getColumn('amount').numFmt = '#,##0.000';
    ws.autoFilter = { from: 'A1', to: 'Y1' };
    // color-code status column
    ws.getColumn('status').eachCell((cell, rowNo) => {
      if (rowNo === 1) return;
      const v = String(cell.value || '');
      if (v === 'Approved') cell.font = { color: { argb: 'FF2F7D5A' }, bold: true };
      else if (v === 'Rejected') cell.font = { color: { argb: 'FFB0413E' }, bold: true };
      else cell.font = { color: { argb: 'FF8A6412' } };
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ACA_Payment_Requests_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
    audit(null, req.session.user.name, 'Exported requests to Excel (' + rows.length + ' rows)');
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ---------- email status (admin) ----------
app.get('/api/mail-status', requireRole('admin'), (req, res) => {
  res.json({ configured: mailConfigured(), from: mailFrom() });
});

// ---------- audit (admin) ----------
app.get('/api/audit', requireRole('admin'), (req, res) => {
  const rows = db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 500`).all();
  res.json({ audit: rows });
});

/* admin: download a consistent snapshot of the whole database (.db file).
   Uses SQLite's backup API so it captures everything including the WAL. */
app.get('/api/backup.db', requireRole('admin'), async (req, res) => {
  const tmp = path.join(DATA_DIR, `backup_${Date.now()}.db`);
  try {
    await backupTo(tmp);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    audit(null, req.session.user.name, 'Downloaded database backup');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="aca-payments-backup-${stamp}.db"`);
    const stream = fs.createReadStream(tmp);
    stream.pipe(res);
    stream.on('close', () => { try { fs.unlinkSync(tmp); } catch (e) {} });
    stream.on('error', () => { try { fs.unlinkSync(tmp); } catch (e) {} });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (!res.headersSent) res.status(500).json({ error: 'Backup failed: ' + e.message });
  }
});

// multer / general error handler
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(400).json({ error: err.message || 'Request failed' });
});

const seeded = seedAdmin();
app.listen(PORT, () => {
  console.log(`ACA Payment Workflow running on port ${PORT}`);
  if (seeded) {
    console.log(`\n*** First run: admin account created ***`);
    console.log(`    name: ${seeded.name}`);
    console.log(`    password: ${seeded.password}`);
    console.log(`    (set ADMIN_PASSWORD env var to control this; change it after first login)\n`);
  }
});
