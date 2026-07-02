/* ── State ──────────────────────────────────────────────── */
const state = {
  nav: 'dashboard', cases: [], activeCaseId: null, activeDoc: 'obituary',
  activeCaseTab: 'documents', isGenerating: false, editingDoc: false,
  progressTimer: null, autoSaveTimer: null,
  authToken: localStorage.getItem('fh_auth_token') || '',
  currentUser: null, organization: null, plan: null, authTried: false,
};

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

/* ── Toast ──────────────────────────────────────────────── */
function toast(msg, isError = false) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  void el.offsetWidth;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 4000);
}

/* ── Modal ──────────────────────────────────────────────── */
function showModal(html) {
  const m = $('#modal'); const b = $('#modalBody');
  if (!m || !b) return;
  b.innerHTML = html; m.style.display = 'flex';
}
function hideModal() { const m = $('#modal'); if (m) m.style.display = 'none'; }

/* ── Navigation ─────────────────────────────────────────── */
function showNav(view) {
  state.nav = view;
  $$('.view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById('view' + view.charAt(0).toUpperCase() + view.slice(1));
  if (target) target.classList.add('active');
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
}

/* ── API helpers ────────────────────────────────────────── */
async function api(path, opts = {}) {
  try {
    const headers = { 'Content-Type': 'application/json', ...opts.headers };
    if (state.authToken) headers.Authorization = `Bearer ${state.authToken}`;
    const res = await fetch(path, { headers, ...opts });
    if (res.status === 401) {
      state.authToken = '';
      localStorage.removeItem('fh_auth_token');
    }
    if (!res.ok) { const err = await res.json().catch(() => ({ error: res.statusText })); throw new Error(err.error || 'API error'); }
    return opts.raw ? res : await res.json();
  } catch (e) { toast(e.message, true); throw e; }
}

function updateSessionChrome() {
  const status = $('#statusText');
  const user = $('#accountUser');
  const usage = $('#usageMiniValue');
  const loginBtn = $('#btnSidebarLogin');
  const registerBtn = $('#btnSidebarRegister');
  const logoutBtn = $('#btnSidebarLogout');
  const dot = $('#statusDot');

  if (state.currentUser) {
    if (status) status.textContent = 'Signed in';
    if (user) user.textContent = `${state.currentUser.name} · ${state.organization?.name || 'Tenant'}`;
    if (loginBtn) loginBtn.style.display = 'none';
    if (registerBtn) registerBtn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = '';
    if (dot) dot.classList.add('online');
  } else {
    if (status) status.textContent = 'Signed out';
    if (user) user.textContent = 'Sign in to load tenant data.';
    if (usage) usage.textContent = '- / -';
    if (loginBtn) loginBtn.style.display = '';
    if (registerBtn) registerBtn.style.display = '';
    if (logoutBtn) logoutBtn.style.display = 'none';
    if (dot) dot.classList.remove('online');
  }
}

function clearSignedOutUi() {
  state.activeCaseId = null;
  state.activeCaseTab = 'documents';
  state.isGenerating = false;
  state.editingDoc = false;
  state.cases = [];

  $('#statOpenCases') && ($('#statOpenCases').textContent = '0');
  $('#statTodayCases') && ($('#statTodayCases').textContent = '0');
  $('#statTotalCases') && ($('#statTotalCases').textContent = '0');
  $('#statRevenue') && ($('#statRevenue').textContent = '$0');
  $('#statPreNeed') && ($('#statPreNeed').textContent = '0');
  $('#statusBreakdown') && ($('#statusBreakdown').innerHTML = '<p class="muted">Sign in to load tenant data.</p>');
  $('#griefResources') && ($('#griefResources').innerHTML = '');
  $('#docBody') && ($('#docBody').innerHTML = '<p class="muted">Sign in and select a case to view documents.</p>');
  $('#caseTitle') && ($('#caseTitle').textContent = 'No case selected');
  $('#caseSubtitle') && ($('#caseSubtitle').textContent = '');
  $('#disclaimerSection') && ($('#disclaimerSection').style.display = 'none');

  renderCaseList();
  renderCasesTable();
  showNav('dashboard');
}

function showLoginModal() {
  showModal(`
    <div class="modal-header-block">
      <p class="view-eyebrow">Secure Access</p>
      <h3>Sign In</h3>
      <p class="modal-subtitle">Use a staff account to access customer data, billing controls, and AI document generation.</p>
    </div>
    <form id="loginForm">
      <div class="field-row"><div class="field flex-2"><label>Email</label><input type="email" id="loginEmail" name="email" value="admin@funeralhome.com" /></div></div>
      <div class="field-row"><div class="field flex-2"><label>Password</label><input type="password" id="loginPassword" name="password" value="admin123" /></div></div>
      <div class="compliance-card login-note">Local seed credentials are for development. Set DEFAULT_ADMIN_PASSWORD before production deployment.</div>
      <div class="btn-row modal-actions"><button type="submit" class="btn-primary" id="btnLoginSubmit">Sign In</button></div>
    </form>
  `);
  $('#loginForm')?.addEventListener('submit', e => login(e));
}

function showRegisterModal() {
  showModal(`
    <div class="modal-header-block">
      <p class="view-eyebrow">New Funeral Home</p>
      <h3>Create Account</h3>
      <p class="modal-subtitle">Register a funeral home tenant with a separate admin account and isolated data.</p>
    </div>
    <form id="registerForm">
      <div class="field-row">
        <div class="field flex-2"><label>Funeral Home Name</label><input type="text" id="registerOrgName" name="organization_name" placeholder="Example Funeral Home" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Your Name</label><input type="text" id="registerName" name="name" placeholder="Owner or manager" /></div>
        <div class="field"><label>Email</label><input type="email" id="registerEmail" name="email" placeholder="owner@example.com" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Password</label><input type="password" id="registerPassword" name="password" placeholder="At least 8 characters" /></div>
        <div class="field"><label>Plan</label><select id="registerPlan" name="plan_id"><option value="professional">Professional Trial</option><option value="starter">Starter Trial</option><option value="enterprise">Enterprise Trial</option></select></div>
      </div>
      <div class="compliance-card login-note">Registration creates a new tenant. Keep each funeral home's account separate for privacy and billing.</div>
      <div class="btn-row modal-actions"><button type="submit" class="btn-primary" id="btnRegisterSubmit">Create Account</button><button type="button" class="btn-outline" onclick="showLoginModal()">Back to Sign In</button></div>
    </form>
  `);
  $('#registerForm')?.addEventListener('submit', e => register(e));
}

async function login(e) {
  e?.preventDefault();
  const submit = $('#btnLoginSubmit');
  const form = $('#loginForm');
  const formData = form ? new FormData(form) : null;
  let email = (formData?.get('email') || $('#loginEmail')?.value || $('#loginEmail')?.getAttribute('value') || '').toString().trim();
  let password = (formData?.get('password') || $('#loginPassword')?.value || $('#loginPassword')?.getAttribute('value') || '').toString().trim();
  if ((!email || !password) && ['localhost', '127.0.0.1'].includes(location.hostname)) {
    email = email || 'admin@funeralhome.com';
    password = password || 'admin123';
  }
  if (!email || !password) return toast('Email and password required.', true);
  if (submit) {
    submit.disabled = true;
    submit.textContent = 'Signing in...';
  }
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Sign in failed');
    }
    const session = await res.json();
    state.authToken = session.token;
    state.currentUser = session.user;
    state.organization = session.organization;
    localStorage.setItem('fh_auth_token', session.token);
    hideModal();
    updateSessionChrome();
    await initAppData();
    toast('Signed in.');
  } catch (e) {
    if (submit) {
      submit.disabled = false;
      submit.textContent = 'Sign In';
    }
    toast(e.message, true);
  }
}

async function register(e) {
  e?.preventDefault();
  const submit = $('#btnRegisterSubmit');
  const form = $('#registerForm');
  const formData = form ? new FormData(form) : null;
  const payload = {
    organization_name: (formData?.get('organization_name') || '').toString().trim(),
    name: (formData?.get('name') || '').toString().trim(),
    email: (formData?.get('email') || '').toString().trim(),
    password: (formData?.get('password') || '').toString(),
    plan_id: (formData?.get('plan_id') || 'professional').toString(),
  };
  if (!payload.organization_name || !payload.name || !payload.email || !payload.password) {
    return toast('Organization, name, email, and password are required.', true);
  }
  if (payload.password.length < 8) return toast('Password must be at least 8 characters.', true);
  if (submit) {
    submit.disabled = true;
    submit.textContent = 'Creating...';
  }
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Registration failed');
    }
    const session = await res.json();
    state.authToken = session.token;
    state.currentUser = session.user;
    state.organization = session.organization;
    localStorage.setItem('fh_auth_token', session.token);
    hideModal();
    updateSessionChrome();
    await initAppData();
    toast('Account created.');
  } catch (e) {
    if (submit) {
      submit.disabled = false;
      submit.textContent = 'Create Account';
    }
    toast(e.message, true);
  }
}

async function restoreSession() {
  if (state.authTried) return !!state.authToken;
  state.authTried = true;

  if (!state.authToken) {
    updateSessionChrome();
    return false;
  }
  try {
    const me = await api('/api/auth/me');
    state.currentUser = me.user;
    state.organization = me.organization;
    state.plan = me.plan;
    updateSessionChrome();
    return true;
  } catch (e) {
    state.authToken = '';
    localStorage.removeItem('fh_auth_token');
    state.currentUser = null;
    state.organization = null;
    state.plan = null;
    updateSessionChrome();
    return false;
  }
}

async function loadUsageMini() {
  if (!state.authToken) return;
  try {
    const usage = await api('/api/usage');
    const used = usage.usage?.ai_document_generated || 0;
    const limit = usage.plan?.included_ai_documents || 0;
    const hard = usage.plan ? ` / ${limit}` : '';
    const el = $('#usageMiniValue');
    if (el) el.textContent = `${used}${hard}`;
  } catch (e) { /* api already surfaced */ }
}

/* ── Dashboard ──────────────────────────────────────────── */
async function loadDashboard() {
  try {
    const d = await api('/api/dashboard');
    $('#statOpenCases').textContent = d.openCases || 0;
    $('#statTodayCases').textContent = d.todayCases || 0;
    $('#statTotalCases').textContent = d.totalCases || 0;
    $('#statRevenue').textContent = '$' + (d.totalRevenue || 0).toLocaleString();
    $('#statPreNeed').textContent = d.activePreNeeds || 0;
    const sb = $('#statusBreakdown');
    if (sb) {
      const statusLabels = { first_call: 'First Call', removal: 'Removal', arrangement_pending: 'Arrangement', arrangement_done: 'Arr. Done', documents_generating: 'Generating', documents_ready: 'Ready', service_planned: 'Planned', service_in_progress: 'In Progress', service_completed: 'Completed', post_service: 'Post-Service', closed: 'Closed' };
      const colors = ['#6366f1','#8b5cf6','#a855f7','#d946ef','#ec4899','#f43f5e','#f97316','#eab308','#22c55e','#14b8a6','#6b7280'];
      const entries = Object.entries(d.byStatus || {});
      sb.innerHTML = entries.length ? entries.map(([k, v], i) => `<div class="status-bar"><span class="sb-label">${statusLabels[k]||k}</span><div class="sb-track"><div class="sb-fill" style="width:${(v/Math.max(...Object.values(d.byStatus)))*100}%;background:${colors[i%colors.length]}"></div></div><span class="sb-count">${v}</span></div>`).join('') : '<p class="muted">No cases yet.</p>';
    }

    // Grief resources
    const gr = $('#griefResources');
    if (gr) {
      const r = await api('/api/grief-resources');
      gr.innerHTML = (r.resources || []).map(res => `<a href="${res.url}" target="_blank" class="resource-card"><strong>${res.name}</strong><span>${res.desc}</span></a>`).join('');
    }
  } catch (e) { /* silent */ }
}

/* ── Case List ──────────────────────────────────────────── */
async function loadCases() {
  try {
    state.cases = await api('/api/cases');
    renderCaseList();
    renderCasesTable();
  } catch (e) { /* silent */ }
}

function renderCaseList() {
  const list = $('#caseList');
  if (!list) return;
  const empty = list.querySelector('.case-list-empty');
  list.querySelectorAll('.case-link').forEach(el => el.remove());
  if (!state.cases.length) { if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  state.cases.slice(0, 8).forEach(c => {
    const a = document.createElement('button');
    a.className = 'case-link' + (c.id === state.activeCaseId ? ' active' : '');
    a.innerHTML = `<div class="cl-name">${escHtml(c.deceased?.fullName || 'Unknown')}</div><div class="cl-status">${c.statusLabel || c.status}</div>`;
    a.onclick = () => openCase(c.id);
    list.appendChild(a);
  });
}

function renderCasesTable() {
  const body = $('#casesBody');
  const empty = $('#casesEmpty');
  if (!body) return;
  if (!state.cases.length) { body.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  body.innerHTML = state.cases.map(c => `<tr onclick="openCase('${c.id}')"><td>${escHtml(c.deceased?.fullName || '—')}</td><td>${c.deceased?.dateOfDeath || '—'}</td><td><span class="status-badge status-${c.status || 'first_call'}">${c.statusLabel || c.status}</span></td><td>${formatDate(c.createdAt)}</td><td class="tr-act"><button onclick="event.stopPropagation();deleteCase('${c.id}')" class="btn-text danger">✕</button></td></tr>`).join('');
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function formatDate(iso) { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function formatDateTime(iso) { if (!iso) return ''; const d = new Date(iso); return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }

async function deleteCase(id) {
  if (!confirm('Delete this case? This cannot be undone.')) return;
  await api(`/api/cases/${id}`, { method: 'DELETE' });
  if (state.activeCaseId === id) { state.activeCaseId = null; showNav('dashboard'); }
  await loadCases();
  toast('Case deleted.');
}

/* ── Create / Edit Case ─────────────────────────────────── */
function gatherFormData() {
  const g = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  return {
    fullName: g('f-fullName'), age: g('f-age'), dateOfBirth: g('f-dob'), dateOfDeath: g('f-dod'),
    placeOfDeath: g('f-pob'), residence: g('f-residence'), causeOfDeath: g('f-cause'),
    sex: g('f-sex'), maritalStatus: g('f-marital'), occupation: g('f-occupation'), education: g('f-education'),
    spouse: g('f-spouse'), children: g('f-children'), grandchildren: g('f-grandchildren'),
    predeceasedBy: g('f-predeceased'), fatherName: g('f-father'), motherName: g('f-mother'),
    tone: g('f-tone'), religion: g('f-religion'), disposition: g('f-disposition'),
    funeralHome: g('f-funeralHome'), serviceDate: g('f-serviceDate'), serviceLocation: g('f-serviceLocation'),
    visitation: g('f-visitation'), burial: g('f-burial'), militaryService: g('f-military'),
    organizations: g('f-organizations'), hobbies: g('f-hobbies'), charities: g('f-charities'), notes: g('f-notes'),
  };
}

function fillForm(data) {
  const map = { 'f-fullName': 'fullName', 'f-age': 'age', 'f-dob': 'dateOfBirth', 'f-dod': 'dateOfDeath',
    'f-pob': 'placeOfDeath', 'f-residence': 'residence', 'f-cause': 'causeOfDeath',
    'f-sex': 'sex', 'f-marital': 'maritalStatus', 'f-occupation': 'occupation', 'f-education': 'education',
    'f-spouse': 'spouse', 'f-children': 'children', 'f-grandchildren': 'grandchildren', 'f-predeceased': 'predeceasedBy',
    'f-father': 'fatherName', 'f-mother': 'motherName', 'f-tone': 'tone', 'f-religion': 'religion',
    'f-disposition': 'disposition', 'f-funeralHome': 'funeralHome', 'f-serviceDate': 'serviceDate',
    'f-serviceLocation': 'serviceLocation', 'f-visitation': 'visitation', 'f-burial': 'burial',
    'f-military': 'militaryService', 'f-organizations': 'organizations', 'f-hobbies': 'hobbies',
    'f-charities': 'charities', 'f-notes': 'notes' };
  for (const [elId, key] of Object.entries(map)) {
    const el = document.getElementById(elId);
    if (el) el.value = data[key] || '';
  }
}

function clearForm() {
  $$('#viewForm input, #viewForm textarea, #viewForm select').forEach(el => { if (el.type === 'number' || el.type === 'date' || el.tagName === 'SELECT') el.value = ''; else el.value = ''; });
}

async function createCase() {
  const data = gatherFormData();
  if (!data.fullName) { toast('Please enter the deceased\'s full name.', true); return; }
  if (!data.dateOfDeath) { toast('Please enter the date of death.', true); return; }
  state.isGenerating = true;
  try {
    const result = await api('/api/cases', { method: 'POST', body: JSON.stringify({ deceased: data }) });
    state.activeCaseId = result.id;
    await loadCases();
    showNav('case');
    toast('Case created. Generating documents...');
    pollCaseReady(result.id);
  } catch (e) { state.isGenerating = false; }
}

async function pollCaseReady(caseId) {
  const check = async () => {
    try {
      const c = await api(`/api/cases/${caseId}`);
      if (c.status === 'documents_ready' || c.status === 'documents_generating') {
        renderCaseFull(c);
        if (c.status === 'documents_ready') {
          state.isGenerating = false;
          toast('All documents generated.');
          return;
        }
      }
      setTimeout(check, 2000);
    } catch (e) { setTimeout(check, 2000); }
  };
  check();
}

async function openCase(id) {
  if (state.isGenerating && id !== state.activeCaseId) return;
  state.activeCaseId = id;
  showNav('case');
  try {
    const c = await api(`/api/cases/${id}`);
    renderCaseFull(c);
    await loadCases();
  } catch (e) { toast('Failed to load case', true); }
}

/* ── Render Case Detail ─────────────────────────────────── */
function renderCaseFull(c) {
  state.activeCaseTab = 'documents';

  $('#caseEyebrow').textContent = 'Case';
  $('#caseTitle').textContent = c.deceased?.fullName || '—';
  const parts = [];
  if (c.deceased?.dateOfDeath) parts.push(`Died ${c.deceased.dateOfDeath}`);
  if (c.deceased?.age) parts.push(`Age ${c.deceased.age}`);
  $('#caseSubtitle').textContent = parts.join(' · ') + ` · ${c.statusLabel || c.status}`;

  // Lifecycle bar
  const stages = ['first_call','removal','arrangement_pending','arrangement_done','documents_generating','documents_ready','service_planned','service_in_progress','service_completed','post_service','closed'];
  const stageIdx = stages.indexOf(c.status);
  const labels = ['Call','Removal','Arrange','Done','Doc Gen','Doc Ready','Plan','In Prog','Done','Post','Closed'];
  const lcb = $('#lifecycleBar');
  if (lcb) {
    lcb.innerHTML = stages.map((s, i) => `<div class="lc-stage ${i <= stageIdx ? 'lc-done' : ''} ${i === stageIdx ? 'lc-current' : ''}"><div class="lc-dot"></div><div class="lc-label">${labels[i]}</div></div>`).join('');
  }

  // Timeline
  const tl = $('#timelineEntries');
  if (tl && c.timeline) {
    tl.innerHTML = c.timeline.map(t => `<div class="tl-entry"><div class="tl-dot"></div><div class="tl-body"><strong>${t.status}</strong>${t.note ? ' — ' + escHtml(t.note) : ''}<div class="tl-time">${formatDateTime(t.created_at)}</div></div></div>`).join('');
  }

  // Docs
  renderDocument(c, state.activeDoc);

  // Selections
  renderSelections(c);

  // Cremation auth
  if (c.cremationAuthorization) populateAuthForm(c.cremationAuthorization);

  // Memorial
  if (c.memorial) { $('#mem-title').value = c.memorial.public_title || ''; $('#mem-story').value = c.memorial.life_story || ''; }

  // Disclaimer
  const ds = $('#disclaimerSection');
  if (ds) ds.style.display = 'block';
}

/* ── Document Tabs ──────────────────────────────────────── */
function renderDocument(c, docKey) {
  const doc = c.documents?.[docKey];
  const warn = $('#deathCertWarning');
  if (warn) warn.style.display = docKey === 'death_certificate' ? 'block' : 'none';

  $$('.doc-tab').forEach(t => t.classList.toggle('active', t.dataset.doc === docKey));

  const body = $('#docBody');
  if (!body) return;

  if (state.editingDoc) {
    const ta = document.createElement('textarea');
    ta.className = 'doc-editor';
    ta.value = doc?.content || 'Document not found.';
    ta.spellcheck = true;
    body.innerHTML = '';
    body.appendChild(ta);
    return;
  }

  if (!doc || !doc.content) {
    body.innerHTML = '<div class="doc-placeholder"><p>Document not available. Try regenerating.</p></div>';
    return;
  }

  const html = doc.content.split('\n').map(line => {
    const t = line.trim();
    if (!t) return '<br>';
    if (t.startsWith('**') && t.endsWith('**')) return `<strong>${escHtml(t.replace(/\*\*/g, '').trim())}</strong><br>`;
    if (t.startsWith('#')) return `<strong>${escHtml(t.replace(/^#+\s*/, '').trim())}</strong><br>`;
    return `${escHtml(t)}<br>`;
  }).join('');
  body.innerHTML = html;
}

/* ── Selections / Pricing ────────────────────────────────── */
async function renderSelections(c) {
  try {
    const sels = await api(`/api/cases/${c.id}/selections`).catch(() => []);
    const list = $('#selectionsList');
    const totalEl = $('#selectionsTotal');
    if (!list) return;

    if (!sels.length) {
      list.innerHTML = '<div class="doc-placeholder"><p>No items selected. Click "+ Add Item" to add services.</p></div>';
      if (totalEl) totalEl.innerHTML = '';
      return;
    }

    let total = 0;
    list.innerHTML = sels.map(s => {
      const lt = s.price * s.quantity;
      total += lt;
      return `<div class="sel-item"><span class="sel-name">${escHtml(s.item_name)}</span><span class="sel-qty">${s.quantity > 1 ? '×' + s.quantity : ''}</span><span class="sel-price">$${lt.toFixed(2)}</span><button class="btn-text danger" onclick="api('/api/cases/${c.id}/selections/${s.id}',{method:'DELETE'}).then(()=>openCase('${c.id}'))">✕</button></div>`;
    }).join('');
    if (totalEl) totalEl.innerHTML = `<strong>Total: $${total.toFixed(2)}</strong>`;
  } catch (e) { /* silent */ }
}

/* ── Cremation Auth ──────────────────────────────────────── */
function populateAuthForm(auth) {
  if (!auth) return;
  $('#auth-name').value = auth.authorizer_name || '';
  $('#auth-rel').value = auth.authorizer_relationship || '';
  $('#auth-addr').value = auth.authorizer_address || '';
  $('#auth-phone').value = auth.authorizer_phone || '';
  $('#auth-method').value = auth.disposition_method || 'cremation';
  $('#auth-crematory').value = auth.crematory_name || '';
  $('#auth-instructions').value = auth.special_instructions || '';
  $('#auth-idtype').value = auth.id_type || '';
  $('#auth-idnum').value = auth.id_number || '';
  $('#auth-verified').checked = !!auth.id_verified;
  const st = $('#authStatus');
  if (st) st.innerHTML = auth.signed_at ? `<span class="status-badge status-service_completed">Signed ${formatDateTime(auth.signed_at)}</span>` : '<span class="status-badge status-arrangement_done">Not yet signed</span>';
}

/* ── Timeline ────────────────────────────────────────────── */
async function updateCaseStatus(id, status, note) {
  await api(`/api/cases/${id}/status`, { method: 'PUT', body: JSON.stringify({ status, note }) });
  const c = await api(`/api/cases/${id}`);
  renderCaseFull(c);
  toast('Status updated.');
}

/* ── Wire Tab Switching ─────────────────────────────────── */
$$('.doc-tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    if (!state.activeCaseId || state.isGenerating) return;
    state.activeDoc = tab.dataset.doc;
    state.editingDoc = false;
    $('#btnEdit').textContent = 'Edit';
    try {
      const c = await api(`/api/cases/${state.activeCaseId}`);
      renderDocument(c, state.activeDoc);
    } catch (e) { /* silent */ }
  });
});

$$('.case-tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    if (!state.activeCaseId) return;
    state.activeCaseTab = tab.dataset.tab;
    $$('.case-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $$('.case-tab-content').forEach(tc => tc.classList.remove('active'));
    const target = document.getElementById('tab' + tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1));
    if (target) target.classList.add('active');
    if (tab.dataset.tab === 'pricing') {
      const c = await api(`/api/cases/${state.activeCaseId}`);
      renderSelections(c);
      loadPackageOptions();
    }
  });
});

/* ── Event Wiring ────────────────────────────────────────── */

// New case
$$('[data-action="new"]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.editingDoc = false;
    clearForm();
    showNav('form');
    $('#formEyebrow').textContent = 'New Case';
  });
});

// Cases nav
$$('[data-action="cases"]').forEach(btn => {
  btn.addEventListener('click', () => { showNav('cases'); });
});

// Form submit
async function handleFormSubmit(e) {
  e?.preventDefault();
  await createCase();
}
$('#btnFormSubmit')?.addEventListener('click', handleFormSubmit);
$('#btnFormSubmit2')?.addEventListener('click', handleFormSubmit);
$('#btnFormCancel')?.addEventListener('click', () => showNav('cases'));
$('#btnFormCancel2')?.addEventListener('click', () => showNav('cases'));

// Edit case info
$('#btnEditCase')?.addEventListener('click', async () => {
  if (!state.activeCaseId) return;
  try {
    const c = await api(`/api/cases/${state.activeCaseId}`);
    fillForm(c.deceased);
    showNav('form');
    $('#formEyebrow').textContent = 'Edit Case';
    const origSubmit = $('#btnFormSubmit').onclick;
    const origSubmit2 = $('#btnFormSubmit2').onclick;
    const update = async () => {
      const data = gatherFormData();
      await api(`/api/cases/${state.activeCaseId}`, { method: 'PUT', body: JSON.stringify({ deceased: data }) });
      toast('Case info updated.');
      await openCase(state.activeCaseId);
    };
    $('#btnFormSubmit').onclick = update;
    $('#btnFormSubmit2').onclick = update;
  } catch (e) { toast('Failed to load case', true); }
});

// Delete
$('#btnDelete')?.addEventListener('click', () => deleteCase(state.activeCaseId));

// Edit/Save doc
$('#btnEdit')?.addEventListener('click', async () => {
  if (!state.activeCaseId || state.isGenerating) return;
  state.editingDoc = !state.editingDoc;
  if (!state.editingDoc) {
    const ta = $('#docBody .doc-editor');
    if (ta) {
      try {
        await api(`/api/cases/${state.activeCaseId}/document`, { method: 'PUT', body: JSON.stringify({ docType: state.activeDoc, content: ta.value }) });
        toast('Document saved.');
      } catch (e) { toast(e.message, true); }
    }
  }
  const c = await api(`/api/cases/${state.activeCaseId}`);
  renderDocument(c, state.activeDoc);
  $('#btnEdit').textContent = state.editingDoc ? 'Save' : 'Edit';
});

// Regenerate
$('#btnRegenerate')?.addEventListener('click', async () => {
  if (!state.activeCaseId || state.isGenerating) return;
  state.isGenerating = true; state.editingDoc = false;
  $('#btnEdit').textContent = 'Edit';
  $('#docBody').innerHTML = '<div class="doc-placeholder"><div class="spinner"></div><p>Regenerating...</p></div>';
  try {
    const data = await api(`/api/cases/${state.activeCaseId}/regenerate`, { method: 'POST', body: JSON.stringify({ docType: state.activeDoc }) });
    const c = await api(`/api/cases/${state.activeCaseId}`);
    renderDocument(c, state.activeDoc);
    toast('Document regenerated.');
  } catch (e) { toast(e.message, true); }
  state.isGenerating = false;
});

// Copy
$('#btnCopy')?.addEventListener('click', async () => {
  const text = state.editingDoc ? $('#docBody .doc-editor')?.value : $('#docBody').textContent.trim();
  if (!text) return;
  try { await navigator.clipboard.writeText(text); toast('Copied.'); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Copied.'); }
});

// PDF
$('#btnPDF')?.addEventListener('click', () => {
  if (!state.activeCaseId) return;
  window.open(`/api/cases/${state.activeCaseId}/pdf/${state.activeDoc}`, '_blank');
});

// Sidebar nav
$$('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    if (state.isGenerating && state.activeCaseId) return;
    const view = item.dataset.view;
    if (view === 'cases') { showNav('cases'); loadCases(); }
    else if (view === 'dashboard') { showNav('dashboard'); loadDashboard(); }
    else if (view === 'pricing') { showNav('pricing'); loadPricing(); }
    else if (view === 'preneed') { showNav('preneed'); loadPreneed(); loadPackageOptionsPreneed(); }
    else if (view === 'memorials') { showNav('memorials'); loadMemorials(); }
    else if (view === 'inventory') { showNav('inventory'); loadInventory(); }
    else if (view === 'users') { showNav('users'); loadUsers(); }
    else { showNav(view); }
  });
});

/* ── Pricing View ────────────────────────────────────────── */
async function loadPricing() {
  try {
    const items = await api('/api/pricing/items');
    const list = $('#pricingItemsList');
    if (list) {
      const cats = {};
      for (const item of items) {
        if (!cats[item.category]) cats[item.category] = [];
        cats[item.category].push(item);
      }
      const catLabels = { professional: 'Professional', facility: 'Facility', transportation: 'Transportation', casket: 'Caskets', container: 'Containers', cremation: 'Cremation', cemetery: 'Cemetery', merchandise: 'Merchandise', other: 'Other' };
      list.innerHTML = Object.entries(cats).map(([cat, catItems]) =>
        `<div class="pricing-cat"><h4>${catLabels[cat] || cat}</h4>${catItems.map(i => `<div class="pricing-item-row"><span class="pi-name">${escHtml(i.name)}</span><span class="pi-price">$${i.price.toFixed(2)}</span><button class="btn-text" onclick="editPricingItem('${i.id}','${escHtml(i.name)}',${i.price},'${i.category}','${escHtml(i.description || '')}')">✎</button><button class="btn-text danger" onclick="deletePricingItem('${i.id}','${escHtml(i.name)}')">Delete</button></div>`).join('')}</div>`
      ).join('');
    }

    const pkgs = await api('/api/pricing/packages');
    const pkgList = $('#pkgItemsList');
    if (pkgList) {
      pkgList.innerHTML = pkgs.map(p => `<div class="pkg-card"><div class="pkg-card-head"><strong>${escHtml(p.name)}</strong><span><button class="btn-text" onclick="editPricingPackage('${p.id}')">✎</button><button class="btn-text danger" onclick="deletePricingPackage('${p.id}','${escHtml(p.name)}')">Delete</button></span></div><div class="pkg-price">$${p.total_price.toFixed(2)}</div><p class="muted">${escHtml(p.description || '')}</p><div class="pkg-items">${(p.items||[]).map(i => `<span class="pkg-item-tag">${escHtml(i.name)}</span>`).join('')}</div></div>`).join('');
    }
  } catch (e) { /* silent */ }
}

function editPricingItem(id, name, price, category, desc) {
  const newPrice = prompt(`Price for ${name} ($${price.toFixed(2)}):`, price.toString());
  if (newPrice && !isNaN(newPrice)) {
    api(`/api/pricing/items/${id}`, { method: 'PUT', body: JSON.stringify({ price: parseFloat(newPrice) }) }).then(() => { loadPricing(); toast('Price updated.'); });
  }
}

async function editPricingPackage(id) {
  const pkgs = await api('/api/pricing/packages');
  const pkg = pkgs.find(p => p.id === id);
  if (!pkg) return toast('Package not found.', true);
  const name = prompt('Package name:', pkg.name);
  if (!name) return;
  const descriptionInput = prompt('Package description:', pkg.description || '');
  const description = descriptionInput === null ? (pkg.description || '') : descriptionInput;
  const priceInput = prompt(`Package price for ${name}:`, String(pkg.total_price || 0));
  if (priceInput === null) return;
  const total_price = parseFloat(priceInput);
  if (!Number.isFinite(total_price) || total_price < 0) return toast('Enter a valid package price.', true);
  await api(`/api/pricing/packages/${id}`, { method: 'PUT', body: JSON.stringify({ name, description, total_price }) });
  await loadPricing();
  toast('Package updated.');
}

async function deletePricingItem(id, name) {
  if (!confirm(`Delete pricing item "${name}"? This will remove it from packages and case selections.`)) return;
  await api(`/api/pricing/items/${id}`, { method: 'DELETE' });
  await loadPricing();
  toast('Pricing item deleted.');
}

async function deletePricingPackage(id, name) {
  if (!confirm(`Delete package "${name}"?`)) return;
  await api(`/api/pricing/packages/${id}`, { method: 'DELETE' });
  await loadPricing();
  toast('Package deleted.');
}

$('#btnPreviewGPL')?.addEventListener('click', async () => {
  try {
    const gpl = await api('/api/gpl');
    const preview = $('#gplPreview');
    if (preview) {
      preview.innerHTML = `<h3>General Price List</h3><p class="muted">Generated ${new Date().toLocaleDateString()}</p><pre class="gpl-text">${escHtml(gpl.content)}</pre>`;
    }
  } catch (e) { toast('Failed to generate GPL', true); }
});

$('#btnAddPricingItem')?.addEventListener('click', () => {
  const cat = prompt('Category (professional/facility/transportation/casket/container/cremation/cemetery/merchandise/other):');
  if (!cat) return;
  const name = prompt('Item name:');
  if (!name) return;
  const price = parseFloat(prompt('Price:') || '0');
  api('/api/pricing/items', { method: 'POST', body: JSON.stringify({ category: cat, name, price }) }).then(() => { loadPricing(); toast('Item added.'); });
});

/* ── Customer Actions ───────────────────────────────────── */
async function openRechargeModal() {
  const [billing, plans] = await Promise.all([
    api('/api/billing'),
    api('/api/account/plans'),
  ]);
  const balance = Number(billing.account?.balance || 0).toFixed(2);
  const orders = billing.orders || [];
  const currentPlanId = state.organization?.planId || state.plan?.id;
  const planCards = plans.map(plan => {
    const isCurrent = plan.id === currentPlanId;
    const isRecommended = plan.id === 'professional';
    return `
      <div class="billing-plan-card ${isRecommended ? 'recommended' : ''} ${isCurrent ? 'current' : ''}">
        <div class="billing-plan-head">
          <div>
            <strong>${escHtml(plan.name)}</strong>
            <span>${isRecommended ? 'Recommended for US launch' : isCurrent ? 'Current plan' : 'Subscription package'}</span>
          </div>
          <div class="billing-plan-price">$${Number(plan.monthly_price || 0).toFixed(0)}<small>/mo</small></div>
        </div>
        <div class="billing-plan-limits">
          <span>${Number(plan.included_cases || 0).toLocaleString()} cases/mo</span>
          <span>${Number(plan.included_ai_documents || 0).toLocaleString()} AI docs/mo</span>
        </div>
        <p>${escHtml(plan.features || '')}</p>
        <button class="btn-primary billing-plan-select" data-plan-id="${plan.id}" ${isCurrent ? 'disabled' : ''}>${isCurrent ? 'Current Plan' : 'Choose Plan'}</button>
      </div>
    `;
  }).join('');
  const orderRows = orders.slice(0, 5).map(order => `
    <div class="modal-list-row">
      <span>
        <strong>$${Number(order.amount || 0).toFixed(2)}</strong>
        <small>${escHtml(order.payment_method || 'manual')} · ${formatDateTime(order.created_at)}</small>
      </span>
      <span class="status-badge status-${order.status || 'completed'}">${order.status || 'completed'}</span>
    </div>
  `).join('');

  showModal(`
    <div class="modal-header-block">
      <p class="view-eyebrow">Billing</p>
      <h3>Recharge Balance</h3>
      <p class="modal-subtitle">Add credit to keep document generation and assisted workflows available.</p>
    </div>
    <div class="modal-balance">
      <span>Current balance</span>
      <strong>$${balance}</strong>
    </div>
    <div class="billing-plan-grid">${planCards}</div>
    <div class="modal-section-title">Recent billing records</div>
    <div class="modal-list">${orderRows || '<p class="muted">No recharge records yet.</p>'}</div>
    <div class="compliance-card login-note">Stripe Checkout is used when configured. In local mode, choosing a plan updates the tenant package so you can test limits and pricing.</div>
    <div class="btn-row modal-actions"><button class="btn-outline" onclick="hideModal()">Close</button></div>
  `);

  $$('.billing-plan-select').forEach(btn => {
    btn.addEventListener('click', async () => {
      const planId = btn.dataset.planId;
      btn.disabled = true;
      btn.textContent = 'Processing...';
      await chooseBillingPlan(planId, btn);
    });
  });
}

async function chooseBillingPlan(planId, button) {
  try {
    const checkout = await api('/api/billing/stripe/checkout', { method: 'POST', body: JSON.stringify({ plan_id: planId }) });
    if (checkout.url) {
      window.open(checkout.url, '_blank');
      toast('Stripe checkout opened.');
      return;
    }
  } catch (e) {
    try {
      await api('/api/account/plan', { method: 'PUT', body: JSON.stringify({ plan_id: planId, status: 'trial' }) });
      const me = await api('/api/auth/me');
      state.organization = me.organization;
      state.plan = me.plan;
      hideModal();
      updateSessionChrome();
      await loadUsageMini();
      toast('Plan updated. Configure Stripe keys in admin for live checkout.');
      return;
    } catch (fallbackError) {
      toast(fallbackError.message, true);
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Choose Plan';
    }
  }
}

function openSupportModal() {
  showModal(`
    <div class="modal-header-block">
      <p class="view-eyebrow">Support</p>
      <h3>Contact Support</h3>
      <p class="modal-subtitle">Send a request to the operations team. Include the case name or document type if it helps.</p>
    </div>
    <div class="support-contact-grid">
      <div><span>Email</span><strong>support@funeralhome.local</strong></div>
      <div><span>Response target</span><strong>Same business day</strong></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Name</label><input type="text" id="modalSupportName" placeholder="Your name" /></div>
      <div class="field"><label>Email</label><input type="email" id="modalSupportEmail" placeholder="you@example.com" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Topic</label><select id="modalSupportTopic"><option>Document generation</option><option>Billing or recharge</option><option>Case workflow</option><option>Data correction</option><option>Other</option></select></div>
      <div class="field"><label>Priority</label><select id="modalSupportPriority"><option>Normal</option><option>Urgent</option><option>Low</option></select></div>
    </div>
    <div class="field-row"><div class="field flex-2"><label>Subject</label><input type="text" id="modalSupportSubject" placeholder="Short summary" /></div></div>
    <div class="field-row"><div class="field flex-2"><label>Message</label><textarea id="modalSupportMessage" rows="5" placeholder="What happened, what you expected, and any relevant case details."></textarea></div></div>
    <div class="btn-row modal-actions"><button class="btn-primary" id="modalSupportSubmit">Submit Ticket</button><button class="btn-outline" onclick="hideModal()">Cancel</button></div>
  `);

  $('#modalSupportSubmit')?.addEventListener('click', async () => {
    const submit = $('#modalSupportSubmit');
    const topic = $('#modalSupportTopic')?.value || 'Other';
    const priority = $('#modalSupportPriority')?.value || 'Normal';
    const subject = $('#modalSupportSubject')?.value.trim() || '';
    const message = $('#modalSupportMessage')?.value.trim() || '';
    const data = {
      name: $('#modalSupportName')?.value.trim() || '',
      email: $('#modalSupportEmail')?.value.trim() || '',
      subject,
      message,
      topic,
      priority,
    };
    if (!data.name || !data.email || !subject || !message) return toast('Fill in all support fields.', true);
    submit.disabled = true;
    submit.textContent = 'Submitting...';
    try {
      const result = await api('/api/support/tickets', { method: 'POST', body: JSON.stringify(data) });
      hideModal();
      toast(`Support ticket opened: ${result.id.slice(0, 8)}.`);
    } catch (e) {
      submit.disabled = false;
      submit.textContent = 'Submit Ticket';
    }
  });
}

$('#btnQuickRecharge')?.addEventListener('click', openRechargeModal);
$('#btnQuickSupport')?.addEventListener('click', openSupportModal);

/* ── Pre-Need ────────────────────────────────────────────── */
async function loadPreneed() {
  try {
    const contracts = await api('/api/pre-need');
    const body = $('#preneedBody');
    if (!body) return;
    body.innerHTML = contracts.map(c => `<tr><td>${escHtml(c.client_name)}</td><td>${escHtml(c.package_name || '—')}</td><td>$${(c.total_amount||0).toFixed(2)}</td><td>$${(c.amount_paid||0).toFixed(2)}</td><td>${c.payment_plan||'—'}</td><td><span class="status-badge status-${c.status}">${c.status}</span></td><td>${formatDate(c.created_at)}</td></tr>`).join('');
  } catch (e) { /* silent */ }
}

async function loadPackageOptionsPreneed() {
  try {
    const pkgs = await api('/api/pricing/packages');
    const sel = $('#pn-pkg');
    if (sel) { sel.innerHTML = '<option value="">None</option>' + pkgs.map(p => `<option value="${p.id}">${escHtml(p.name)} — $${p.total_price.toFixed(2)}</option>`).join(''); }
  } catch (e) { /* silent */ }
}

async function loadPackageOptions() {
  try {
    const pkgs = await api('/api/pricing/packages');
    const items = await api('/api/pricing/items');
    const sel = $('#itemSelector');
    if (sel) {
      const cats = {};
      for (const item of items) {
        if (!cats[item.category]) cats[item.category] = [];
        cats[item.category].push(item);
      }
      const catLabels = { professional: 'Professional', facility: 'Facility', transportation: 'Transportation', casket: 'Caskets', container: 'Containers', cremation: 'Cremation', cemetery: 'Cemetery', merchandise: 'Merchandise', other: 'Other' };
      sel.innerHTML = '<option value="">— Select —</option>' + Object.entries(cats).map(([cat, catItems]) =>
        `<optgroup label="${catLabels[cat] || cat}">${catItems.map(i => `<option value="${i.id}" data-price="${i.price}">${escHtml(i.name)} — $${i.price.toFixed(2)}</option>`).join('')}</optgroup>`
      ).join('');
    }
    const pkgList = $('#packageList');
    if (pkgList) {
      pkgList.innerHTML = pkgs.map(p => `<button class="pkg-opt" onclick="selectPackage('${p.id}','${p.name}','${p.total_price}')"><strong>${escHtml(p.name)}</strong> — $${p.total_price.toFixed(2)}<span class="muted">${escHtml(p.description || '')}</span></button>`).join('');
    }
  } catch (e) { /* silent */ }
}

async function selectPackage(pkgId, name, price) {
  if (!state.activeCaseId) return;
  try {
    const items = await api(`/api/pricing/packages/${pkgId}/items`).catch(() => []);
    const pkg = await api('/api/pricing/packages').then(pkgs => pkgs.find(p => p.id === pkgId));
    if (pkg?.items) {
      for (const item of pkg.items) {
        await api(`/api/cases/${state.activeCaseId}/selections`, { method: 'POST', body: JSON.stringify({ item_id: item.id, quantity: item.quantity, price: item.price }) });
      }
    }
    toast(`Package "${name}" applied.`);
    const c = await api(`/api/cases/${state.activeCaseId}`);
    renderSelections(c);
  } catch (e) { toast('Failed to apply package', true); }
}

// Add item to case
$('#btnAddItem')?.addEventListener('click', () => {
  const panel = $('#addItemPanel');
  if (panel) panel.style.display = 'block';
  loadPackageOptions();
});

$('#btnConfirmItem')?.addEventListener('click', async () => {
  const sel = $('#itemSelector');
  const qty = parseInt($('#itemQty')?.value || '1');
  if (!sel || !sel.value) { toast('Select an item.', true); return; }
  const price = parseFloat(sel.options[sel.selectedIndex]?.dataset?.price || '0');
  if (!state.activeCaseId) return;
  await api(`/api/cases/${state.activeCaseId}/selections`, { method: 'POST', body: JSON.stringify({ item_id: sel.value, quantity: qty, price }) });
  toast('Item added.');
  $('#addItemPanel').style.display = 'none';
  const c = await api(`/api/cases/${state.activeCaseId}`);
  renderSelections(c);
});

$('#btnCancelItem')?.addEventListener('click', () => { $('#addItemPanel').style.display = 'none'; });

// Generate FTC Statement
$('#btnGenerateStatement')?.addEventListener('click', async () => {
  if (!state.activeCaseId) return;
  try {
    const stmt = await api(`/api/cases/${state.activeCaseId}/statement`);
    const preview = $('#statementPreview');
    if (preview) preview.innerHTML = `<pre class="stmt-text">${escHtml(stmt.content)}</pre>`;
    toast('FTC Statement generated.');
  } catch (e) { toast(e.message, true); }
});

/* ── Cremation Auth ──────────────────────────────────────── */
$('#btnSaveAuth')?.addEventListener('click', async () => {
  if (!state.activeCaseId) return;
  const data = {
    authorizer_name: $('#auth-name')?.value || '',
    authorizer_relationship: $('#auth-rel')?.value || '',
    authorizer_address: $('#auth-addr')?.value || '',
    authorizer_phone: $('#auth-phone')?.value || '',
    disposition_method: $('#auth-method')?.value || 'cremation',
    crematory_name: $('#auth-crematory')?.value || '',
    special_instructions: $('#auth-instructions')?.value || '',
    id_type: $('#auth-idtype')?.value || '',
    id_number: $('#auth-idnum')?.value || '',
    id_verified: $('#auth-verified')?.checked ? 1 : 0,
  };
  if (!data.authorizer_name) { toast('Authorizer name required.', true); return; }
  await api(`/api/cases/${state.activeCaseId}/cremation-authorization`, { method: 'POST', body: JSON.stringify(data) });
  toast('Authorization saved.');
});

$('#btnSignAuth')?.addEventListener('click', async () => {
  if (!state.activeCaseId) return;
  if (!confirm('Mark this authorization as signed? This adds a timeline entry.')) return;
  await api(`/api/cases/${state.activeCaseId}/cremation-authorization/sign`, { method: 'PUT' });
  toast('Authorization signed.');
  const c = await api(`/api/cases/${state.activeCaseId}`);
  if (c.cremationAuthorization) populateAuthForm(c.cremationAuthorization);
});

$('#btnPDFAuth')?.addEventListener('click', () => {
  if (!state.activeCaseId) return;
  window.open(`/api/cases/${state.activeCaseId}/pdf/cremation_authorization`, '_blank');
});

/* ── SSA / VA ────────────────────────────────────────────── */
async function generateBenefitDoc(type, endpoint, contentEl) {
  if (!state.activeCaseId) return;
  if (!contentEl) return;
  contentEl.innerHTML = '<div class="spinner"></div><p>Generating...</p>';
  try {
    const data = await api(`/api/cases/${state.activeCaseId}/regenerate`, { method: 'POST', body: JSON.stringify({ docType: endpoint }) });
    contentEl.innerHTML = data.content.split('\n').map(l => escHtml(l) + '<br>').join('');
    toast(`${type} generated.`);
  } catch (e) { contentEl.innerHTML = '<p class="error">Error generating document.</p>'; }
}

$('#btnGenerateSSA')?.addEventListener('click', () => generateBenefitDoc('SSA-721', 'ssa721', $('#ssaContent')));
$('#btnGenerateVA')?.addEventListener('click', () => generateBenefitDoc('VA Guide', 'va_benefits', $('#vaContent')));
$('#btnPDFSSA')?.addEventListener('click', () => { if (state.activeCaseId) window.open(`/api/cases/${state.activeCaseId}/pdf/ssa721`, '_blank'); });
$('#btnPDFVA')?.addEventListener('click', () => { if (state.activeCaseId) window.open(`/api/cases/${state.activeCaseId}/pdf/va_benefits`, '_blank'); });

/* ── Memorials ───────────────────────────────────────────── */
async function loadMemorials() {
  try {
    const memorials = await api('/api/memorials');
    const grid = $('#memorialsGrid');
    if (!grid) return;
    grid.innerHTML = memorials.length ? memorials.map(m => `<div class="mem-card"><strong>${escHtml(m.public_title || m.full_name || 'Untitled')}</strong><p class="muted">${m.is_published ? 'Published' : 'Draft'} · <code>/${m.slug}</code></p><div class="btn-row"><button class="btn-outline-sm" onclick="navigator.clipboard.writeText('${document.location.origin}/memorial/${m.slug}');toast('Link copied.')">Copy Link</button><button class="btn-outline-sm" onclick="api('/api/memorials/${m.id}/publish',{method:'PUT',body:JSON.stringify({is_published:${m.is_published?0:1}})}).then(()=>loadMemorials()).then(()=>toast('${m.is_published?'Unpublished':'Published'}.'))">${m.is_published?'Unpublish':'Publish'}</button></div></div>`).join('') : '<p class="muted">No memorials yet. Create one from a case detail view.</p>';
  } catch (e) { /* silent */ }
}

$('#btnSaveMemorial')?.addEventListener('click', async () => {
  if (!state.activeCaseId) return;
  try {
    const data = await api(`/api/cases/${state.activeCaseId}/memorial`, { method: 'POST', body: JSON.stringify({ public_title: $('#mem-title')?.value || '', life_story: $('#mem-story')?.value || '' }) });
    toast('Memorial saved.');
    if (data.slug) {
      const preview = $('#memPreview');
      if (preview) preview.innerHTML = `<p>Public URL: <code>${document.location.origin}/memorial/${data.slug}</code></p>`;
    }
  } catch (e) { toast(e.message, true); }
});

$('#btnPublishMemorial')?.addEventListener('click', async () => {
  if (!state.activeCaseId) return;
  try {
    const c = await api(`/api/cases/${state.activeCaseId}`);
    if (c.memorial?.id) {
      await api(`/api/memorials/${c.memorial.id}/publish`, { method: 'PUT', body: JSON.stringify({ is_published: true }) });
      toast('Memorial published.');
    } else {
      toast('Save the memorial first.', true);
    }
  } catch (e) { toast(e.message, true); }
});

/* ── Timeline Tab ─────────────────────────────────────────── */
$('#btnUpdateStatus')?.addEventListener('click', async () => {
  if (!state.activeCaseId) return;
  const status = $('#tl-status')?.value;
  const note = $('#tl-note')?.value || '';
  if (!status) return;
  await updateCaseStatus(state.activeCaseId, status, note);
  $('#tl-note').value = '';
});

$('#btnViewTimeline')?.addEventListener('click', async () => {
  if (!state.activeCaseId) return;
  const tab = [...$$('.case-tab')].find(t => t.dataset.tab === 'timeline');
  if (tab) tab.click();
});

/* ── Inventory ────────────────────────────────────────────── */
async function loadInventory() {
  try {
    const items = await api('/api/inventory');
    const body = $('#invBody');
    if (!body) return;
    body.innerHTML = items.map(i => `<tr><td>${i.item_type}</td><td>${escHtml(i.name)}</td><td>${escHtml(i.sku||'')}</td><td>${i.quantity}${(i.reorder_level && i.quantity <= i.reorder_level) ? ' ⚠️' : ''}</td><td>$${(i.cost_price||0).toFixed(2)}</td><td>$${(i.retail_price||0).toFixed(2)}</td><td>${escHtml(i.supplier||'')}</td><td><button class="btn-text" onclick="editInv('${i.id}')">✎</button></td></tr>`).join('');
  } catch (e) { /* silent */ }
}

function editInv(id) {
  const qty = prompt('New quantity:');
  if (qty && !isNaN(qty)) {
    api(`/api/inventory/${id}`, { method: 'PUT', body: JSON.stringify({ quantity: parseInt(qty) }) }).then(() => loadInventory());
  }
}

$('#btnAddInventory')?.addEventListener('click', () => { $('#inventoryForm').style.display = 'block'; });
$('#btnCancelInventory')?.addEventListener('click', () => { $('#inventoryForm').style.display = 'none'; });
$('#btnSaveInventory')?.addEventListener('click', async () => {
  const data = {
    item_type: $('#inv-type')?.value || 'other',
    name: $('#inv-name')?.value || '',
    sku: $('#inv-sku')?.value || '',
    quantity: parseInt($('#inv-qty')?.value || '0'),
    reorder_level: parseInt($('#inv-rl')?.value || '5'),
    cost_price: parseFloat($('#inv-cost')?.value || '0'),
    retail_price: parseFloat($('#inv-retail')?.value || '0'),
    supplier: $('#inv-supplier')?.value || '',
  };
  if (!data.name) { toast('Name required.', true); return; }
  await api('/api/inventory', { method: 'POST', body: JSON.stringify(data) });
  $('#inventoryForm').style.display = 'none';
  loadInventory();
  toast('Inventory item added.');
});

/* ── Users ────────────────────────────────────────────────── */
async function loadUsers() {
  try {
    const users = await api('/api/users');
    const body = $('#userBody');
    if (!body) return;
    body.innerHTML = users.map(u => `<tr><td>${escHtml(u.name)}</td><td>${escHtml(u.email)}</td><td><span class="status-badge">${u.role}</span></td><td>${u.active ? 'Active' : 'Inactive'}</td><td><button class="btn-text" onclick="toggleUser('${u.id}','${u.active ? 0 : 1}')">${u.active ? 'Disable' : 'Enable'}</button><button class="btn-text danger" onclick="deleteUser('${u.id}','${escHtml(u.email)}')">Delete</button></td></tr>`).join('');
  } catch (e) { /* silent */ }
}

function toggleUser(id, active) {
  api(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify({ active: active == 1 }) }).then(() => loadUsers());
}

async function deleteUser(id, email) {
  if (!confirm(`Delete user ${email}? This cannot be undone.`)) return;
  try {
    await api(`/api/users/${id}`, { method: 'DELETE' });
    await loadUsers();
    toast('User deleted.');
  } catch (e) {
    toast(e.message || 'Failed to delete user.', true);
  }
}

$('#btnAddUser')?.addEventListener('click', () => { $('#userForm').style.display = 'block'; });
$('#btnCancelUser')?.addEventListener('click', () => { $('#userForm').style.display = 'none'; });
$('#btnSaveUser')?.addEventListener('click', async () => {
  const name = $('#user-name')?.value || '';
  const email = $('#user-email')?.value || '';
  const role = $('#user-role')?.value || 'staff';
  const password = $('#user-password')?.value || '';
  if (!name || !email) { toast('Name and email required.', true); return; }
  await api('/api/users', { method: 'POST', body: JSON.stringify({ name, email, role, password }) });
  $('#userForm').style.display = 'none';
  loadUsers();
  toast('User added.');
});

/* ── Pre-Need ─────────────────────────────────────────────── */
$('#btnNewPreneed')?.addEventListener('click', () => { $('#preneedForm').style.display = 'block'; loadPackageOptionsPreneed(); });
$('#btnCancelPreneed')?.addEventListener('click', () => { $('#preneedForm').style.display = 'none'; });
$('#btnSavePreneed')?.addEventListener('click', async () => {
  const data = {
    client_name: $('#pn-name')?.value || '',
    client_email: $('#pn-email')?.value || '',
    client_phone: $('#pn-phone')?.value || '',
    package_id: $('#pn-pkg')?.value || null,
    total_amount: parseFloat($('#pn-total')?.value || '0'),
    amount_paid: parseFloat($('#pn-paid')?.value || '0'),
    payment_plan: $('#pn-plan')?.value || 'lump_sum',
    notes: $('#pn-notes')?.value || '',
  };
  if (!data.client_name) { toast('Client name required.', true); return; }
  await api('/api/pre-need', { method: 'POST', body: JSON.stringify(data) });
  $('#preneedForm').style.display = 'none';
  loadPreneed();
  toast('Pre-need contract created.');
});

$('#btnSidebarLogin')?.addEventListener('click', showLoginModal);
$('#btnSidebarRegister')?.addEventListener('click', showRegisterModal);
$('#btnSidebarLogout')?.addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  state.authToken = '';
  state.currentUser = null;
  state.organization = null;
  state.plan = null;
  localStorage.removeItem('fh_auth_token');
  clearSignedOutUi();
  updateSessionChrome();
  toast('Signed out.');
});

/* ── Modal close ──────────────────────────────────────────── */
$('#modalClose')?.addEventListener('click', hideModal);
$('#modal')?.addEventListener('click', (e) => { if (e.target === $('#modal')) hideModal(); });

/* ── Init ─────────────────────────────────────────────────── */
(async function init() {
  const ok = await restoreSession();
  if (!ok) {
    updateSessionChrome();
    return;
  }
  await initAppData();
})();

async function initAppData() {
  await loadDashboard();
  await loadCases();
  await loadUsageMini();
  toast('Ready. Dashboard loaded.');
}
