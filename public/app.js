/* ============ API layer ============ */
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, Object.assign({ headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' } }, opts));
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
  return data;
}

/* ============ app state ============ */
const STAGE_DEFS = { supervisor: { label: 'Supervisor' }, accountant: { label: 'Accountant' }, budget: { label: 'Budget Supervisor' }, finance: { label: 'Finance Manager' } };
const STAGE_ORDER = ['supervisor', 'accountant', 'budget', 'finance'];
const ROLE_LABELS = { requestor: 'Requestor', supervisor: 'Supervisor', accountant: 'Accountant', budget: 'Budget Supervisor', finance: 'Finance Manager', admin: 'Administrator' };

function chainFor(r) { return r.chain && r.chain.length ? r.chain : STAGE_ORDER; }
function currentStageKey(r) { return r.status.startsWith('pending_') ? r.status.slice(8) : null; }
function stageLabel(k) { return STAGE_DEFS[k] ? STAGE_DEFS[k].label : k; }

let state = { user: null, tab: 'dashboard', openId: null, adminTab: 'overview', filter: 'all' };
let pendingFiles = [];
let cache = { requests: [], users: [], workflow: null, routing: [] };

function fmtDate(iso) { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
function fmtMoney(a, c) { return (c || '') + ' ' + Number(a || 0).toLocaleString(undefined, { minimumFractionDigits: 2 }); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
/* normalize a request's budget selection (supports legacy single-line and new split shape) */
function blOf(r) {
  if (r && Array.isArray(r.budgetLines) && r.budgetLines.length) return r.budgetLines;
  if (r && r.budget && r.budget.code) return [Object.assign({ amount: Number(r.amount || 0) }, r.budget)];
  return [];
}
function blHasBudget(r) { return blOf(r).length > 0; }

async function refreshRequests() { cache.requests = (await api('/requests')).requests; }

async function applyBranding() {
  let b = { orgName: 'Sama Educational Co.', logoInitial: 'S', hasLogo: false };
  try { b = await api('/branding'); } catch (e) {}
  cache.branding = b;
  const h1 = document.querySelector('.brand-text h1');
  if (h1) h1.textContent = b.orgName;
  const mark = document.querySelector('.brand-mark');
  if (mark) {
    mark.innerHTML = b.hasLogo ? `<img src="/api/logo?t=${Date.now()}" alt="logo" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : esc(b.logoInitial || b.orgName[0] || 'S');
  }
}

/* ============ render root ============ */
async function render() {
  const app = document.getElementById('app');
  const whoBox = document.getElementById('whoBox');
  if (!state.user) {
    whoBox.innerHTML = '';
    app.innerHTML = loginScreen();
    bindLogin();
    return;
  }
  const canSign = ['supervisor', 'accountant', 'budget', 'finance'].includes(state.user.role);
  whoBox.innerHTML = `
    <span class="role-badge">${esc(ROLE_LABELS[state.user.role])}</span>
    <span style="font-size:13px;">${esc(state.user.name)}</span>
    ${canSign ? '<button id="sigBtn" title="My signature & stamp">🖋</button>' : ''}
    <button id="pwBtn" title="Change password">🔑</button>
    <button id="logoutBtn">Log out</button>
  `;
  document.getElementById('logoutBtn').onclick = async () => { await api('/logout', { method: 'POST' }); state.user = null; render(); };
  document.getElementById('pwBtn').onclick = () => { state.tab = 'password'; state.openId = null; render(); };
  const sigBtn = document.getElementById('sigBtn');
  if (sigBtn) sigBtn.onclick = () => { state.tab = 'signature'; state.openId = null; render(); };

  if (state.tab === 'signature') { app.innerHTML = signatureScreen(); bindSignatureScreen(); return; }

  if (state.tab === 'password') { app.innerHTML = passwordScreen(); bindPassword(); return; }

  if (state.openId) {
    app.innerHTML = await drawerWrap();
    bindDrawer();
    return;
  }
  if (state.user.role === 'requestor') { app.innerHTML = await requestorView(); bindRequestor(); }
  else if (state.user.role === 'admin') { app.innerHTML = await adminView(); bindAdmin(); }
  else { app.innerHTML = await approverView(); bindApprover(); }
}

/* ============ LOGIN ============ */
function loginScreen() {
  return `
  <div class="login-screen">
    <div class="login-card">
      <h2>Sign in</h2>
      <p class="sub">Log in with the account the administrator created for you.</p>
      <div class="field"><label>Name</label><input id="nameInput" autocomplete="username"></div>
      <div class="field"><label>Password</label><input id="passInput" type="password" autocomplete="current-password"></div>
      <div class="err hidden" id="loginErr"></div>
      <button class="btn gold block" id="loginBtn">Log in</button>
      <div class="demo-note">
        Your role (Requestor, Accountant, Budget Supervisor, Finance Manager or Administrator)
        is attached to your account — there is nothing to select here. If you don't have an
        account or forgot your password, contact the administrator.
      </div>
    </div>
  </div>`;
}
function bindLogin() {
  const go = async () => {
    const errEl = document.getElementById('loginErr');
    try {
      const { user } = await api('/login', { method: 'POST', body: JSON.stringify({ name: document.getElementById('nameInput').value.trim(), password: document.getElementById('passInput').value }) });
      state.user = user;
      state.tab = user.mustChangePassword ? 'password' : 'dashboard';
      state.adminTab = 'overview';
      render();
    } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  };
  document.getElementById('loginBtn').onclick = go;
  document.getElementById('passInput').onkeydown = e => { if (e.key === 'Enter') go(); };
}

/* ============ CHANGE PASSWORD ============ */
function signatureScreen() {
  const uid = state.user.id;
  const box = (kind, label) => `
    <div class="form-card" style="margin-bottom:16px;">
      <h3 class="serif" style="margin:0 0 6px;color:var(--navy-deep);font-size:16px;">${label}</h3>
      <p style="font-size:12.5px;color:var(--ink-soft);margin:0 0 12px;">Shown on the printed form next to your name once you approve a request. PNG with a transparent background works best. Max 2 MB.</p>
      <div style="display:flex;align-items:center;gap:16px;">
        <div id="${kind}Preview" style="width:180px;height:80px;border:1px dashed var(--line);border-radius:8px;display:flex;align-items:center;justify-content:center;background:#FCFBF7;color:var(--ink-soft);font-size:12px;overflow:hidden;">none</div>
        <div>
          <input type="file" id="${kind}File" accept="image/png,image/jpeg,image/webp" style="display:none;">
          <button class="btn outline" id="${kind}UploadBtn" style="margin-bottom:6px;">Upload ${label.toLowerCase()}</button><br>
          <button class="btn danger" id="${kind}RemoveBtn" style="display:none;">Remove</button>
        </div>
      </div>
    </div>`;
  return `
    <div style="max-width:640px;margin:0 auto;">
      <div class="page-head"><div><h2>My Signature &amp; Stamp</h2><p>These appear on printed forms after your approvals.</p></div>
        <button class="btn outline" id="sigBack">← Back</button></div>
      ${box('signature', 'Signature')}
      ${box('stamp', 'Stamp')}
      <div class="err hidden" id="sigErr"></div>
    </div>`;
}
function bindSignatureScreen() {
  document.getElementById('sigBack').onclick = () => { state.tab = 'dashboard'; render(); };
  const uid = state.user.id;
  const refresh = async () => {
    let s = { hasSignature: false, hasStamp: false };
    try { s = await api('/me/signature'); } catch (e) {}
    ['signature', 'stamp'].forEach(kind => {
      const has = kind === 'signature' ? s.hasSignature : s.hasStamp;
      const prev = document.getElementById(kind + 'Preview');
      const rm = document.getElementById(kind + 'RemoveBtn');
      if (has) {
        prev.innerHTML = `<img src="/api/signature/${uid}/${kind}?t=${Date.now()}" style="max-width:100%;max-height:100%;object-fit:contain;">`;
        rm.style.display = 'inline-block';
      } else { prev.textContent = 'none'; rm.style.display = 'none'; }
    });
  };
  ['signature', 'stamp'].forEach(kind => {
    const f = document.getElementById(kind + 'File');
    document.getElementById(kind + 'UploadBtn').onclick = () => f.click();
    f.onchange = async () => {
      if (!f.files[0]) return;
      const fd = new FormData(); fd.append('image', f.files[0], f.files[0].name);
      try { await api('/me/' + kind, { method: 'POST', body: fd }); refresh(); }
      catch (e) { const el = document.getElementById('sigErr'); el.textContent = e.message; el.classList.remove('hidden'); }
    };
    document.getElementById(kind + 'RemoveBtn').onclick = async () => {
      await api('/me/' + kind, { method: 'DELETE' }); refresh();
    };
  });
  refresh();
}

function passwordScreen() {
  return `
  <div class="login-screen">
    <div class="login-card">
      <h2>${state.user.mustChangePassword ? 'Set your password' : 'Change password'}</h2>
      <p class="sub">${state.user.mustChangePassword ? 'Your password was set by the administrator — choose your own before continuing.' : 'Pick a new password (minimum 8 characters).'}</p>
      <div class="field"><label>Current password</label><input id="curPw" type="password" autocomplete="current-password"></div>
      <div class="field"><label>New password (min 8 chars)</label><input id="newPw" type="password" autocomplete="new-password"></div>
      <div class="field"><label>Repeat new password</label><input id="newPw2" type="password" autocomplete="new-password"></div>
      <div class="err hidden" id="pwErr"></div>
      <button class="btn gold block" id="savePwBtn">Save password</button>
      ${state.user.mustChangePassword ? '' : '<button class="btn outline block" id="cancelPwBtn" style="margin-top:8px;">Cancel</button>'}
    </div>
  </div>`;
}
function bindPassword() {
  const errEl = document.getElementById('pwErr');
  document.getElementById('savePwBtn').onclick = async () => {
    const np = document.getElementById('newPw').value;
    if (np !== document.getElementById('newPw2').value) { errEl.textContent = 'New passwords do not match.'; errEl.classList.remove('hidden'); return; }
    try {
      await api('/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: document.getElementById('curPw').value, newPassword: np }) });
      state.user.mustChangePassword = false;
      state.tab = 'dashboard';
      render();
    } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  };
  const c = document.getElementById('cancelPwBtn');
  if (c) c.onclick = () => { state.tab = 'dashboard'; render(); };
}

/* ============ REQUESTOR VIEW ============ */
async function requestorView() {
  await refreshRequests();
  let fields = [];
  let budgetMeta = { departments: [], required: false };
  if (state.tab === 'new') {
    try { fields = (await api('/custom-fields')).fields; } catch (e) {}
    try { budgetMeta = await api('/budget/departments/mine'); } catch (e) { budgetMeta = { departments: [], required: false, error: e.message }; }
  }
  return `
    <div class="page-head">
      <div><h2>My Payment Requests</h2><p>Submit a new request or track approvals in progress.</p></div>
      <button class="btn gold" id="newReqBtn">+ New Payment Request</button>
    </div>
    ${state.tab === 'new' ? newRequestForm(fields, budgetMeta) : listCards(cache.requests)}
  `;
}
function bindRequestor() {
  const btn = document.getElementById('newReqBtn');
  if (btn) btn.onclick = () => { state.tab = state.tab === 'new' ? 'dashboard' : 'new'; render(); };
  if (state.tab === 'new') bindNewRequestForm();
  bindCardOpens();
}

function newRequestForm(fields, budgetMeta) {
  fields = fields || [];
  budgetMeta = budgetMeta || { departments: [], required: false };
  const depts = budgetMeta.departments || [];
  const budgetSection = !depts.length ? (budgetMeta.error ? `
    <div class="section-title">Budget Line</div>
    <div class="err">Budget unavailable: ${esc(budgetMeta.error)}.</div>` : '') : `
    <div class="section-title">Budget ${budgetMeta.required ? '<span style="color:var(--red);">*</span>' : '(optional)'}</div>
    <div class="field">
      <label>Department</label>
      <select id="f_budget_dept">
        <option value="">— Select department —</option>
        ${depts.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}
      </select>
    </div>
    <div id="budgetSplitArea" style="display:none;">
      <div class="field">
        <label>Budget lines — allocate the amount across one or more lines in this department</label>
        <div id="splitRows"></div>
        <button type="button" class="btn outline" id="addSplitRow" style="margin-top:6px;">+ Add budget line</button>
      </div>
      <div id="splitSummary" style="font-size:13px;margin-top:6px;"></div>
    </div>
  `;
  const renderField = f => {
    const req = f.required ? '<span style="color:var(--red);">*</span>' : '';
    const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
    let input;
    if (f.type === 'textarea') input = `<textarea id="cf_${f.id}" rows="2"${ph}></textarea>`;
    else if (f.type === 'select') input = `<select id="cf_${f.id}"><option value="">— Select —</option>${f.options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`;
    else input = `<input id="cf_${f.id}" type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}"${ph}>`;
    return `<div class="field" data-cf-required="${f.required ? '1' : ''}" data-cf-label="${esc(f.label)}"><label>${esc(f.label)} ${req}</label>${input}</div>`;
  };
  return `
  <div class="form-card">
    <h3 class="serif" style="margin-top:0;color:var(--navy-deep);">New Payment Request</h3>
    <div class="section-title">Requestor Details</div>
    <div class="form-grid">
      <div class="field"><label>Department</label><input id="f_dept" placeholder="e.g. IT"></div>
      <div class="field"><label>Requestor Name</label><input id="f_reqname" value="${esc(state.user.name)}" disabled></div>
      <div class="field"><label>Phone</label><input id="f_reqphone"></div>
    </div>
    <div class="section-title">Payee Details</div>
    <div class="form-grid">
      <div class="field"><label>Payee Name</label><input id="f_payee"></div>
      <div class="field"><label>Address</label><input id="f_payeeaddr"></div>
      <div class="field"><label>Phone</label><input id="f_payeephone"></div>
    </div>
    <div class="section-title">Payment Type</div>
    <div class="field radio-set">
      <label><input type="radio" name="ptype" value="Supplier Payment" checked> Supplier Payment</label>
      <label><input type="radio" name="ptype" value="Petty Cash"> Petty Cash</label>
      <label><input type="radio" name="ptype" value="Other"> Other</label>
    </div>
    <div class="field" id="ptypeOtherWrap" style="display:none;"><input id="f_ptypeOther" placeholder="Specify other payment type"></div>
    <div class="section-title">Payment Method</div>
    <div class="field radio-set">
      <label><input type="radio" name="pmethod" value="Cheque" checked> Cheque</label>
      <label><input type="radio" name="pmethod" value="Bank Transfer"> Bank Transfer (international only)</label>
    </div>
    <div class="section-title">Payment Details</div>
    <div class="form-grid">
      <div class="field"><label>Amount</label><input id="f_amount" type="number" step="0.001" placeholder="0.00"></div>
      <div class="field"><label>Currency <span id="curReq" style="color:var(--red);"></span></label><input id="f_currency" placeholder="KWD"></div>
    </div>
    <div class="section-title">Payment Description</div>
    <div class="field"><textarea id="f_desc" rows="3" placeholder="What is this payment for?"></textarea></div>
    ${budgetSection}
    ${fields.length ? `
    <div class="section-title">Additional Information</div>
    <div class="form-grid" id="customFieldsWrap">${fields.map(renderField).join('')}</div>
    ` : ''}
    <div class="section-title">Documents Enclosed — Attach Files</div>
    <div class="dropzone" id="dropzone">
      <b>Click to attach</b> or drag files here<br>
      <span style="font-size:11.5px;">Invoices, quotations, receipts — PDF or images (JPG/PNG), max 10 MB each</span>
    </div>
    <input type="file" id="fileInput" multiple accept="application/pdf,image/jpeg,image/png,image/webp" style="display:none;">
    <div class="attach-list" id="attachList"></div>
    <div class="field"><label>Additional document notes (optional)</label></div>
    <div id="docRows">
      <div class="doc-row"><input placeholder="e.g. Original invoice to follow by courier"><button type="button" onclick="this.parentElement.remove()">✕</button></div>
    </div>
    <button type="button" class="btn outline" id="addDocBtn" style="margin-bottom:20px;">+ Add note</button>
    <div class="err hidden" id="formErr" style="margin-top:6px;"></div>
    <div style="display:flex;gap:10px;margin-top:8px;">
      <button class="btn gold" id="submitReqBtn">Submit Request</button>
      <button class="btn outline" id="cancelReqBtn">Cancel</button>
    </div>
  </div>`;
}
function bindNewRequestForm() {
  pendingFiles = [];
  document.querySelectorAll('input[name=ptype]').forEach(r => r.onchange = () => {
    document.getElementById('ptypeOtherWrap').style.display = document.querySelector('input[name=ptype]:checked').value === 'Other' ? 'block' : 'none';
  });
  document.querySelectorAll('input[name=pmethod]').forEach(r => r.onchange = () => {
    document.getElementById('curReq').textContent = document.querySelector('input[name=pmethod]:checked').value === 'Bank Transfer' ? '(required)' : '';
  });
  /* ---- budget: department + multi-line split ---- */
  window._splitState = { deptId: '', lines: [], rows: [] }; // rows: [{code, amount}]
  const deptSel = document.getElementById('f_budget_dept');
  const splitArea = document.getElementById('budgetSplitArea');
  const splitRows = document.getElementById('splitRows');
  const amtInput = document.getElementById('f_amount');

  const renderSplitRows = () => {
    if (!splitRows) return;
    const opts = window._splitState.lines;
    splitRows.innerHTML = window._splitState.rows.map((row, i) => `
      <div style="display:flex;gap:8px;margin-bottom:6px;align-items:center;">
        <input class="split-code" data-i="${i}" list="deptLineOptions" autocomplete="off" value="${esc(row.code)}" placeholder="🔍 Search line…" style="flex:2;">
        <input class="split-amt" data-i="${i}" type="number" step="0.001" value="${row.amount || ''}" placeholder="Amount" style="width:120px;">
        <button type="button" class="mini-btn del split-del" data-i="${i}">✕</button>
      </div>`).join('') +
      `<datalist id="deptLineOptions">${opts.map(l => `<option data-code="${esc(l.code)}" value="${esc(l.code)} — ${esc(l.description)} (Avail: ${l.available.toLocaleString(undefined, { minimumFractionDigits: 3 })} KD)"></option>`).join('')}</datalist>`;
    splitRows.querySelectorAll('.split-code').forEach(inp => inp.oninput = () => {
      const opts2 = Array.from(splitRows.querySelectorAll('#deptLineOptions option'));
      const m = opts2.find(o => o.value === inp.value) || opts2.find(o => inp.value && o.dataset.code && inp.value.toLowerCase().startsWith(o.dataset.code.toLowerCase()));
      window._splitState.rows[Number(inp.dataset.i)].code = m ? m.dataset.code : inp.value.trim();
      updateSplitSummary();
    });
    splitRows.querySelectorAll('.split-amt').forEach(inp => inp.oninput = () => {
      window._splitState.rows[Number(inp.dataset.i)].amount = inp.value;
      updateSplitSummary();
    });
    splitRows.querySelectorAll('.split-del').forEach(btn => btn.onclick = () => {
      window._splitState.rows.splice(Number(btn.dataset.i), 1); renderSplitRows(); updateSplitSummary();
    });
  };
  const updateSplitSummary = () => {
    const el = document.getElementById('splitSummary');
    if (!el) return;
    const total = Number((amtInput || {}).value || 0);
    const sum = window._splitState.rows.reduce((a, r) => a + Number(r.amount || 0), 0);
    const diff = total - sum;
    const findAvail = code => { const l = window._splitState.lines.find(x => x.code === code); return l ? l.available : null; };
    let over = window._splitState.rows.filter(r => { const a = findAvail(r.code); return a !== null && Number(r.amount) > a; });
    el.innerHTML =
      `Allocated <b>${sum.toLocaleString(undefined, { minimumFractionDigits: 3 })}</b> of request total <b>${total.toLocaleString(undefined, { minimumFractionDigits: 3 })}</b> KD. ` +
      (Math.abs(diff) < 0.0005
        ? '<span style="color:var(--green);font-weight:600;">✓ balanced</span>'
        : `<span style="color:var(--red);font-weight:600;">${diff > 0 ? diff.toLocaleString(undefined, { minimumFractionDigits: 3 }) + ' KD unallocated' : Math.abs(diff).toLocaleString(undefined, { minimumFractionDigits: 3 }) + ' KD over the total'}</span>`) +
      (over.length ? `<br><span style="color:var(--red);">⚠ ${over.map(r => r.code).join(', ')} exceed available balance.</span>` : '');
  };
  const loadDeptLines = async (deptId) => {
    window._splitState.deptId = deptId;
    window._splitState.lines = [];
    window._splitState.rows = [];
    if (!deptId) { if (splitArea) splitArea.style.display = 'none'; return; }
    try {
      const data = await api('/budget/lines?dept=' + encodeURIComponent(deptId));
      window._splitState.lines = data.lines || [];
    } catch (e) { window._splitState.lines = []; }
    // start with a single row pre-filled to the full amount for the common case
    window._splitState.rows = [{ code: '', amount: (amtInput || {}).value || '' }];
    if (splitArea) splitArea.style.display = 'block';
    renderSplitRows(); updateSplitSummary();
  };
  if (deptSel) deptSel.onchange = () => loadDeptLines(deptSel.value);
  const addSplitBtn = document.getElementById('addSplitRow');
  if (addSplitBtn) addSplitBtn.onclick = () => { window._splitState.rows.push({ code: '', amount: '' }); renderSplitRows(); updateSplitSummary(); };
  if (amtInput) amtInput.addEventListener('input', updateSplitSummary);
  const dz = document.getElementById('dropzone');
  const fi = document.getElementById('fileInput');
  dz.onclick = () => fi.click();
  dz.ondragover = e => { e.preventDefault(); dz.classList.add('drag'); };
  dz.ondragleave = () => dz.classList.remove('drag');
  dz.ondrop = e => { e.preventDefault(); dz.classList.remove('drag'); addFiles(e.dataTransfer.files); };
  fi.onchange = () => { addFiles(fi.files); fi.value = ''; };

  function addFiles(fileList) {
    const errEl = document.getElementById('formErr');
    Array.from(fileList).forEach(f => {
      const okType = /^(application\/pdf|image\/(jpeg|png|webp))$/.test(f.type);
      if (!okType) { errEl.textContent = f.name + ': only PDF, JPG, PNG or WEBP files can be attached.'; errEl.classList.remove('hidden'); return; }
      if (f.size > 10 * 1024 * 1024) { errEl.textContent = f.name + ' is larger than 10 MB.'; errEl.classList.remove('hidden'); return; }
      pendingFiles.push(f);
      renderAttachList();
    });
  }
  function renderAttachList() {
    const list = document.getElementById('attachList');
    if (!list) return;
    list.innerHTML = pendingFiles.map((f, i) => `
      <div class="attach-item">
        <div class="aicon">${f.type.startsWith('image/') ? '🖼' : '📄'}</div>
        <div class="aname">${esc(f.name)}</div>
        <div class="asize">${(f.size / 1024).toFixed(0)} KB</div>
        <button type="button" class="aremove" data-i="${i}">✕</button>
      </div>`).join('');
    list.querySelectorAll('.aremove').forEach(b => b.onclick = () => { pendingFiles.splice(Number(b.dataset.i), 1); renderAttachList(); });
  }

  document.getElementById('addDocBtn').onclick = () => {
    const row = document.createElement('div');
    row.className = 'doc-row';
    row.innerHTML = `<input placeholder="Document note"><button type="button" onclick="this.parentElement.remove()">✕</button>`;
    document.getElementById('docRows').appendChild(row);
  };
  document.getElementById('cancelReqBtn').onclick = () => { state.tab = 'dashboard'; pendingFiles = []; render(); };
  document.getElementById('submitReqBtn').onclick = async () => {
    const errEl = document.getElementById('formErr');
    /* validate required custom fields client-side (server re-validates too) */
    const cfWrap = document.getElementById('customFieldsWrap');
    const customFieldValues = {};
    if (cfWrap) {
      for (const fieldDiv of cfWrap.querySelectorAll('[data-cf-label]')) {
        const input = fieldDiv.querySelector('input,select,textarea');
        const val = input.value.trim();
        if (fieldDiv.dataset.cfRequired === '1' && !val) {
          errEl.textContent = 'Please fill in "' + fieldDiv.dataset.cfLabel + '"';
          errEl.classList.remove('hidden');
          return;
        }
        customFieldValues[input.id.slice(3)] = val;
      }
    }
    const pmethod = document.querySelector('input[name=pmethod]:checked').value;
    const fd = new FormData();
    fd.append('department', document.getElementById('f_dept').value.trim());
    fd.append('requestorPhone', document.getElementById('f_reqphone').value.trim());
    fd.append('payeeName', document.getElementById('f_payee').value.trim());
    fd.append('payeeAddress', document.getElementById('f_payeeaddr').value.trim());
    fd.append('payeePhone', document.getElementById('f_payeephone').value.trim());
    fd.append('paymentType', document.querySelector('input[name=ptype]:checked').value);
    fd.append('paymentTypeOther', document.getElementById('f_ptypeOther') ? document.getElementById('f_ptypeOther').value.trim() : '');
    fd.append('paymentMethod', pmethod);
    fd.append('amount', document.getElementById('f_amount').value.trim());
    fd.append('currency', document.getElementById('f_currency').value.trim() || 'KWD');
    fd.append('description', document.getElementById('f_desc').value.trim());
    fd.append('documents', JSON.stringify(Array.from(document.querySelectorAll('#docRows input')).map(i => i.value.trim()).filter(Boolean)));
    fd.append('customFieldValues', JSON.stringify(customFieldValues));
    if (window._splitState && window._splitState.deptId) {
      const rows = window._splitState.rows.filter(r => r.code && Number(r.amount) > 0);
      if (rows.length) {
        const sum = rows.reduce((a, r) => a + Number(r.amount), 0);
        const total = Number(document.getElementById('f_amount').value || 0);
        if (Math.abs(sum - total) > 0.0005) {
          errEl.textContent = `Budget split (${sum.toFixed(3)}) must equal the request amount (${total.toFixed(3)}).`;
          errEl.classList.remove('hidden');
          return;
        }
        fd.append('budgetDept', window._splitState.deptId);
        fd.append('budgetLines', JSON.stringify(rows.map(r => ({ deptId: window._splitState.deptId, code: r.code, amount: Number(r.amount) }))));
      }
    }
    pendingFiles.forEach(f => fd.append('files', f, f.name));
    const sb = document.getElementById('submitReqBtn');
    sb.disabled = true; sb.textContent = 'Submitting…';
    try {
      await api('/requests', { method: 'POST', body: fd });
      pendingFiles = [];
      state.tab = 'dashboard';
      render();
    } catch (e) {
      sb.disabled = false; sb.textContent = 'Submit Request';
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    }
  };
}

/* ============ APPROVER VIEW ============ */
function assignedToMe(r, stageKey) {
  const a = r.assigned && r.assigned[stageKey];
  if (!a) return true;
  if (a.type === 'group') {
    if (!(a.members || []).some(m => m.id === state.user.id)) return false;
    if (a.policy === 'all') {
      const ap = r.approvals[stageKey];
      if (ap && ap.votes && ap.votes[state.user.id]) return false; // already voted
    }
    return true;
  }
  return a.id === state.user.id;
}
function iParticipated(r, stageKey) {
  const ap = r.approvals && r.approvals[stageKey];
  if (!ap) return false;
  if (ap.votes) return !!ap.votes[state.user.id];
  return ap.byId === state.user.id;
}
async function approverView() {
  await refreshRequests();
  const all = cache.requests;
  const label = stageLabel(state.user.role);
  const pending = all.filter(r => r.status === 'pending_' + state.user.role && assignedToMe(r, state.user.role));
  const others = all.filter(r => r.status === 'pending_' + state.user.role && !assignedToMe(r, state.user.role));
  const reviewed = all.filter(r => iParticipated(r, state.user.role));
  const approvedAll = all.filter(r => r.status === 'approved');
  const toFinalize = all.filter(r => r.status === 'approved' && blHasBudget(r) && !r.paymentFinalized);
  const isAccountant = state.user.role === 'accountant';
  const isBudget = state.user.role === 'budget';
  return `
    <div class="page-head">
      <div><h2>${label} Queue</h2><p>Requests waiting on your review, and ones you've already actioned.</p></div>
      ${(state.user.role === 'accountant' || state.user.role === 'finance') ? `<a class="btn outline" href="/api/export.xlsx" style="text-decoration:none;">📥 Export to Excel</a>` : ''}
    </div>
    <div class="tabs">
      <div class="tab ${state.tab !== 'reviewed' && state.tab !== 'print_ready' && state.tab !== 'finalize_queue' && state.tab !== 'budget_view' ? 'active' : ''}" data-tab="pending">Pending your approval (${pending.length})</div>
      <div class="tab ${state.tab === 'reviewed' ? 'active' : ''}" data-tab="reviewed">Already reviewed by you (${reviewed.length})</div>
      ${isAccountant ? `<div class="tab ${state.tab === 'print_ready' ? 'active' : ''}" data-tab="print_ready">🖨 Ready to print (${approvedAll.length})</div>` : ''}
      ${isAccountant ? `<div class="tab ${state.tab === 'finalize_queue' ? 'active' : ''}" data-tab="finalize_queue">💳 Finalize Payment (${toFinalize.length})</div>` : ''}
      ${isBudget ? `<div class="tab ${state.tab === 'budget_view' ? 'active' : ''}" data-tab="budget_view">💰 Budget</div>` : ''}
    </div>
    ${state.tab === 'reviewed' ? listCards(reviewed)
      : state.tab === 'print_ready' && isAccountant ? `
        <p style="font-size:13px;color:var(--ink-soft);margin:-6px 0 14px;">Fully approved requests — open one and use <b>Print Form</b> to produce the completed form for the final physical signature and filing.</p>
        ${listCards(approvedAll)}`
      : state.tab === 'finalize_queue' && isAccountant ? `
        <p style="font-size:13px;color:var(--ink-soft);margin:-6px 0 14px;">Fully approved, budget-linked requests still <b>reserved but not deducted</b>. Open one and finalize the payment once it's actually issued — that's what writes the PRQ into the budget tracking sheet.</p>
        ${listCards(toFinalize)}`
      : state.tab === 'budget_view' && isBudget ? `<div id="budgetViewMount"><div class="empty">Loading budget lines…</div></div>`
      : `${listCards(pending)}
         ${others.length ? `<p style="font-size:12.5px;color:var(--ink-soft);margin-top:14px;">${others.length} other request${others.length > 1 ? 's' : ''} at the ${label} stage ${others.length > 1 ? 'are' : 'is'} assigned to a different ${label.toLowerCase()} and won't appear in your queue.</p>` : ''}`
    }
  `;
}
function bindApprover() {
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    state.tab = ['reviewed', 'print_ready', 'finalize_queue', 'budget_view'].includes(t.dataset.tab) ? t.dataset.tab : 'dashboard';
    render();
  });
  bindCardOpens();
  if (state.tab === 'budget_view') mountBudgetTable('budgetViewMount');
}

/* shared searchable read-only budget lines table (used by budget supervisor + reused elsewhere) */
async function mountBudgetTable(mountId) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  let info;
  try { info = await api('/budget/lines'); } catch (e) { mount.innerHTML = `<div class="err">Could not load budget lines: ${esc(e.message)}</div>`; return; }
  if (!info.lines || !info.lines.length) { mount.innerHTML = '<div class="empty">No budget lines available' + (info.errors && info.errors.length ? ': ' + esc(info.errors.map(x => x.dept + ' — ' + x.error).join('; ')) : '.') + '</div>'; return; }
  cache._budgetLines = info.lines;
  const draw = (filter) => {
    const q = (filter || '').toLowerCase().trim();
    const rows = cache._budgetLines.filter(l => !q || l.code.toLowerCase().includes(q) || (l.description || '').toLowerCase().includes(q) || (l.deptName || '').toLowerCase().includes(q) || (l.trackerSheet || '').toLowerCase().includes(q));
    document.getElementById('budgetTableWrap').innerHTML = `
      <table class="admin-table">
        <tr><th>Dept</th><th>Code</th><th>Description</th><th style="text-align:right;">Budget</th><th style="text-align:right;">Utilized</th><th style="text-align:right;">Held</th><th style="text-align:right;">Available</th></tr>
        ${rows.map(l => `
        <tr>
          <td style="font-size:12px;color:var(--ink-soft);">${esc(l.deptName || '')}</td>
          <td class="mono"><b>${esc(l.code)}</b></td>
          <td>${esc(l.description)}</td>
          <td style="text-align:right;" class="mono">${l.budget.toLocaleString(undefined, { minimumFractionDigits: 3 })}</td>
          <td style="text-align:right;" class="mono">${l.utilized.toLocaleString(undefined, { minimumFractionDigits: 3 })}</td>
          <td style="text-align:right;" class="mono">${l.held ? l.held.toLocaleString(undefined, { minimumFractionDigits: 3 }) : '—'}</td>
          <td style="text-align:right;" class="mono" ${l.available <= 0 ? 'style="text-align:right;color:var(--red);font-weight:700;"' : ''}>${l.available.toLocaleString(undefined, { minimumFractionDigits: 3 })}</td>
        </tr>`).join('')}
      </table>
      ${rows.length ? '' : '<div class="empty">No lines match your search.</div>'}`;
  };
  mount.innerHTML = `
    <div class="field" style="max-width:420px;margin-bottom:12px;"><input id="budgetSearch" placeholder="🔍 Search by department, code or description…"></div>
    <div id="budgetTableWrap"></div>`;
  document.getElementById('budgetSearch').oninput = e => draw(e.target.value);
  draw('');
}

/* ============ ADMIN PORTAL ============ */
async function adminView() {
  const tabs = `
    <div class="tabs">
      <div class="tab ${state.adminTab === 'overview' ? 'active' : ''}" data-atab="overview">📊 Track Requests</div>
      <div class="tab ${state.adminTab === 'users' ? 'active' : ''}" data-atab="users">👥 User Management</div>
      <div class="tab ${state.adminTab === 'workflow' ? 'active' : ''}" data-atab="workflow">⚙ Workflow Settings</div>
      <div class="tab ${state.adminTab === 'fields' ? 'active' : ''}" data-atab="fields">📝 Form Fields</div>
      <div class="tab ${state.adminTab === 'budget' ? 'active' : ''}" data-atab="budget">💰 Budget</div>
      <div class="tab ${state.adminTab === 'printform' ? 'active' : ''}" data-atab="printform">🖨 Print Form</div>
      <div class="tab ${state.adminTab === 'audit' ? 'active' : ''}" data-atab="audit">📜 Audit Log</div>
    </div>`;
  let body = '';
  if (state.adminTab === 'users') body = await adminUsers();
  else if (state.adminTab === 'workflow') body = await adminWorkflow();
  else if (state.adminTab === 'fields') body = await adminFields();
  else if (state.adminTab === 'budget') body = await adminBudget();
  else if (state.adminTab === 'printform') body = await adminPrintForm();
  else if (state.adminTab === 'audit') body = await adminAudit();
  else body = await adminOverview();
  return `
    <div class="page-head">
      <div><h2>Administration</h2><p>Track every request, manage user accounts, and configure the approval workflow.</p></div>
    </div>
    ${tabs}${body}`;
}

async function adminOverview() {
  await refreshRequests();
  let mail = { configured: false, from: null };
  try { mail = await api('/mail-status'); } catch (e) {}
  const all = cache.requests;
  const byStage = k => all.filter(r => r.status === 'pending_' + k).length;
  const approved = all.filter(r => r.status === 'approved');
  const rejected = all.filter(r => r.status === 'rejected');
  const cancelled = all.filter(r => r.status === 'cancelled');
  const approvedTotal = approved.reduce((s, r) => s + Number(r.amount || 0), 0);
  const pendingTotal = all.filter(r => r.status.startsWith('pending_')).reduce((s, r) => s + Number(r.amount || 0), 0);
  const filters = [
    ['all', 'All (' + all.length + ')'],
    ['pending_supervisor', 'Awaiting Supervisor (' + byStage('supervisor') + ')'],
    ['pending_accountant', 'Awaiting Accountant (' + byStage('accountant') + ')'],
    ['pending_budget', 'Awaiting Budget (' + byStage('budget') + ')'],
    ['pending_finance', 'Awaiting Finance (' + byStage('finance') + ')'],
    ['approved', 'Approved (' + approved.length + ')'],
    ['rejected', 'Rejected (' + rejected.length + ')'],
    ['cancelled', 'Cancelled (' + cancelled.length + ')'],
  ];
  const shown = state.filter === 'all' ? all : all.filter(r => r.status === state.filter);
  return `
    ${!mail.configured ? `
    <div class="demo-note" style="margin-bottom:16px;border-left:3px solid var(--gold);">
      ✉️ <b>Email notifications are not configured.</b> Approvers won't get emails on stage changes until
      the Microsoft Graph variables are set (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MAIL_FROM — see README).
      Every skipped email is recorded in the Audit Log so you can see exactly what would have been sent.
    </div>` : `
    <div class="demo-note" style="margin-bottom:16px;border-left:3px solid var(--green);">
      ✉️ Email notifications active — sending from <b>${esc(mail.from)}</b>.
    </div>`}
    <div class="stat-grid">
      <div class="stat-tile" style="--tile:var(--gold);"><div class="num">${byStage('supervisor')}</div><div class="lbl">Awaiting Supervisor</div></div>
      <div class="stat-tile" style="--tile:var(--gold);"><div class="num">${byStage('accountant')}</div><div class="lbl">Awaiting Accountant</div></div>
      <div class="stat-tile" style="--tile:var(--gold);"><div class="num">${byStage('budget')}</div><div class="lbl">Awaiting Budget Sup.</div></div>
      <div class="stat-tile" style="--tile:var(--gold);"><div class="num">${byStage('finance')}</div><div class="lbl">Awaiting Finance Mgr.</div></div>
      <div class="stat-tile" style="--tile:var(--green);"><div class="num">${approved.length}</div><div class="lbl">Approved</div><div class="sub">KWD ${approvedTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div></div>
      <div class="stat-tile" style="--tile:var(--red);"><div class="num">${rejected.length}</div><div class="lbl">Rejected</div></div>
      <div class="stat-tile" style="--tile:var(--teal);"><div class="num" style="font-size:20px;padding-top:6px;">KWD ${pendingTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div><div class="lbl">Value in pipeline</div></div>
    </div>
    <div class="filter-pills" style="align-items:center;">
      ${filters.map(f => `<button class="fpill ${state.filter === f[0] ? 'active' : ''}" data-f="${f[0]}">${f[1]}</button>`).join('')}
      <a class="btn outline" href="/api/export.xlsx" style="margin-left:auto;padding:7px 14px;font-size:12.5px;text-decoration:none;">📥 Export to Excel</a>
    </div>
    ${listCards(shown)}
  `;
}

async function adminUsers() {
  cache.users = (await api('/users')).users;
  cache.groups = (await api('/groups')).groups;
  const users = cache.users.filter(u => u.role !== 'admin');
  const roleOpts = [['requestor', 'Requestor'], ['supervisor', 'Supervisor'], ['accountant', 'Accountant'], ['budget', 'Budget Supervisor'], ['finance', 'Finance Manager']];
  const teamRoleOpts = roleOpts.filter(r => r[0] !== 'requestor');
  const teamsHtml = `
    <div class="form-card" style="margin-top:18px;">
      <h3 class="serif" style="margin:0 0 4px;color:var(--navy-deep);font-size:16px;">Teams — group approvers</h3>
      <p style="font-size:13px;color:var(--ink-soft);margin:0 0 14px;">
        A team can be assigned to a workflow stage in Routing. Policy <b>Any member</b>: the first member to act
        decides the stage. Policy <b>All members (parallel)</b>: every member must approve — in any order, at the
        same time — and a single rejection rejects the request.
      </p>
      <div class="form-grid" style="grid-template-columns:1.4fr 1fr 1.2fr auto;align-items:end;margin-bottom:14px;">
        <div class="field" style="margin:0;"><label>Team name</label><input id="g_name" placeholder="e.g. Accounts Payable Team"></div>
        <div class="field" style="margin:0;"><label>Role</label>
          <select id="g_role" style="width:100%;padding:9px;border:1px solid var(--line);border-radius:7px;background:#FCFBF7;">${teamRoleOpts.map(r => `<option value="${r[0]}">${r[1]}</option>`).join('')}</select>
        </div>
        <div class="field" style="margin:0;"><label>Approval policy</label>
          <select id="g_policy" style="width:100%;padding:9px;border:1px solid var(--line);border-radius:7px;background:#FCFBF7;">
            <option value="any">Any member decides</option>
            <option value="all">All members must approve (parallel)</option>
          </select>
        </div>
        <button class="btn gold" id="addGroupBtn" style="height:40px;">Create team</button>
      </div>
      <div class="err hidden" id="groupErr" style="margin-bottom:10px;"></div>
      ${cache.groups.length ? cache.groups.map(g => {
        const candidates = users.filter(u => u.role === g.role && u.active && !g.members.some(m => m.id === u.id));
        return `
        <div class="wf-stage" style="flex-direction:column;align-items:stretch;gap:8px;">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <div class="wf-name" style="min-width:0;">${esc(g.name)}</div>
            <span class="user-badge">${stageLabel(g.role)}</span>
            <select data-gpolicy="${g.id}" style="padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:#FCFBF7;">
              <option value="any" ${g.policy === 'any' ? 'selected' : ''}>Any member decides</option>
              <option value="all" ${g.policy === 'all' ? 'selected' : ''}>All must approve (parallel)</option>
            </select>
            <button class="mini-btn del" data-gdel="${g.id}" style="margin-left:auto;">Delete team</button>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            ${g.members.length ? g.members.map(m => `<span class="user-badge" style="background:var(--amber-bg);">${esc(m.name)} <a href="#" data-gremove="${g.id}:${m.id}" style="text-decoration:none;color:var(--red);font-weight:700;">✕</a></span>`).join('') : '<span style="font-size:12.5px;color:var(--ink-soft);">No members yet — this team is ignored by routing until it has members.</span>'}
            ${candidates.length ? `
            <select data-gadd="${g.id}" style="padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:#FCFBF7;">
              <option value="">+ Add member…</option>
              ${candidates.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}
            </select>` : ''}
          </div>
        </div>`;
      }).join('') : '<div class="empty">No teams yet. Teams are optional — create one when several people should share a stage.</div>'}
    </div>`;
  return `
    <div class="form-card" style="margin-bottom:18px;">
      <h3 class="serif" style="margin:0 0 12px;color:var(--navy-deep);font-size:16px;">Add user</h3>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr auto;align-items:end;">
        <div class="field" style="margin:0;"><label>Full name</label><input id="u_name" placeholder="e.g. Fatima Al-Sabah"></div>
        <div class="field" style="margin:0;"><label>Email (optional)</label><input id="u_email" placeholder="name@aca.edu.kw"></div>
        <div class="field" style="margin:0;"><label>Role</label>
          <select id="u_role" style="width:100%;padding:9px;border:1px solid var(--line);border-radius:7px;background:#FCFBF7;">${roleOpts.map(r => `<option value="${r[0]}">${r[1]}</option>`).join('')}</select>
        </div>
        <div class="field" style="margin:0;"><label>Initial password (min 8)</label><input id="u_pass" type="text" placeholder="They change it on first login"></div>
        <button class="btn gold" id="addUserBtn" style="height:40px;">Add</button>
      </div>
      <div class="err hidden" id="userErr" style="margin-top:10px;"></div>
      <div class="demo-note" style="margin-top:12px;">
        Users log in with their name and password. They are forced to set their own password on first login.
        Deactivating a user blocks their login immediately; their past approvals stay on record.
      </div>
    </div>
    ${users.length ? `
    <table class="admin-table">
      <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th style="text-align:right;">Actions</th></tr>
      ${users.map(u => `
      <tr class="${u.active ? '' : 'user-inactive'}">
        <td><b>${esc(u.name)}</b></td>
        <td>${esc(u.email) || '—'}</td>
        <td>
          <select data-role-for="${u.id}">
            ${roleOpts.map(r => `<option value="${r[0]}" ${u.role === r[0] ? 'selected' : ''}>${r[1]}</option>`).join('')}
          </select>
        </td>
        <td><span class="user-badge">${u.active ? 'Active' : 'Deactivated'}</span></td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="mini-btn react" data-resetpw="${u.id}">Reset password</button>
          <button class="mini-btn ${u.active ? 'deact' : 'react'}" data-toggle="${u.id}">${u.active ? 'Deactivate' : 'Reactivate'}</button>
          <button class="mini-btn del" data-del="${u.id}">Remove</button>
        </td>
      </tr>`).join('')}
    </table>` : `<div class="empty">No user accounts yet — add your requestors, supervisors, accountants, budget supervisors and finance managers above.</div>`}
    ${teamsHtml}
  `;
}

async function adminWorkflow() {
  cache.workflow = (await api('/workflow')).workflow;
  cache.wfDraft = cache.workflow.map(s => Object.assign({}, s));
  cache.routing = (await api('/routing')).routing;
  cache.users = (await api('/users')).users;
  cache.groups = (await api('/groups')).groups;
  const wf = cache.workflow;
  const users = cache.users;
  const requestors = users.filter(u => u.role === 'requestor');
  const byRole = k => users.filter(u => u.role === k && u.active);
  const rows = [{ requestorId: '*', label: '⭐ Default (all requesters)' }].concat(
    requestors.map(u => ({ requestorId: u.id, label: u.name + (u.active ? '' : ' (deactivated)') }))
  );
  const ruleFor = id => cache.routing.find(x => x.requestorId === id) || {};
  const groupsByRole = k => (cache.groups || []).filter(g => g.role === k && g.members.length);
  const sel = (rid, stage, current) => `
    <select data-route="${rid}" data-stage="${stage}">
      <option value="">— Any ${stageLabel(stage)} —</option>
      ${groupsByRole(stage).length ? `<optgroup label="Teams">${groupsByRole(stage).map(g => `<option value="g:${g.id}" ${current === 'g:' + g.id ? 'selected' : ''}>👥 ${esc(g.name)} (${g.policy === 'all' ? 'all ' + g.members.length : 'any'})</option>`).join('')}</optgroup>` : ''}
      <optgroup label="Individuals">${byRole(stage).map(u => `<option value="u:${u.id}" ${(current === 'u:' + u.id || current === u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</optgroup>
    </select>`;
  return `
    <div class="form-card" style="margin-bottom:18px;">
      <h3 class="serif" style="margin:0 0 4px;color:var(--navy-deep);font-size:16px;">Approval chain — order &amp; stages</h3>
      <p style="font-size:13px;color:var(--ink-soft);margin:0 0 16px;">
        Reorder the stages with ↑/↓ (e.g. put Accountant last), toggle stages on/off, or make a stage
        apply only above a minimum amount. Changes apply to <b>new requests only</b> — in-flight requests
        keep the chain they started with.
      </p>
      <div id="wfRows">${renderWfRows()}</div>
      <div class="err hidden" id="wfErr" style="margin-top:8px;"></div>
      <div style="display:flex;gap:10px;margin-top:14px;align-items:center;">
        <button class="btn gold" id="saveWfBtn">Save chain</button>
        <span id="wfSaved" class="hidden" style="color:var(--green);font-size:13px;font-weight:600;">✓ Saved</span>
      </div>
    </div>
    <div class="form-card">
      <h3 class="serif" style="margin:0 0 4px;color:var(--navy-deep);font-size:16px;">Routing — who approves for each requester</h3>
      <p style="font-size:13px;color:var(--ink-soft);margin:0 0 16px;">
        Assign the specific Accountant, Budget Supervisor and Finance Manager who handle each requester's
        payment requests. The <b>Default</b> row covers any requester without their own row.
        "Any" lets every user of that role act. Routing is frozen onto each request at submission.
      </p>
      ${users.filter(u=>u.role!=='admin').length ? `
      <table class="admin-table">
        <tr><th>Requester</th><th>Supervisor</th><th>Accountant</th><th>Budget Supervisor</th><th>Finance Manager</th></tr>
        ${rows.map(row => {
          const rule = ruleFor(row.requestorId);
          return `<tr>
            <td><b data-reqname="${row.requestorId}">${esc(row.label)}</b></td>
            <td>${sel(row.requestorId, 'supervisor', rule.supervisor)}</td>
            <td>${sel(row.requestorId, 'accountant', rule.accountant)}</td>
            <td>${sel(row.requestorId, 'budget', rule.budget)}</td>
            <td>${sel(row.requestorId, 'finance', rule.finance)}</td>
          </tr>`;
        }).join('')}
      </table>
      ${requestors.length ? '' : '<p style="font-size:12.5px;color:var(--ink-soft);margin-top:10px;">Add users with the <b>Requestor</b> role in User Management to give them individual routing rows.</p>'}
      <div style="display:flex;gap:10px;margin-top:14px;align-items:center;">
        <button class="btn gold" id="saveRoutingBtn">Save routing</button>
        <span id="routingSaved" class="hidden" style="color:var(--green);font-size:13px;font-weight:600;">✓ Saved</span>
      </div>
      ` : `<div class="empty">Add users in <b>User Management</b> first — routing assigns specific people.</div>`}
    </div>
  `;
}

async function adminFields() {
  cache.fields = (await api('/custom-fields')).fields;
  const typeOpts = [['text', 'Text'], ['textarea', 'Long text'], ['number', 'Number'], ['date', 'Date'], ['select', 'Dropdown']];
  return `
    <div class="form-card" style="margin-bottom:18px;">
      <h3 class="serif" style="margin:0 0 4px;color:var(--navy-deep);font-size:16px;">Add a field to the request form</h3>
      <p style="font-size:13px;color:var(--ink-soft);margin:0 0 14px;">
        Extra fields appear under "Additional Information" on the New Payment Request form, in the review
        drawer, on the printed form, and as a column in the Excel export. Removing a field later doesn't
        erase values already submitted on past requests.
      </p>
      <div class="form-grid" style="grid-template-columns:1.3fr 1fr auto auto;align-items:end;">
        <div class="field" style="margin:0;"><label>Field label</label><input id="cf_label" placeholder="e.g. Cost Center Code"></div>
        <div class="field" style="margin:0;"><label>Type</label>
          <select id="cf_type" style="width:100%;padding:9px;border:1px solid var(--line);border-radius:7px;background:#FCFBF7;">${typeOpts.map(t => `<option value="${t[0]}">${t[1]}</option>`).join('')}</select>
        </div>
        <div class="field" style="margin:0;"><label class="sw" style="display:flex;align-items:center;gap:6px;font-weight:600;font-size:12.5px;color:var(--navy);"><input type="checkbox" id="cf_required"> Required</label></div>
        <button class="btn gold" id="addFieldBtn" style="height:40px;">Add field</button>
      </div>
      <div class="field" id="cf_optionsWrap" style="display:none;margin-top:10px;"><label>Dropdown options (comma-separated)</label><input id="cf_options" placeholder="e.g. Operations, IT, Facilities, Marketing"></div>
      <div class="field" style="margin-top:10px;"><label>Placeholder text (optional)</label><input id="cf_placeholder" placeholder="Shown faintly inside the empty field"></div>
      <div class="err hidden" id="fieldErr" style="margin-top:8px;"></div>
    </div>
    ${cache.fields.length ? cache.fields.map(f => `
    <div class="wf-stage">
      <div class="wf-num" style="background:var(--teal);">${f.type === 'select' ? '▾' : f.type === 'date' ? '📅' : f.type === 'number' ? '#' : f.type === 'textarea' ? '¶' : 'Aa'}</div>
      <div class="wf-name">${esc(f.label)}${f.required ? ' <span style="color:var(--red);">*</span>' : ''}</div>
      <span class="user-badge">${typeOpts.find(t => t[0] === f.type)[1]}</span>
      ${f.type === 'select' ? `<span style="font-size:12px;color:var(--ink-soft);">${f.options.map(esc).join(', ')}</span>` : ''}
      <button class="mini-btn del" data-fdel="${f.id}" style="margin-left:auto;">Delete</button>
    </div>`).join('') : '<div class="empty">No custom fields yet — every request form uses just the standard fields.</div>'}
  `;
}
function bindFields() {
  const typeSel = document.getElementById('cf_type');
  const toggleOptions = () => { document.getElementById('cf_optionsWrap').style.display = typeSel.value === 'select' ? 'block' : 'none'; };
  if (typeSel) { typeSel.onchange = toggleOptions; toggleOptions(); }
  const addBtn = document.getElementById('addFieldBtn');
  if (addBtn) addBtn.onclick = async () => {
    const errEl = document.getElementById('fieldErr');
    try {
      await api('/custom-fields', { method: 'POST', body: JSON.stringify({
        label: document.getElementById('cf_label').value.trim(),
        type: typeSel.value,
        required: document.getElementById('cf_required').checked,
        options: document.getElementById('cf_options').value,
        placeholder: document.getElementById('cf_placeholder').value.trim(),
      })});
      render();
    } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  };
  document.querySelectorAll('[data-fdel]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this field? Past requests keep the values already submitted.')) return;
    try { await api('/custom-fields/' + b.dataset.fdel, { method: 'DELETE' }); render(); }
    catch (e) { alert(e.message); }
  });
}

async function adminBudget() {
  const { config, graphConfigured } = await api('/budget/config');
  cache.budgetCfg = config;
  cache.users = (await api('/users')).users;
  const depts = config.departments || [];
  // preload lines per department for the tables
  const deptLines = {};
  for (const d of depts) {
    if (d.mode && d.mode !== 'off') {
      try { deptLines[d.id] = (await api('/budget/lines?dept=' + encodeURIComponent(d.id))).lines; }
      catch (e) { deptLines[d.id] = { error: e.message }; }
    }
  }
  cache._deptLines = deptLines;
  const requestors = cache.users.filter(u => u.role === 'requestor' || u.role === 'budget');

  return `
    <div class="form-card">
      <h3 class="serif" style="margin:0 0 4px;color:var(--navy-deep);font-size:16px;">Budget departments</h3>
      <p style="font-size:13px;color:var(--ink-soft);margin:0 0 14px;">
        Add one workbook per department (IT, HR, Maintenance…). Requesters pick a department on the form,
        then allocate the amount across one or more budget lines within it. On finalize, each line's amount is
        appended to that workbook's matching Log sheet; the workbook's own SUMIF formulas do the deduction.
      </p>
      <div class="form-grid" style="gap:10px 14px;margin-bottom:10px;">
        <div class="field"><label>If amount exceeds available</label>
          <select id="b_policy" style="width:100%;padding:9px;border:1px solid var(--line);border-radius:7px;background:#FCFBF7;">
            <option value="block" ${config.policy === 'block' ? 'selected' : ''}>Block submission</option>
            <option value="warn" ${config.policy === 'warn' ? 'selected' : ''}>Allow, but flag as over budget</option>
          </select>
        </div>
        <div class="field"><label class="sw" style="display:flex;align-items:center;gap:8px;margin-top:26px;font-weight:600;font-size:13px;color:var(--navy);"><input type="checkbox" id="b_required" ${config.required ? 'checked' : ''}> Budget line mandatory on every request</label></div>
      </div>
      <button class="btn outline" id="saveBudgetGlobal" style="margin-bottom:6px;">Save settings</button>
      <span id="bGlobalSaved" class="hidden" style="color:var(--green);font-size:13px;font-weight:600;margin-left:8px;">✓ Saved</span>
    </div>

    ${depts.map(d => {
      const lines = deptLines[d.id];
      const hasErr = lines && lines.error;
      const count = Array.isArray(lines) ? lines.length : 0;
      return `
      <div class="form-card" style="margin-top:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h3 class="serif" style="margin:0;color:var(--navy-deep);font-size:15px;">${esc(d.name)} <span style="font-size:12px;color:var(--ink-soft);font-weight:400;">(${d.mode === 'off' ? 'off' : d.mode}${count ? ', ' + count + ' lines' : ''})</span></h3>
          <button class="mini-btn del dept-del" data-id="${esc(d.id)}">Remove</button>
        </div>
        ${hasErr ? `<div class="err" style="margin-top:8px;">${esc(lines.error)}</div>` : ''}
        ${Array.isArray(lines) && lines.length ? `
        <details style="margin-top:8px;"><summary style="cursor:pointer;font-size:13px;color:var(--navy);">View ${lines.length} budget lines</summary>
        <table class="admin-table" style="margin-top:8px;">
          <tr><th>Code</th><th>Description</th><th style="text-align:right;">Budget</th><th style="text-align:right;">Utilized</th><th style="text-align:right;">Held</th><th style="text-align:right;">Available</th></tr>
          ${lines.map(l => `<tr>
            <td class="mono"><b>${esc(l.code)}</b></td><td>${esc(l.description)}</td>
            <td style="text-align:right;" class="mono">${l.budget.toLocaleString(undefined, { minimumFractionDigits: 3 })}</td>
            <td style="text-align:right;" class="mono">${l.utilized.toLocaleString(undefined, { minimumFractionDigits: 3 })}</td>
            <td style="text-align:right;" class="mono">${l.held ? l.held.toLocaleString(undefined, { minimumFractionDigits: 3 }) : '—'}</td>
            <td style="text-align:right;" class="mono" ${l.available <= 0 ? 'style="text-align:right;color:var(--red);font-weight:700;"' : ''}>${l.available.toLocaleString(undefined, { minimumFractionDigits: 3 })}</td>
          </tr>`).join('')}
        </table></details>` : ''}
      </div>`;
    }).join('')}

    <div class="form-card" style="margin-top:16px;">
      <h3 class="serif" style="margin:0 0 8px;color:var(--navy-deep);font-size:15px;">Add / update a department</h3>
      ${graphConfigured ? '' : `<div class="demo-note" style="margin-bottom:10px;">OneDrive mode needs the Graph env vars + <b>Files.ReadWrite.All</b> (see README). Local mode works without them.</div>`}
      <div class="form-grid">
        <div class="field"><label>Department name</label><input id="nd_name" placeholder="e.g. HR"></div>
        <div class="field"><label>Source</label>
          <select id="nd_mode" style="width:100%;padding:9px;border:1px solid var(--line);border-radius:7px;background:#FCFBF7;">
            <option value="onedrive">OneDrive / SharePoint</option>
            <option value="local">Local file (testing)</option>
          </select>
        </div>
      </div>
      <div class="field" id="nd_onedrive"><label>OneDrive share link</label><input id="nd_sharelink" placeholder="https://...sharepoint.com/:x:/g/..."></div>
      <div class="field" id="nd_local" style="display:none;"><label>Local .xlsx path</label><input id="nd_localpath" placeholder="/data/budget/HR.xlsx"></div>
      <div class="err hidden" id="ndErr" style="margin-bottom:8px;"></div>
      <button class="btn gold" id="addDeptBtn">Add department</button>
    </div>

    <div class="form-card" style="margin-top:16px;">
      <h3 class="serif" style="margin:0 0 4px;color:var(--navy-deep);font-size:15px;">Who can see which department</h3>
      <p style="font-size:13px;color:var(--ink-soft);margin:0 0 12px;">
        Tick the departments each person may charge on their requests. Leave all unticked to give access to
        <b>every</b> department (the default).
      </p>
      ${depts.length ? `
      <table class="admin-table">
        <tr><th>User</th>${depts.map(d => `<th style="text-align:center;">${esc(d.name)}</th>`).join('')}</tr>
        ${requestors.map(u => `
        <tr data-user="${esc(u.id)}">
          <td>${esc(u.name)} <span style="font-size:11px;color:var(--ink-soft);">(${esc(u.role)})</span></td>
          ${depts.map(d => `<td style="text-align:center;"><input type="checkbox" class="da-chk" data-user="${esc(u.id)}" data-dept="${esc(d.id)}"></td>`).join('')}
        </tr>`).join('')}
      </table>
      <div style="display:flex;gap:10px;margin-top:12px;align-items:center;">
        <button class="btn gold" id="saveAccessBtn">Save access</button>
        <span id="accessSaved" class="hidden" style="color:var(--green);font-size:13px;font-weight:600;">✓ Saved</span>
      </div>` : '<div class="empty">Add a department first.</div>'}
    </div>

    ${await attachStorePanel()}
  `;
}
async function attachStorePanel() {
  let data;
  try { data = await api('/attach-store'); } catch (e) { return ''; }
  const c = data.config || { mode: 'local' };
  return `
    <div class="form-card" style="margin-top:16px;">
      <h3 class="serif" style="margin:0 0 4px;color:var(--navy-deep);font-size:16px;">Attachment storage</h3>
      <p style="font-size:13px;color:var(--ink-soft);margin:0 0 14px;">
        By default, uploaded files (PDFs and images on each request) are stored on the app server. On a hosted
        setup like Railway that consumes disk. Point this at <b>one shared OneDrive/SharePoint folder</b> and new
        uploads go there instead — the server keeps only a reference. Files already stored locally keep working.
      </p>
      <div class="field radio-set" style="margin-bottom:14px;">
        <label><input type="radio" name="asmode" value="local" ${c.mode === 'local' ? 'checked' : ''}> Server disk (default)</label>
        <label><input type="radio" name="asmode" value="onedrive" ${c.mode === 'onedrive' ? 'checked' : ''}> OneDrive / SharePoint folder</label>
      </div>
      <div id="asmode_onedrive" style="display:${c.mode === 'onedrive' ? 'block' : 'none'};">
        ${data.graphConfigured ? '' : `<div class="demo-note" style="margin-bottom:10px;">Needs the Graph env vars + <b>Files.ReadWrite.All</b> (same as the budget workbooks).</div>`}
        <div class="field"><label>Share link of the attachments folder</label><input id="as_sharelink" value="${esc(c.shareLink || '')}" placeholder="https://...sharepoint.com/:f:/g/... (a FOLDER, not a file)"></div>
        ${c.folderName ? `<div style="font-size:12.5px;color:var(--green);margin:-8px 0 10px;">✓ Connected folder: <b>${esc(c.folderName)}</b></div>` : ''}
      </div>
      <div class="err hidden" id="asErr" style="margin-top:8px;"></div>
      <div style="display:flex;gap:10px;margin-top:6px;align-items:center;">
        <button class="btn gold" id="saveAttachStore">Save storage setting</button>
        <span id="asSaved" class="hidden" style="color:var(--green);font-size:13px;font-weight:600;">✓ Saved</span>
      </div>
    </div>
  `;
}
async function bindBudget() {
  // global settings
  const gSave = document.getElementById('saveBudgetGlobal');
  if (gSave) gSave.onclick = async () => {
    await api('/budget/config', { method: 'PUT', body: JSON.stringify({ config: {
      policy: document.getElementById('b_policy').value,
      required: document.getElementById('b_required').checked,
    } }) });
    const ok = document.getElementById('bGlobalSaved'); ok.classList.remove('hidden'); setTimeout(() => ok.classList.add('hidden'), 2000);
  };
  // add-dept mode toggle
  const ndMode = document.getElementById('nd_mode');
  if (ndMode) ndMode.onchange = () => {
    document.getElementById('nd_onedrive').style.display = ndMode.value === 'onedrive' ? 'block' : 'none';
    document.getElementById('nd_local').style.display = ndMode.value === 'local' ? 'block' : 'none';
  };
  const addDept = document.getElementById('addDeptBtn');
  if (addDept) addDept.onclick = async () => {
    const errEl = document.getElementById('ndErr');
    addDept.disabled = true; addDept.textContent = 'Connecting…';
    try {
      await api('/budget/departments', { method: 'POST', body: JSON.stringify({
        name: document.getElementById('nd_name').value.trim(),
        mode: ndMode.value,
        shareLink: (document.getElementById('nd_sharelink') || {}).value || '',
        localPath: (document.getElementById('nd_localpath') || {}).value || '',
      }) });
      render();
    } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); addDept.disabled = false; addDept.textContent = 'Add department'; }
  };
  document.querySelectorAll('.dept-del').forEach(b => b.onclick = async () => {
    if (!confirm('Remove this department? Existing requests keep their saved budget info; new requests can no longer pick it.')) return;
    try { await api('/budget/departments/' + b.dataset.id, { method: 'DELETE' }); render(); } catch (e) { alert(e.message); }
  });
  // per-user access: load current selections
  const chks = document.querySelectorAll('.da-chk');
  if (chks.length) {
    const users = [...new Set(Array.from(chks).map(c => c.dataset.user))];
    for (const uid of users) {
      try {
        const { departments } = await api('/users/' + uid + '/departments');
        if (Array.isArray(departments)) {
          departments.forEach(did => {
            const c = document.querySelector(`.da-chk[data-user="${uid}"][data-dept="${did}"]`);
            if (c) c.checked = true;
          });
        }
      } catch (e) {}
    }
    document.getElementById('saveAccessBtn').onclick = async () => {
      for (const uid of users) {
        const ids = Array.from(document.querySelectorAll(`.da-chk[data-user="${uid}"]`)).filter(c => c.checked).map(c => c.dataset.dept);
        await api('/users/' + uid + '/departments', { method: 'PUT', body: JSON.stringify({ departments: ids }) });
      }
      const ok = document.getElementById('accessSaved'); ok.classList.remove('hidden'); setTimeout(() => ok.classList.add('hidden'), 2000);
    };
  }
  // attachment storage
  document.querySelectorAll('input[name=asmode]').forEach(rd => rd.onchange = () => {
    document.getElementById('asmode_onedrive').style.display = document.querySelector('input[name=asmode]:checked').value === 'onedrive' ? 'block' : 'none';
  });
  const saveAs = document.getElementById('saveAttachStore');
  if (saveAs) saveAs.onclick = async () => {
    const errEl = document.getElementById('asErr');
    const mode = document.querySelector('input[name=asmode]:checked').value;
    saveAs.disabled = true; saveAs.textContent = 'Saving…';
    try {
      await api('/attach-store', { method: 'PUT', body: JSON.stringify({ config: {
        mode,
        shareLink: (document.getElementById('as_sharelink') || {}).value || '',
      } }) });
      render();
    } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); saveAs.disabled = false; saveAs.textContent = 'Save storage setting'; }
  };
}

async function adminPrintForm() {
  cache.printSettings = (await api('/print-settings')).print;
  cache.branding = await api('/branding');
  if (!cache.layoutMeta) cache.layoutMeta = await api('/print-layout');
  if (!cache.layoutDraft) cache.layoutDraft = cache.layoutMeta.layout.map(b => Object.assign({}, b));
  const p = cache.printSettings;
  const b = cache.branding;
  return `
    <div class="form-card">
      <h3 class="serif" style="margin:0 0 4px;color:var(--navy-deep);font-size:16px;">Logo</h3>
      <p style="font-size:13px;color:var(--ink-soft);margin:0 0 14px;">
        Shown in the app header, the login screen, and the printed form. PNG, JPG or WEBP, max 2 MB.
        Without a logo, a colored circle with your initial(s) is used instead.
      </p>
      <div style="display:flex;align-items:center;gap:16px;">
        <div style="width:64px;height:64px;border-radius:6px;background:#1D4A94;border:2px solid #FFC125;display:flex;align-items:center;justify-content:center;overflow:hidden;font-family:'Spectral',serif;font-weight:700;font-size:22px;color:#fff;">
          ${b.hasLogo ? `<img src="/api/logo?t=${Date.now()}" alt="logo" style="width:100%;height:100%;object-fit:cover;">` : esc(p.logoInitial)}
        </div>
        <div>
          <input type="file" id="logoFile" accept="image/png,image/jpeg,image/webp" style="display:none;">
          <button class="btn outline" id="logoUploadBtn" style="margin-right:8px;">${b.hasLogo ? 'Replace logo' : 'Upload logo'}</button>
          ${b.hasLogo ? '<button class="btn danger" id="logoRemoveBtn">Remove logo</button>' : ''}
          <div class="err hidden" id="logoErr" style="margin-top:8px;"></div>
        </div>
      </div>
    </div>
    <div class="form-card" style="margin-top:18px;">
      <h3 class="serif" style="margin:0 0 4px;color:var(--navy-deep);font-size:16px;">Header, title &amp; footer</h3>
      <div class="form-grid">
        <div class="field"><label>Organization name</label><input id="p_org" value="${esc(p.orgName)}"></div>
        <div class="field"><label>Logo letter(s)</label><input id="p_logo" maxlength="2" value="${esc(p.logoInitial)}" style="width:80px;"></div>
      </div>
      <div class="form-grid">
        <div class="field"><label>Form title</label><input id="p_title" value="${esc(p.formTitle)}"></div>
        <div class="field"><label>Header note (optional, shown under the title)</label><input id="p_headernote" value="${esc(p.headerNote)}" placeholder="e.g. Finance Department Use Only"></div>
      </div>
      <div class="section-title">Blocks</div>
      <div class="field radio-set" style="margin-bottom:18px;">
        <label><input type="checkbox" id="p_showapprovals" ${p.showApprovals ? 'checked' : ''}> Digital Approvals on Record table</label>
        <label><input type="checkbox" id="p_showattachments" ${p.showAttachments ? 'checked' : ''}> Append image attachments as extra pages</label>
        <label><input type="checkbox" id="p_showbanner" ${p.showBanner ? 'checked' : ''}> "All approvals complete" banner</label>
      </div>
      <div class="section-title">Final signature block</div>
      <div class="form-grid">
        <div class="field"><label>Instruction line</label><input id="p_footerline" value="${esc(p.footerLine)}"></div>
        <div class="field"><label>Signatory label</label><input id="p_signatory" value="${esc(p.signatoryLabel)}"></div>
      </div>
      <div class="field"><label>Extra footer note (optional)</label><textarea id="p_footernote" rows="2">${esc(p.footerNote)}</textarea></div>
      <div class="err hidden" id="printErr" style="margin-top:8px;"></div>
      <div style="display:flex;gap:10px;margin-top:6px;align-items:center;">
        <button class="btn gold" id="savePrintBtn">Save</button>
        <button class="btn outline" id="resetPrintBtn">Reset to default</button>
        <span id="printSaved" class="hidden" style="color:var(--green);font-size:13px;font-weight:600;">✓ Saved</span>
      </div>
    </div>
    <div class="form-card" style="margin-top:18px;">
      <h3 class="serif" style="margin:0 0 4px;color:var(--navy-deep);font-size:16px;">Form layout</h3>
      <p style="font-size:13px;color:var(--ink-soft);margin:0 0 14px;">
        Choose exactly which fields appear on the printed form, in what order, and under what label.
        Reorder with the arrows, hide a field with its checkbox, or add a section divider or your own
        fixed text row (e.g. a disclaimer that appears on every form). Standard and custom-data fields
        can be hidden but not deleted — hide them instead, then bring them back later with "Show a hidden field".
      </p>
      <div id="layoutRows">${renderLayoutRows()}</div>
      <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;align-items:center;">
        <select id="addHiddenSel" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:#FCFBF7;">
          <option value="">+ Show a hidden field…</option>
          ${cache.layoutDraft.map((blk, i) => (['standard', 'custom'].includes(blk.kind) && !blk.visible) ? `<option value="${i}">${esc(blk.label)}</option>` : '').join('')}
        </select>
        <button class="btn outline" id="addHeaderBtn">+ Add section header</button>
        <button class="btn outline" id="addStaticBtn">+ Add fixed text row</button>
      </div>
      <div class="err hidden" id="layoutErr" style="margin-top:10px;"></div>
      <div style="display:flex;gap:10px;margin-top:14px;align-items:center;">
        <button class="btn gold" id="saveLayoutBtn">Save layout</button>
        <button class="btn outline" id="resetLayoutBtn">Reset layout to default</button>
        <span id="layoutSaved" class="hidden" style="color:var(--green);font-size:13px;font-weight:600;">✓ Saved</span>
      </div>
    </div>
    <div class="form-card" style="margin-top:18px;">
      <h3 class="serif" style="margin:0 0 12px;color:var(--navy-deep);font-size:16px;">Live preview</h3>
      <div id="printPreview" style="transform:scale(0.72);transform-origin:top left;width:139%;"></div>
    </div>
  `;
}
function renderLayoutRows() {
  return cache.layoutDraft.map((blk, i) => {
    const icon = blk.kind === 'header' ? '§' : blk.kind === 'static' ? '✎' : blk.kind === 'custom' ? '⚑' : '▦';
    const canDelete = blk.kind === 'static' || blk.kind === 'header';
    return `
    <div class="wf-stage" style="flex-wrap:wrap;${blk.visible ? '' : 'opacity:.55;'}">
      <div class="wf-num" style="background:${blk.kind === 'header' ? 'var(--teal)' : 'var(--navy)'};font-size:13px;">${icon}</div>
      <input class="layout-label" data-lidx="${i}" value="${esc(blk.label)}" style="flex:1;min-width:140px;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:#FCFBF7;">
      ${blk.kind === 'static' ? `<input class="layout-statictext" data-lidx="${i}" value="${esc(blk.staticText || '')}" placeholder="Fixed text for this row" style="flex:2;min-width:180px;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:#FCFBF7;">` : ''}
      <label class="sw" style="white-space:nowrap;"><input type="checkbox" class="layout-visible" data-lidx="${i}" ${blk.visible ? 'checked' : ''}> Show</label>
      <div style="display:flex;gap:4px;">
        <button class="mini-btn react layout-up" data-lidx="${i}" title="Move up">↑</button>
        <button class="mini-btn react layout-down" data-lidx="${i}" title="Move down">↓</button>
        ${canDelete ? `<button class="mini-btn del layout-del" data-lidx="${i}">Delete</button>` : ''}
      </div>
    </div>`;
  }).join('');
}
function samplePrintRequest() {
  const now = new Date().toISOString();
  return {
    id: 'ACA-00000000', createdAt: now, completedAt: now, status: 'approved',
    chain: ['supervisor', 'accountant', 'budget', 'finance'],
    department: 'IT', requestorName: 'Sample Requestor', requestorPhone: '2200 0000',
    payeeName: 'Ministry of Communications', payeeAddress: 'Kuwait', payeePhone: '',
    paymentType: 'Supplier Payment', paymentTypeOther: '', paymentMethod: 'Cheque',
    amount: 450, currency: 'KWD', description: 'ACAH-CON 50 — Move ISDN to new vendor',
    documents: ['Invoice 360246'], attachments: [],
    customFields: (cache.layoutMeta ? cache.layoutMeta.customFields : []).map(f => ({ id: f.id, label: f.label, value: 'Sample value' })),
    financeUse: { requestNo: 'REQ-0001', voucherNo: 'V-778', vendorNo: 'VEN-12' },
    approvals: {
      supervisor: { by: 'Layla Supervisor', decision: 'approved', at: now },
      accountant: { by: 'Fatima', decision: 'approved', at: now },
      budget: { by: 'Ahmed', decision: 'approved', at: now },
      finance: { by: 'Nadia', decision: 'approved', at: now },
    },
  };
}
function bindPrintFormEditor() {
  const logoBtn = document.getElementById('logoUploadBtn');
  const logoFile = document.getElementById('logoFile');
  if (logoBtn) logoBtn.onclick = () => logoFile.click();
  if (logoFile) logoFile.onchange = async () => {
    const f = logoFile.files[0];
    if (!f) return;
    const errEl = document.getElementById('logoErr');
    const fd = new FormData();
    fd.append('logo', f, f.name);
    try {
      await api('/logo', { method: 'POST', body: fd });
      await applyBranding();
      render();
    } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  };
  const logoRemoveBtn = document.getElementById('logoRemoveBtn');
  if (logoRemoveBtn) logoRemoveBtn.onclick = async () => {
    if (!confirm('Remove the logo and revert to the letter mark?')) return;
    await api('/logo', { method: 'DELETE' });
    await applyBranding();
    render();
  };

  const renderPreview = () => {
    document.getElementById('printPreview').innerHTML = printSheet(samplePrintRequest(), { layout: cache.layoutDraft, previewMode: true });
  };
  renderPreview();
  document.querySelectorAll('#p_org,#p_logo,#p_title,#p_headernote,#p_showapprovals,#p_showattachments,#p_showbanner,#p_footerline,#p_signatory,#p_footernote')
    .forEach(el => el.addEventListener('input', () => {
      cache.printSettings = readPrintForm();
      renderPreview();
    }));

  function readPrintForm() {
    return {
      orgName: document.getElementById('p_org').value,
      logoInitial: document.getElementById('p_logo').value,
      formTitle: document.getElementById('p_title').value,
      headerNote: document.getElementById('p_headernote').value,
      showApprovals: document.getElementById('p_showapprovals').checked,
      showAttachments: document.getElementById('p_showattachments').checked,
      showBanner: document.getElementById('p_showbanner').checked,
      footerLine: document.getElementById('p_footerline').value,
      signatoryLabel: document.getElementById('p_signatory').value,
      footerNote: document.getElementById('p_footernote').value,
    };
  }
  document.getElementById('savePrintBtn').onclick = async () => {
    const errEl = document.getElementById('printErr');
    try {
      const { print } = await api('/print-settings', { method: 'PUT', body: JSON.stringify({ print: readPrintForm() }) });
      cache.printSettings = print;
      await applyBranding();
      errEl.classList.add('hidden');
      const ok = document.getElementById('printSaved');
      ok.classList.remove('hidden');
      setTimeout(() => ok.classList.add('hidden'), 2000);
      renderPreview();
    } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  };
  document.getElementById('resetPrintBtn').onclick = async () => {
    if (!confirm('Reset the print form text/header/footer settings to default? (Layout is separate — reset that below if needed.)')) return;
    const defaults = {
      orgName: 'Sama Educational Co.', logoInitial: 'S', formTitle: 'PAYMENT REQUEST', headerNote: '',
      showBanner: true, showApprovals: true, showAttachments: true,
      footerLine: 'Physical signature required below to complete filing',
      signatoryLabel: 'Authorized Signatory', footerNote: '',
    };
    await api('/print-settings', { method: 'PUT', body: JSON.stringify({ print: defaults }) });
    await applyBranding();
    render();
  };

  /* ---- layout editor ---- */
  function refreshLayoutRowsDOM() {
    document.getElementById('layoutRows').innerHTML = renderLayoutRows();
    bindLayoutRowEvents();
    const sel = document.getElementById('addHiddenSel');
    if (sel) {
      sel.innerHTML = '<option value="">+ Show a hidden field…</option>' +
        cache.layoutDraft.map((blk, i) => (['standard', 'custom'].includes(blk.kind) && !blk.visible) ? `<option value="${i}">${esc(blk.label)}</option>` : '').join('');
    }
    renderPreview();
  }
  function bindLayoutRowEvents() {
    document.querySelectorAll('.layout-label').forEach(inp => inp.oninput = () => {
      cache.layoutDraft[Number(inp.dataset.lidx)].label = inp.value;
      renderPreview();
    });
    document.querySelectorAll('.layout-statictext').forEach(inp => inp.oninput = () => {
      cache.layoutDraft[Number(inp.dataset.lidx)].staticText = inp.value;
      renderPreview();
    });
    document.querySelectorAll('.layout-visible').forEach(cb => cb.onchange = () => {
      cache.layoutDraft[Number(cb.dataset.lidx)].visible = cb.checked;
      refreshLayoutRowsDOM();
    });
    document.querySelectorAll('.layout-up').forEach(btn => btn.onclick = () => {
      const i = Number(btn.dataset.lidx);
      if (i > 0) { const [b] = cache.layoutDraft.splice(i, 1); cache.layoutDraft.splice(i - 1, 0, b); refreshLayoutRowsDOM(); }
    });
    document.querySelectorAll('.layout-down').forEach(btn => btn.onclick = () => {
      const i = Number(btn.dataset.lidx);
      if (i < cache.layoutDraft.length - 1) { const [b] = cache.layoutDraft.splice(i, 1); cache.layoutDraft.splice(i + 1, 0, b); refreshLayoutRowsDOM(); }
    });
    document.querySelectorAll('.layout-del').forEach(btn => btn.onclick = () => {
      cache.layoutDraft.splice(Number(btn.dataset.lidx), 1);
      refreshLayoutRowsDOM();
    });
  }
  bindLayoutRowEvents();
  const addHiddenSel = document.getElementById('addHiddenSel');
  if (addHiddenSel) addHiddenSel.onchange = () => {
    if (!addHiddenSel.value) return;
    cache.layoutDraft[Number(addHiddenSel.value)].visible = true;
    refreshLayoutRowsDOM();
  };
  const addHeaderBtn = document.getElementById('addHeaderBtn');
  if (addHeaderBtn) addHeaderBtn.onclick = () => {
    cache.layoutDraft.push({ id: 'hdr_' + Date.now(), kind: 'header', label: 'New Section', visible: true });
    refreshLayoutRowsDOM();
  };
  const addStaticBtn = document.getElementById('addStaticBtn');
  if (addStaticBtn) addStaticBtn.onclick = () => {
    cache.layoutDraft.push({ id: 'txt_' + Date.now(), kind: 'static', label: 'Note', staticText: '', visible: true });
    refreshLayoutRowsDOM();
  };
  document.getElementById('saveLayoutBtn').onclick = async () => {
    const errEl = document.getElementById('layoutErr');
    try {
      const { layout } = await api('/print-layout', { method: 'PUT', body: JSON.stringify({ layout: cache.layoutDraft }) });
      cache.layoutMeta.layout = layout;
      cache.layoutDraft = layout.map(b => Object.assign({}, b));
      errEl.classList.add('hidden');
      refreshLayoutRowsDOM();
      const ok = document.getElementById('layoutSaved');
      ok.classList.remove('hidden');
      setTimeout(() => ok.classList.add('hidden'), 2000);
    } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  };
  document.getElementById('resetLayoutBtn').onclick = async () => {
    if (!confirm('Reset the field layout to the default order and visibility?')) return;
    await api('/print-layout', { method: 'PUT', body: JSON.stringify({ layout: [] }) });
    cache.layoutMeta = null;
    cache.layoutDraft = null;
    render();
  };
}

async function adminAudit() {
  const { audit } = await api('/audit');
  const backupCard = `
    <div class="form-card" style="margin-bottom:16px;">
      <h3 class="serif" style="margin:0 0 4px;color:var(--navy-deep);font-size:16px;">Database backup</h3>
      <p style="font-size:13px;color:var(--ink-soft);margin:0 0 12px;">
        Download a complete snapshot of the database — every user, request, approval, setting, and the audit log —
        as a single <span class="mono">.db</span> file. Keep a copy somewhere safe. To restore it later, place the
        file on the server's data volume as <span class="mono">payments.db</span> (ask your administrator or see the README).
        Attachments stored on OneDrive are unaffected by this; locally-stored attachment files are not included in this download.
      </p>
      <a class="btn gold" href="/api/backup.db" download style="text-decoration:none;display:inline-block;">⬇ Download database backup</a>
    </div>`;
  const table = !audit.length
    ? `<div class="empty">No audit entries yet.</div>`
    : `<table class="admin-table">
        <tr><th>When (UTC)</th><th>Who</th><th>Request</th><th>Action</th></tr>
        ${audit.map(a => `<tr><td style="white-space:nowrap;" class="mono">${esc(a.at)}</td><td><b>${esc(a.actor || '—')}</b></td><td class="mono">${esc(a.request_id || '—')}</td><td>${esc(a.action)}</td></tr>`).join('')}
      </table>`;
  return backupCard + table;
}

function bindAdmin() {
  document.querySelectorAll('.tab[data-atab]').forEach(t => t.onclick = () => { state.adminTab = t.dataset.atab; render(); });
  if (state.adminTab === 'printform') { bindPrintFormEditor(); return; }
  if (state.adminTab === 'fields') { bindFields(); return; }
  if (state.adminTab === 'budget') { bindBudget(); return; }
  document.querySelectorAll('.fpill').forEach(p => p.onclick = () => { state.filter = p.dataset.f; render(); });
  bindCardOpens();

  const addBtn = document.getElementById('addUserBtn');
  if (addBtn) addBtn.onclick = async () => {
    const errEl = document.getElementById('userErr');
    try {
      await api('/users', { method: 'POST', body: JSON.stringify({
        name: document.getElementById('u_name').value.trim(),
        email: document.getElementById('u_email').value.trim(),
        role: document.getElementById('u_role').value,
        password: document.getElementById('u_pass').value,
      })});
      render();
    } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  };
  document.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
    const u = cache.users.find(x => x.id === b.dataset.toggle);
    try { await api('/users/' + b.dataset.toggle, { method: 'PATCH', body: JSON.stringify({ active: !u.active }) }); render(); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Remove this user account? Their past approvals stay on record.')) return;
    try { await api('/users/' + b.dataset.del, { method: 'DELETE' }); render(); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll('[data-resetpw]').forEach(b => b.onclick = async () => {
    const pw = prompt('New temporary password for this user (min 8 characters). They will be asked to change it on next login:');
    if (!pw) return;
    try { await api('/users/' + b.dataset.resetpw, { method: 'PATCH', body: JSON.stringify({ resetPassword: pw }) }); alert('Password reset.'); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll('[data-role-for]').forEach(sel => sel.onchange = async () => {
    try { await api('/users/' + sel.dataset.roleFor, { method: 'PATCH', body: JSON.stringify({ role: sel.value }) }); render(); }
    catch (e) { alert(e.message); render(); }
  });

  /* teams */
  const addGroupBtn = document.getElementById('addGroupBtn');
  if (addGroupBtn) addGroupBtn.onclick = async () => {
    const errEl = document.getElementById('groupErr');
    try {
      await api('/groups', { method: 'POST', body: JSON.stringify({
        name: document.getElementById('g_name').value.trim(),
        role: document.getElementById('g_role').value,
        policy: document.getElementById('g_policy').value,
      })});
      render();
    } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  };
  document.querySelectorAll('[data-gpolicy]').forEach(sel => sel.onchange = async () => {
    try { await api('/groups/' + sel.dataset.gpolicy, { method: 'PATCH', body: JSON.stringify({ policy: sel.value }) }); render(); }
    catch (e) { alert(e.message); render(); }
  });
  document.querySelectorAll('[data-gadd]').forEach(sel => sel.onchange = async () => {
    if (!sel.value) return;
    try { await api('/groups/' + sel.dataset.gadd + '/members', { method: 'POST', body: JSON.stringify({ userId: sel.value }) }); render(); }
    catch (e) { alert(e.message); render(); }
  });
  document.querySelectorAll('[data-gremove]').forEach(a => a.onclick = async (e) => {
    e.preventDefault();
    const [gid, uid] = a.dataset.gremove.split(':');
    try { await api('/groups/' + gid + '/members/' + uid, { method: 'DELETE' }); render(); }
    catch (err) { alert(err.message); }
  });
  document.querySelectorAll('[data-gdel]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this team? Requests already routed to it keep their frozen assignment.')) return;
    try { await api('/groups/' + b.dataset.gdel, { method: 'DELETE' }); render(); }
    catch (e) { alert(e.message); }
  });

  const saveRt = document.getElementById('saveRoutingBtn');
  if (saveRt) saveRt.onclick = async () => {
    const map = {};
    document.querySelectorAll('[data-route]').forEach(sel => {
      const rid = sel.dataset.route, stage = sel.dataset.stage;
      if (!map[rid]) map[rid] = { requestorId: rid };
      if (sel.value) map[rid][stage] = sel.value;
    });
    const rules = Object.values(map).filter(r => r.supervisor || r.accountant || r.budget || r.finance);
    try {
      await api('/routing', { method: 'PUT', body: JSON.stringify({ routing: rules }) });
      const ok = document.getElementById('routingSaved');
      ok.classList.remove('hidden');
      setTimeout(() => ok.classList.add('hidden'), 2000);
    } catch (e) { alert(e.message); }
  };

  bindWfRowEvents();
  const saveWf = document.getElementById('saveWfBtn');
  if (saveWf) saveWf.onclick = async () => {
    const errEl = document.getElementById('wfErr');
    try {
      await api('/workflow', { method: 'PUT', body: JSON.stringify({ workflow: cache.wfDraft }) });
      cache.workflow = cache.wfDraft.map(s => Object.assign({}, s));
      errEl.classList.add('hidden');
      const ok = document.getElementById('wfSaved');
      ok.classList.remove('hidden');
      setTimeout(() => ok.classList.add('hidden'), 2000);
    } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  };
}

function renderWfRows() {
  const enabledSeq = cache.wfDraft.filter(s => s.enabled);
  return cache.wfDraft.map((s, i) => {
    const seqNum = s.enabled ? (enabledSeq.indexOf(s) + 1) : '–';
    return `
    <div class="wf-stage ${s.enabled ? '' : 'off'}">
      <div class="wf-num">${seqNum}</div>
      <div class="wf-name">${stageLabel(s.key)}</div>
      <label class="sw"><input type="checkbox" class="wf-en" data-i="${i}" ${s.enabled ? 'checked' : ''}> Enabled</label>
      <label class="sw">Amount ≥ <input type="number" min="0" step="0.001" class="wf-min" data-i="${i}" value="${s.minAmount || 0}" ${s.enabled ? '' : 'disabled'} style="width:110px;"> KWD</label>
      <div style="display:flex;gap:4px;margin-left:auto;">
        <button class="mini-btn react wf-up" data-i="${i}" title="Move up">↑</button>
        <button class="mini-btn react wf-down" data-i="${i}" title="Move down">↓</button>
      </div>
    </div>`;
  }).join('');
}
function bindWfRowEvents() {
  const refresh = () => { document.getElementById('wfRows').innerHTML = renderWfRows(); bindWfRowEvents(); };
  document.querySelectorAll('.wf-en').forEach(cb => cb.onchange = () => { cache.wfDraft[Number(cb.dataset.i)].enabled = cb.checked; refresh(); });
  document.querySelectorAll('.wf-min').forEach(inp => inp.oninput = () => { cache.wfDraft[Number(inp.dataset.i)].minAmount = Number(inp.value || 0); });
  document.querySelectorAll('.wf-up').forEach(btn => btn.onclick = () => {
    const i = Number(btn.dataset.i);
    if (i > 0) { const [x] = cache.wfDraft.splice(i, 1); cache.wfDraft.splice(i - 1, 0, x); refresh(); }
  });
  document.querySelectorAll('.wf-down').forEach(btn => btn.onclick = () => {
    const i = Number(btn.dataset.i);
    if (i < cache.wfDraft.length - 1) { const [x] = cache.wfDraft.splice(i, 1); cache.wfDraft.splice(i + 1, 0, x); refresh(); }
  });
}

/* ============ CARD LIST ============ */
function listCards(list) {
  if (!list.length) return `<div class="empty">Nothing here yet.</div>`;
  return list.map(r => {
    let stripe = 'var(--line)', pillClass = 'pending', pillText = 'In review';
    if (r.status === 'approved') {
      stripe = 'var(--green)'; pillClass = 'approved';
      pillText = (blHasBudget(r) && !r.paymentFinalized) ? 'Approved · 🔒 Reserved' : 'Approved';
    }
    else if (r.status === 'rejected') { stripe = 'var(--red)'; pillClass = 'rejected'; pillText = 'Rejected — ' + (r.rejectedStage || ''); }
    else if (r.status === 'cancelled') { stripe = 'var(--ink-soft)'; pillClass = 'rejected'; pillText = 'Cancelled'; }
    else { const k = currentStageKey(r); pillText = 'Awaiting ' + (k ? stageLabel(k) : ''); }
    const attCount = (r.attachments || []).length;
    return `
    <div class="req-card" style="--stripe:${stripe};" data-id="${r.id}">
      <div style="flex:1;">
        <div class="id mono">${r.id} · ${fmtDate(r.createdAt)}</div>
        <div class="title">${esc(r.payeeName)} — ${esc(r.department)}</div>
        <div class="meta">${esc(r.paymentType)}${r.paymentType === 'Other' && r.paymentTypeOther ? ': ' + esc(r.paymentTypeOther) : ''} · ${esc(r.paymentMethod)} · Requested by ${esc(r.requestorName)}${attCount ? ' · 📎 ' + attCount + ' file' + (attCount > 1 ? 's' : '') : ''}</div>
      </div>
      <div class="amount">${fmtMoney(r.amount, r.currency)}</div>
      <div class="status"><span class="pill ${pillClass}">${pillText}</span></div>
    </div>`;
  }).join('');
}
function bindCardOpens() {
  document.querySelectorAll('.req-card').forEach(c => c.onclick = () => { state.openId = c.dataset.id; render(); });
}

/* ============ DETAIL DRAWER ============ */
function findRequest(id) { return cache.requests.find(r => r.id === id); }
async function drawerWrap() {
  if (!findRequest(state.openId)) await refreshRequests();
  const r = findRequest(state.openId);
  if (!r) { state.openId = null; return '<div class="empty">Request not found.</div>'; }
  if (state.tab === 'print') {
    try { cache.printSettings = (await api('/print-settings')).print; } catch (e) {}
    try { cache.branding = await api('/branding'); } catch (e) {}
    let liveLayout = [];
    try { liveLayout = (await api('/print-layout')).layout; } catch (e) {}
    return printSheet(r, { layout: liveLayout });
  }
  return `
  <div class="overlay" id="overlayEl">
    <div class="drawer">
      <div class="drawer-head">
        <div>
          <div class="id mono" style="color:var(--ink-soft);">${r.id}</div>
          <h3>${esc(r.payeeName)}</h3>
        </div>
        <button class="close-x" id="closeDrawer">✕</button>
      </div>
      <div class="meta">${fmtDate(r.createdAt)} · Requested by ${esc(r.requestorName)} (${esc(r.department)})</div>
      ${stampsHtml(r)}
      ${r.assigned && Object.keys(r.assigned).length ? `
      <div style="font-size:12px;color:var(--ink-soft);text-align:center;margin:-2px 0 4px;">
        Routed for this requester: ${chainFor(r).map(k => { const a = r.assigned[k]; if (!a) return `${stageLabel(k)}: any`; const nm = a.type === 'group' ? 'team “' + esc(a.name) + '”' + (a.policy === 'all' ? ' (all ' + a.members.length + ')' : '') : esc(a.name); return `${stageLabel(k)}: <b style="color:var(--navy-deep);">${nm}</b>`; }).join(' · ')}
      </div>` : ''}
      <div class="section-title">Payee Details</div>
      <div class="kv"><b>Payee</b><span>${esc(r.payeeName)}</span></div>
      <div class="kv"><b>Address</b><span>${esc(r.payeeAddress) || '—'}</span></div>
      <div class="kv"><b>Phone</b><span>${esc(r.payeePhone) || '—'}</span></div>
      <div class="section-title">Payment</div>
      <div class="kv"><b>Type</b><span>${esc(r.paymentType)}${r.paymentTypeOther ? ': ' + esc(r.paymentTypeOther) : ''}</span></div>
      <div class="kv"><b>Method</b><span>${esc(r.paymentMethod)}</span></div>
      <div class="kv"><b>Amount</b><span class="mono">${fmtMoney(r.amount, r.currency)}</span></div>
      <div class="kv"><b>Description</b><span>${esc(r.description)}</span></div>
      ${blHasBudget(r) ? `
      <div class="section-title">Budget${blOf(r)[0].deptName ? ' — ' + esc(blOf(r)[0].deptName) : ''}</div>
      ${blOf(r).map(l => `<div class="kv"><b>${esc(l.code)}</b><span><span class="mono">KWD ${Number(l.amount).toLocaleString(undefined, { minimumFractionDigits: 3 })}</span> — ${esc(l.description)}${l.overBudget ? ' <span style="color:var(--red);font-weight:700;">(over budget)</span>' : ''}</span></div>`).join('')}
      ${blOf(r).length > 1 ? `<div class="kv"><b>Split total</b><span class="mono">KWD ${blOf(r).reduce((a, l) => a + Number(l.amount || 0), 0).toLocaleString(undefined, { minimumFractionDigits: 3 })}</span></div>` : ''}
      ${r.status !== 'approved' && r.status !== 'rejected' && r.approvals.budget && r.approvals.budget.decision === 'approved' ? `
      <div class="kv"><b>Status</b><span><span class="pill pending">🔒 Reserved — pending remaining approvals</span></span></div>` : ''}
      ` : ''}
      ${(r.customFields || []).length ? `
      <div class="section-title">Additional Information</div>
      ${r.customFields.filter(f => f.value).map(f => `<div class="kv"><b>${esc(f.label)}</b><span>${esc(f.value)}</span></div>`).join('')}
      ` : ''}
      <div class="section-title">Documents Enclosed</div>
      <div class="doc-card">
        ${(r.attachments || []).map(m => `
          <div class="attach-item" style="margin-bottom:6px;">
            <div class="aicon">${m.type.startsWith('image/') ? '🖼' : '📄'}</div>
            <div class="aname">${esc(m.name)}</div>
            <div class="asize">${(m.size / 1024).toFixed(0)} KB</div>
            <button type="button" class="aview" data-att="${m.id}" data-type="${m.type}" data-name="${esc(m.name)}">View</button>
          </div>
          <div class="attach-preview hidden" id="prev_${m.id}"></div>
        `).join('')}
        ${r.documents && r.documents.length ? '<div style="margin-top:8px;font-size:12.5px;color:var(--ink-soft);">Notes: ' + r.documents.map(esc).join(' · ') + '</div>' : ''}
        ${(!r.attachments || !r.attachments.length) && (!r.documents || !r.documents.length) ? '<span style="color:var(--ink-soft);">None attached</span>' : ''}
      </div>
      ${(r.financeUse.requestNo || r.financeUse.voucherNo || r.financeUse.vendorNo) ? `
      <div class="section-title">Finance Use Only</div>
      <div class="kv"><b>Request #</b><span class="mono">${esc(r.financeUse.requestNo) || '—'}</span></div>
      <div class="kv"><b>Voucher #</b><span class="mono">${esc(r.financeUse.voucherNo) || '—'}</span></div>
      <div class="kv"><b>Vendor #</b><span class="mono">${esc(r.financeUse.vendorNo) || '—'}</span></div>
      ` : ''}
      ${r.log && r.log.length ? `
      <div class="section-title">Activity</div>
      <div class="comment-log">
        ${r.log.map(l => `<div class="c"><b>${esc(l.who)}</b> (${esc(l.role)}) — ${esc(l.action)} <span class="d">· ${fmtDate(l.at)}</span>${l.comment ? '<br><i>“' + esc(l.comment) + '”</i>' : ''}</div>`).join('')}
      </div>` : ''}
      ${actionBox(r)}
      ${secondaryActions(r)}
    </div>
  </div>`;
}
function secondaryActions(r) {
  const isPending = r.status && r.status.startsWith('pending_');
  const isRequester = r.requestorUserId === state.user.id;
  const isAdmin = state.user.role === 'admin';
  const canRecall = isPending && !r.paymentFinalized && (isRequester || isAdmin);
  const canCancel = isAdmin && r.status !== 'rejected' && r.status !== 'cancelled' && !r.paymentFinalized;
  if (!canRecall && !canCancel) return '';
  return `
  <div class="approve-box" style="border-style:dashed;">
    <h4 style="font-size:13px;">More actions</h4>
    ${canRecall ? `
      <p style="font-size:12.5px;color:var(--ink-soft);margin:0 0 8px;">Recalling pulls the request out of the approval queue and returns it to the start — all approvals so far are cleared, and it must go through the chain again.</p>
      <div class="field" style="margin-bottom:8px;"><input id="recallReason" placeholder="Reason (optional)"></div>
      <button class="btn outline" id="recallBtn">↺ Recall request</button>
    ` : ''}
    ${canCancel ? `
      <div style="margin-top:${canRecall ? '14px' : '0'};">
        <p style="font-size:12.5px;color:var(--ink-soft);margin:0 0 8px;">Cancelling stops the request permanently (any budget hold is released). This can't be undone.</p>
        <div class="field" style="margin-bottom:8px;"><input id="cancelReason" placeholder="Reason (required)"></div>
        <button class="btn danger" id="cancelReqBtn">✕ Cancel request (admin)</button>
      </div>
    ` : ''}
  </div>`;
}
function stampsHtml(r) {
  const order = chainFor(r);
  const cur = currentStageKey(r);
  return `<div class="stamps">` + order.map(k => {
    const ap = r.approvals[k];
    let cls = '', icon = '○', sub = '';
    if (ap && ap.decision === 'approved') { cls = 'done'; icon = '✓'; sub = fmtDate(ap.at); }
    else if (ap && ap.decision === 'rejected') { cls = 'rejected'; icon = '✕'; sub = fmtDate(ap.at); }
    else if (cur === k) {
      cls = 'current'; icon = '…';
      if (ap && ap.votes) { const a = r.assigned && r.assigned[k]; sub = Object.keys(ap.votes).length + '/' + ((a && a.members) ? a.members.length : '?') + ' voted'; }
    }
    return `<div class="stamp-node ${cls}">
      <div class="stamp-circle">${icon}</div>
      <label>${stageLabel(k).replace(' ', '<br>')}</label>
      ${sub ? `<div class="stamp-date">${sub}</div>` : ''}
    </div>`;
  }).join('') + `
    <div class="stamp-node ${r.status === 'approved' ? 'done' : ''}">
      <div class="stamp-circle">${r.status === 'approved' ? '🖨' : '—'}</div>
      <label>Ready to<br>Print</label>
    </div>
  </div>`;
}
function actionBox(r) {
  if (r.status === 'cancelled') {
    return `<div class="approve-box" style="border-color:var(--ink-soft);"><h4>Cancelled by ${esc(r.cancelledBy || 'admin')}</h4><p style="font-size:13px;color:var(--ink-soft);">${esc(r.cancellationReason || '')}</p></div>`;
  }
  if (r.status === 'rejected') {
    return `<div class="approve-box"><h4>Rejected at ${esc(r.rejectedStage)} stage</h4><p style="font-size:13px;color:var(--ink-soft);">${esc(r.rejectionReason || '')}</p></div>`;
  }
  if (r.status === 'approved') {
    const lines = blOf(r);
    const hasBudget = lines.length > 0;
    const finalized = r.paymentFinalized;
    const canFinalize = state.user.role === 'accountant' || state.user.role === 'admin';
    const lineList = lines.map(l => `${esc(l.code)} (${r.currency} ${Number(l.amount).toFixed(3)})`).join(', ');
    const syncLine = r.budgetSync && r.budgetSync.status === 'synced'
      ? `<span class="pill approved">✓ Written: ${(r.budgetSync.results || []).map(x => esc(x.sheet) + ' r' + x.row).join('; ') || 'ok'}</span>`
      : (r.budgetSync && r.budgetSync.status === 'failed'
        ? `<span class="pill rejected">✗ Failed</span> <span style="color:var(--ink-soft);">${esc(r.budgetSync.error || '')}</span> ${canFinalize ? '<button class="mini-btn react" id="retryBudgetBtn" style="margin-left:6px;">Retry</button>' : ''}`
        : (r.budgetSync ? `<span class="pill pending">${esc(r.budgetSync.status)}</span>` : ''));
    return `<div class="approve-box" style="border-color:var(--green);background:var(--green-bg);">
      <h4 style="color:var(--green);">✓ All approvals complete${r.completedAt ? ' — ' + fmtDate(r.completedAt) : ''}</h4>
      <p style="font-size:13px;color:var(--ink-soft);">Every stage of the approval chain has signed off. Print the completed form to collect the final physical signature and file it.</p>
      <button class="btn gold" id="printBtn">Print Form</button>
    </div>
    ${hasBudget ? `
    <div class="approve-box" style="${finalized ? 'border-color:var(--green);background:var(--green-bg);' : 'border-color:var(--gold);background:var(--amber-bg);'}">
      ${finalized ? `
        <h4 style="color:var(--green);">✓ Payment finalized — ${fmtDate(finalized.at)}</h4>
        <p style="font-size:13px;color:var(--ink-soft);margin:0 0 8px;">By ${esc(finalized.by)}${finalized.paymentRef ? ' · Ref: ' + esc(finalized.paymentRef) : ''}. Deducted from: <b>${lineList}</b>.</p>
        ${r.budgetSync ? `<div style="font-size:13px;">Sheet sync: ${syncLine}</div>` : ''}
      ` : `
        <h4 style="color:#8A6412;">🔒 Budget reserved — not yet deducted</h4>
        <p style="font-size:13px;color:var(--ink-soft);margin:0 0 10px;">
          <b>${lineList}</b> ${lines.length > 1 ? 'are' : 'is'} blocked so ${lines.length > 1 ? 'they' : 'it'} can't be double-booked, but <b>not deducted yet</b>.
          The actual deduction happens only when the Accountant finalizes the payment — e.g. once the cheque is issued.
        </p>
        ${canFinalize ? `
        <div class="field" style="margin-bottom:8px;"><label>Cheque / Transfer reference (optional)</label><input id="finalizeRef" placeholder="e.g. Cheque #10234"></div>
        <button class="btn gold" id="finalizeBtn">Finalize Payment — deduct from budget</button>
        ` : `<p style="font-size:12.5px;color:var(--ink-soft);">Only the Accountant or an Administrator can finalize this payment.</p>`}
      `}
    </div>` : ''}`;
  }
  const cur = currentStageKey(r);
  if (!cur || cur !== state.user.role) return '';
  const asg = r.assigned && r.assigned[cur];
  if (asg && asg.type === 'group') {
    const ap = r.approvals[cur];
    const votes = ap && ap.votes ? ap.votes : {};
    const votedCount = Object.keys(votes).length;
    const isMember = (asg.members || []).some(m => m.id === state.user.id);
    if (!isMember) {
      return `<div class="approve-box"><h4>Assigned to team "${esc(asg.name)}"</h4><p style="font-size:13px;color:var(--ink-soft);margin:0;">This stage is routed to a team you're not a member of.</p></div>`;
    }
    if (asg.policy === 'all' && votes[state.user.id]) {
      return `<div class="approve-box"><h4>✓ You approved — waiting for teammates</h4>
        <p style="font-size:13px;color:var(--ink-soft);margin:0;">${votedCount} of ${asg.members.length} team members have approved. The request moves forward when everyone in "${esc(asg.name)}" has approved.</p>
        <div style="margin-top:8px;font-size:12.5px;">${asg.members.map(m => (votes[m.id] ? '✅ ' : '⬜ ') + esc(m.name)).join(' &nbsp; ')}</div>
      </div>`;
    }
  }
  if (asg && asg.type !== 'group' && asg.id !== state.user.id) {
    return `<div class="approve-box"><h4>Assigned to ${esc(asg.name)}</h4><p style="font-size:13px;color:var(--ink-soft);margin:0;">This request is routed to a different ${stageLabel(cur).toLowerCase()} based on the requester's workflow. Only they can action it.</p></div>`;
  }
  const label = stageLabel(cur);
  const teamNote = asg && asg.type === 'group'
    ? `<p style="font-size:12.5px;color:var(--ink-soft);margin:-4px 0 10px;">Team "${esc(asg.name)}" — ${asg.policy === 'all' ? 'all ' + asg.members.length + ' members must approve (in any order); a single rejection rejects the request.' : 'any one member may decide.'}${(r.approvals[cur] && r.approvals[cur].votes) ? ' Progress: ' + Object.keys(r.approvals[cur].votes).length + '/' + asg.members.length : ''}</p>`
    : '';
  return `
  <div class="approve-box">
    <h4>Your review — ${label}</h4>
    ${teamNote}
    ${cur === 'accountant' ? `
      <div class="row2" style="margin-bottom:12px;">
        <div class="field"><label>Request #</label><input id="a_reqno" placeholder="REQ-0001" value="${esc(r.financeUse.requestNo)}"></div>
        <div class="field"><label>Voucher #</label><input id="a_vouno" value="${esc(r.financeUse.voucherNo)}"></div>
      </div>
      <div class="field"><label>Vendor #</label><input id="a_venno" value="${esc(r.financeUse.vendorNo)}"></div>
    ` : ''}
    <div class="field"><label>Comment (required if rejecting)</label><textarea id="a_comment" rows="2" placeholder="Add a note for the record"></textarea></div>
    <div class="err hidden" id="decisionErr"></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn gold" id="approveBtn">Approve &amp; forward</button>
      <button class="btn danger" id="rejectBtn">Reject</button>
      <button class="btn outline" id="sendBackBtn" title="Return to the requester and clear all approvals">↩ Send back</button>
      ${cur === 'budget' ? '<button class="btn outline" id="editReqBtn">✎ Edit request</button>' : ''}
    </div>
  </div>`;
}
async function openEditRequest() {
  const r = findRequest(state.openId);
  if (!r) return;
  const cf = (r.customFields || []);
  const existing = blOf(r);
  const deptId = r.budgetDeptId || (existing[0] && existing[0].deptId) || '';
  let bLines = [];
  if (deptId) { try { const d = await api('/budget/lines?dept=' + encodeURIComponent(deptId)); bLines = d.lines || []; } catch (e) {} }
  const editSplit = existing.map(l => ({ code: l.code, amount: l.amount }));
  const modal = document.createElement('div');
  modal.className = 'overlay';
  modal.style.zIndex = '60';
  modal.innerHTML = `
    <div class="drawer" style="max-width:600px;">
      <div class="drawer-head"><h3>Edit request ${r.id}</h3><button class="close-x" id="editClose">✕</button></div>
      <p style="font-size:12.5px;color:var(--ink-soft);margin:0 0 12px;">You can adjust these fields before approving. The requester and attachments can't be changed. Earlier approvals stay in place; your edit is logged. If you change the amount, keep the budget split balanced to match.</p>
      <div class="form-grid">
        <div class="field"><label>Payee name</label><input id="e_payee" value="${esc(r.payeeName)}"></div>
        <div class="field"><label>Payee address</label><input id="e_payeeaddr" value="${esc(r.payeeAddress || '')}"></div>
      </div>
      <div class="form-grid">
        <div class="field"><label>Amount</label><input id="e_amount" type="number" step="0.001" value="${esc(r.amount)}"></div>
        <div class="field"><label>Currency</label><input id="e_currency" value="${esc(r.currency)}"></div>
      </div>
      <div class="field"><label>Payment method</label>
        <select id="e_method"><option ${r.paymentMethod === 'Cheque' ? 'selected' : ''}>Cheque</option><option ${r.paymentMethod === 'Bank Transfer' ? 'selected' : ''}>Bank Transfer</option></select>
      </div>
      <div class="field"><label>Description</label><textarea id="e_desc" rows="3">${esc(r.description)}</textarea></div>
      ${deptId ? `
      <div class="field"><label>Budget lines${existing[0] && existing[0].deptName ? ' — ' + esc(existing[0].deptName) : ''}</label>
        <div id="eSplitRows"></div>
        <button type="button" class="btn outline" id="eAddSplit" style="margin-top:6px;">+ Add line</button>
        <div id="eSplitSummary" style="font-size:12.5px;margin-top:6px;"></div>
      </div>` : ''}
      ${cf.length ? '<div class="section-title">Additional Information</div>' + cf.map(f => `<div class="field"><label>${esc(f.label)}</label><input class="e_cf" data-id="${f.id}" value="${esc(f.value || '')}"></div>`).join('') : ''}
      <div class="err hidden" id="editErr" style="margin-top:8px;"></div>
      <div style="display:flex;gap:10px;margin-top:12px;">
        <button class="btn gold" id="editSave">Save changes</button>
        <button class="btn outline" id="editCancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('#editClose').onclick = close;
  modal.querySelector('#editCancel').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };

  const eRows = modal.querySelector('#eSplitRows');
  const drawESplit = () => {
    if (!eRows) return;
    eRows.innerHTML = editSplit.map((row, i) => `
      <div style="display:flex;gap:8px;margin-bottom:6px;align-items:center;">
        <input class="es-code" data-i="${i}" list="eDeptOptions" autocomplete="off" value="${esc(row.code)}" placeholder="🔍 line" style="flex:2;">
        <input class="es-amt" data-i="${i}" type="number" step="0.001" value="${row.amount || ''}" placeholder="Amount" style="width:110px;">
        <button type="button" class="mini-btn del es-del" data-i="${i}">✕</button>
      </div>`).join('') +
      `<datalist id="eDeptOptions">${bLines.map(l => `<option data-code="${esc(l.code)}" value="${esc(l.code)} — ${esc(l.description)} (Avail: ${l.available.toLocaleString(undefined, { minimumFractionDigits: 3 })} KD)"></option>`).join('')}</datalist>`;
    eRows.querySelectorAll('.es-code').forEach(inp => inp.oninput = () => {
      const opts = Array.from(eRows.querySelectorAll('#eDeptOptions option'));
      const m = opts.find(o => o.value === inp.value) || opts.find(o => inp.value && o.dataset.code && inp.value.toLowerCase().startsWith(o.dataset.code.toLowerCase()));
      editSplit[Number(inp.dataset.i)].code = m ? m.dataset.code : inp.value.trim(); eSummary();
    });
    eRows.querySelectorAll('.es-amt').forEach(inp => inp.oninput = () => { editSplit[Number(inp.dataset.i)].amount = inp.value; eSummary(); });
    eRows.querySelectorAll('.es-del').forEach(btn => btn.onclick = () => { editSplit.splice(Number(btn.dataset.i), 1); drawESplit(); eSummary(); });
  };
  const eSummary = () => {
    const el = modal.querySelector('#eSplitSummary'); if (!el) return;
    const total = Number(modal.querySelector('#e_amount').value || 0);
    const sum = editSplit.reduce((a, r2) => a + Number(r2.amount || 0), 0);
    el.innerHTML = Math.abs(total - sum) < 0.0005
      ? `<span style="color:var(--green);font-weight:600;">✓ split balanced (${sum.toFixed(3)})</span>`
      : `<span style="color:var(--red);font-weight:600;">split ${sum.toFixed(3)} ≠ amount ${total.toFixed(3)}</span>`;
  };
  if (eRows) {
    drawESplit(); eSummary();
    modal.querySelector('#eAddSplit').onclick = () => { editSplit.push({ code: '', amount: '' }); drawESplit(); eSummary(); };
    modal.querySelector('#e_amount').addEventListener('input', eSummary);
  }

  modal.querySelector('#editSave').onclick = async () => {
    const errEl = modal.querySelector('#editErr');
    const cfVals = {};
    modal.querySelectorAll('.e_cf').forEach(i => cfVals[i.dataset.id] = i.value);
    const body = {
      payeeName: modal.querySelector('#e_payee').value,
      payeeAddress: modal.querySelector('#e_payeeaddr').value,
      amount: modal.querySelector('#e_amount').value,
      currency: modal.querySelector('#e_currency').value,
      paymentMethod: modal.querySelector('#e_method').value,
      description: modal.querySelector('#e_desc').value,
      customFieldValues: JSON.stringify(cfVals),
    };
    if (eRows) {
      const rows = editSplit.filter(x => x.code && Number(x.amount) > 0);
      body.budgetLines = JSON.stringify(rows.map(x => ({ deptId, code: x.code, amount: Number(x.amount) })));
    }
    try {
      await api('/requests/' + r.id + '/edit', { method: 'PATCH', body: JSON.stringify(body) });
      await refreshRequests();
      close();
      render();
    } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  };
}

function bindDrawer() {
  const closeBtn = document.getElementById('closeDrawer');
  if (closeBtn) closeBtn.onclick = () => { state.openId = null; state.tab = 'dashboard'; render(); };
  const overlay = document.getElementById('overlayEl');
  if (overlay) overlay.onclick = e => { if (e.target === overlay) { state.openId = null; state.tab = 'dashboard'; render(); } };

  document.querySelectorAll('.aview').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.att;
      const box = document.getElementById('prev_' + id);
      if (!box) return;
      if (!box.classList.contains('hidden')) { box.classList.add('hidden'); btn.textContent = 'View'; return; }
      const url = '/api/files/' + id;
      const body = btn.dataset.type.startsWith('image/')
        ? `<img src="${url}" alt="${btn.dataset.name}">`
        : `<embed src="${url}" type="application/pdf">`;
      box.innerHTML = `
        <div class="ap-bar">
          <span>${btn.dataset.name}</span>
          <a class="btn outline" style="padding:5px 12px;font-size:12px;text-decoration:none;" href="${url}" target="_blank">⬇ Open / Download</a>
        </div>${body}`;
      box.classList.remove('hidden');
      btn.textContent = 'Hide';
    };
  });

  const printBtn = document.getElementById('printBtn');
  if (printBtn) printBtn.onclick = () => { state.tab = 'print'; render(); };
  const retryBudgetBtn = document.getElementById('retryBudgetBtn');
  if (retryBudgetBtn) retryBudgetBtn.onclick = async () => {
    retryBudgetBtn.disabled = true; retryBudgetBtn.textContent = 'Retrying…';
    try {
      await api('/budget/sync/' + state.openId, { method: 'POST' });
      setTimeout(async () => { await refreshRequests(); render(); }, 2500);
    } catch (e) { alert(e.message); retryBudgetBtn.disabled = false; retryBudgetBtn.textContent = 'Retry budget sync'; }
  };
  const finalizeBtn = document.getElementById('finalizeBtn');
  if (finalizeBtn) finalizeBtn.onclick = async () => {
    finalizeBtn.disabled = true; finalizeBtn.textContent = 'Finalizing…';
    try {
      await api('/requests/' + state.openId + '/finalize', { method: 'POST', body: JSON.stringify({ paymentRef: (document.getElementById('finalizeRef') || {}).value || '' }) });
      await refreshRequests();
      render();
    } catch (e) {
      alert(e.message);
      finalizeBtn.disabled = false; finalizeBtn.textContent = 'Finalize Payment — deduct from budget';
    }
  };
  const approveBtn = document.getElementById('approveBtn');
  const rejectBtn = document.getElementById('rejectBtn');
  if (approveBtn) approveBtn.onclick = () => handleDecision('approved');
  if (rejectBtn) rejectBtn.onclick = () => handleDecision('rejected');
  const editReqBtn = document.getElementById('editReqBtn');
  if (editReqBtn) editReqBtn.onclick = () => openEditRequest();
  const sendBackBtn = document.getElementById('sendBackBtn');
  if (sendBackBtn) sendBackBtn.onclick = async () => {
    const reason = prompt('Send this request back to the requester for rework. All approvals will be cleared and it restarts the chain.\n\nReason (required):');
    if (reason === null) return;
    if (!reason.trim()) { alert('A reason is required to send a request back.'); return; }
    try {
      await api('/requests/' + state.openId + '/send-back', { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      await refreshRequests(); state.tab = 'dashboard'; render();
    } catch (e) { alert(e.message); }
  };
  const recallBtn = document.getElementById('recallBtn');
  if (recallBtn) recallBtn.onclick = async () => {
    if (!confirm('Recall this request? All approvals so far will be cleared and it returns to the start of the chain.')) return;
    recallBtn.disabled = true;
    try {
      await api('/requests/' + state.openId + '/recall', { method: 'POST', body: JSON.stringify({ reason: (document.getElementById('recallReason') || {}).value || '' }) });
      await refreshRequests(); render();
    } catch (e) { alert(e.message); recallBtn.disabled = false; }
  };
  const cancelReqBtn = document.getElementById('cancelReqBtn');
  if (cancelReqBtn) cancelReqBtn.onclick = async () => {
    const reason = (document.getElementById('cancelReason') || {}).value.trim();
    if (!reason) { alert('A reason is required to cancel a request.'); return; }
    if (!confirm('Cancel this request permanently? This cannot be undone.')) return;
    cancelReqBtn.disabled = true;
    try {
      await api('/requests/' + state.openId + '/cancel', { method: 'POST', body: JSON.stringify({ reason }) });
      await refreshRequests(); render();
    } catch (e) { alert(e.message); cancelReqBtn.disabled = false; }
  };
  if (state.tab === 'print') {
    const printNowBtn = document.getElementById('printNowBtn');
    if (printNowBtn) printNowBtn.onclick = () => window.print();
    const backBtn = document.getElementById('backFromPrint');
    if (backBtn) backBtn.onclick = () => { state.tab = 'dashboard'; render(); };
  }
}
async function handleDecision(decision) {
  const errEl = document.getElementById('decisionErr');
  const financeUse = document.getElementById('a_reqno') ? {
    requestNo: document.getElementById('a_reqno').value.trim(),
    voucherNo: document.getElementById('a_vouno').value.trim(),
    vendorNo: document.getElementById('a_venno').value.trim(),
  } : undefined;
  try {
    await api('/requests/' + state.openId + '/decision', {
      method: 'POST',
      body: JSON.stringify({ decision, comment: (document.getElementById('a_comment') || {}).value || '', financeUse }),
    });
    await refreshRequests();
    state.tab = 'dashboard';
    render();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
    else alert(e.message);
  }
}

/* ============ PRINT SHEET ============ */
const STD_PRINT_ACCESSORS = {
  department: r => esc(r.department),
  requestDate: r => fmtDate(r.createdAt),
  requestorName: r => esc(r.requestorName),
  requestorPhone: r => esc(r.requestorPhone) || '—',
  payeeName: r => esc(r.payeeName),
  payeeAddress: r => (esc(r.payeeAddress) || '—') + (r.payeePhone ? ' · ' + esc(r.payeePhone) : ''),
  paymentType: r => esc(r.paymentType) + (r.paymentTypeOther ? (': ' + esc(r.paymentTypeOther)) : ''),
  paymentMethod: r => esc(r.paymentMethod),
  amount: r => fmtMoney(r.amount, r.currency),
  currency: r => esc(r.currency),
  description: r => esc(r.description),
  budgetLine: r => blHasBudget(r) ? blOf(r).map(l => esc(l.code) + ' (' + Number(l.amount).toFixed(3) + ')').join(', ') + (blOf(r)[0].deptName ? ' · ' + esc(blOf(r)[0].deptName) : '') : '—',
  documents: r => {
    const metas = r.attachments || [];
    return [...metas.map(m => m.name), ...(r.documents || [])].map(esc).join(' · ') || '—';
  },
  financeRequestNo: r => esc(r.financeUse.requestNo) || '—',
  financeVoucherNo: r => esc(r.financeUse.voucherNo) || '—',
  financeVendorNo: r => esc(r.financeUse.vendorNo) || '—',
};
function customFieldPrintValue(r, fieldId) {
  const f = (r.customFields || []).find(x => x.id === fieldId);
  return f && f.value ? esc(f.value) : '—';
}
function printSheet(r, opts) {
  opts = opts || {};
  const layout = opts.layout || [];
  const previewMode = !!opts.previewMode;
  const p = Object.assign({
    orgName: 'Sama Educational Co.', logoInitial: 'S', formTitle: 'PAYMENT REQUEST', headerNote: '',
    showBanner: true, showApprovals: true, showAttachments: true,
    footerLine: 'Physical signature required below to complete filing',
    signatoryLabel: 'Authorized Signatory', footerNote: '',
  }, cache.printSettings || {});
  const metas = r.attachments || [];
  const imageAtts = p.showAttachments ? metas.filter(a => a.type.startsWith('image/')) : [];
  const pdfAtts = p.showAttachments ? metas.filter(a => a.type === 'application/pdf') : [];
  const controls = previewMode ? '' : `
  <div class="no-print" style="max-width:820px;margin:0 auto 14px;display:flex;justify-content:space-between;">
    <button class="btn outline" id="backFromPrint">← Back</button>
    <button class="btn gold" id="printNowBtn">🖨 Print / Save as PDF</button>
  </div>
  ${pdfAtts.length ? `
  <div class="no-print doc-card" style="max-width:820px;margin:0 auto 14px;">
    <b style="color:var(--navy-deep);font-size:13px;">Attached PDFs print separately</b>
    <div style="font-size:12.5px;color:var(--ink-soft);margin:4px 0 8px;">Browsers can't merge PDF attachments into this printout. Open each one and print it after the form — image attachments below are already included.</div>
    ${pdfAtts.map(a => `<a class="btn outline" style="padding:6px 12px;font-size:12px;text-decoration:none;margin-right:8px;" href="/api/files/${a.id}" target="_blank">📄 ${esc(a.name)}</a>`).join('')}
  </div>` : ''}`;
  const fieldRows = layout.filter(b => b.visible).map(b => {
    if (b.kind === 'header') return `<div class="pf-section-title">${esc(b.label)}</div>`;
    let value;
    if (b.kind === 'static') value = esc(b.staticText || '');
    else if (b.kind === 'custom') value = customFieldPrintValue(r, b.sourceKey);
    else value = STD_PRINT_ACCESSORS[b.sourceKey] ? STD_PRINT_ACCESSORS[b.sourceKey](r) : '—';
    return `<div class="pf-row"><div class="pf-cell"><span class="pf-label">${esc(b.label)}</span>${value}</div></div>`;
  }).join('');
  return `
  ${controls}
  <div class="print-sheet">
    <div class="ph-logo">${cache.branding && cache.branding.hasLogo ? `<img src="/api/logo?t=${Date.now()}" alt="logo" style="height:40px;max-width:120px;object-fit:contain;">` : `<div class="brand-mark" style="background:#1D4A94;color:#fff;">${esc(p.logoInitial)}</div>`}<div><b>${esc(p.orgName)}</b></div></div>
    <h2>${esc(p.formTitle)}</h2>
    ${p.headerNote ? `<div style="text-align:center;font-size:11.5px;color:#555;margin:-12px 0 14px;">${esc(p.headerNote)}</div>` : ''}
    ${p.showBanner && r.status === 'approved' ? `
    <div style="border:2px solid #2F7D5A;color:#2F7D5A;text-align:center;padding:8px;margin-bottom:14px;font-weight:700;letter-spacing:1px;font-size:13px;">
      ✓ ALL APPROVALS COMPLETE — ${chainFor(r).map(k => stageLabel(k).toUpperCase()).join(' · ')}<br>
      <span style="font-weight:500;letter-spacing:.3px;font-size:11.5px;">Workflow completed on ${fmtDate(r.completedAt || r.createdAt)} · Ref ${r.id} · Ready for final signature &amp; filing</span>
    </div>` : ''}
    <div class="pf-block">
      ${fieldRows}
    </div>
    ${p.showApprovals ? `
    <div class="pf-section-title" style="margin-top:16px;border:1px solid #222;border-bottom:none;">Digital Approvals on Record</div>
    <div class="sig-grid" style="border:1px solid #222;">
      ${chainFor(r).map((k, i, arr) => {
        const ap = r.approvals[k];
        const lastRow = i >= arr.length - (arr.length % 2 === 0 ? 2 : 1);
        const who = ap ? (ap.group && ap.votes ? Object.values(ap.votes).map(v => v.by).join(', ') : ap.by) : '—';
        /* collect the approver user id(s) so we can show their signature/stamp */
        let ids = [];
        if (ap) {
          if (ap.group && ap.votes) ids = Object.values(ap.votes).map(v => v.byId).filter(Boolean);
          else if (ap.byId) ids = [ap.byId];
        }
        const marks = ids.map(uid => `
          <img class="sig-img" src="/api/signature/${uid}/signature" alt="" onerror="this.style.display='none'">
          <img class="stamp-img" src="/api/signature/${uid}/stamp" alt="" onerror="this.style.display='none'">
        `).join('');
        return `<div class="sig-cell" ${lastRow ? 'style="border-bottom:none;"' : ''}>
          <span class="pf-label">${stageLabel(k)}</span>${esc(who)}
          <div class="sig-marks">${marks}</div>
          <div class="sig-line">${ap ? fmtDate(ap.at) : ''}</div>
        </div>`;
      }).join('')}
      ${chainFor(r).length % 2 === 1 ? '<div class="sig-cell" style="border-bottom:none;"></div>' : ''}
    </div>` : ''}
    <div class="final-sig">${esc(p.footerLine)}<br><br>
      _________________________________________<br>
      ${esc(p.signatoryLabel)} · Date: ____________
    </div>
    ${p.footerNote ? `<div style="margin-top:10px;font-size:11px;color:#666;text-align:center;">${esc(p.footerNote)}</div>` : ''}
    ${imageAtts.map((a, n) => `
    <div class="print-attachment">
      <h3>Attachment ${n + 1} of ${imageAtts.length}: ${esc(a.name)} — ${r.id}</h3>
      <img src="/api/files/${a.id}" alt="${esc(a.name)}">
    </div>`).join('')}
  </div>`;
}

/* ============ boot: restore session ============ */
(async () => {
  await applyBranding();
  try {
    const { user } = await api('/me');
    if (user) { state.user = user; if (user.mustChangePassword) state.tab = 'password'; }
  } catch (e) {}
  render();
})();
