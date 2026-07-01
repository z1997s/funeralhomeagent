const state = { token: localStorage.getItem('fh_admin_token') || '' };
const $ = s => document.querySelector(s);

function escHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show${isError ? ' error' : ''}`;
  setTimeout(() => el.classList.remove('show'), 3500);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

function showApp(show) {
  ['summaryGrid', 'statusPanel', 'tenantPanel', 'opsPanels', 'billingPanel', 'plansPanel', 'legalPanel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  });
  $('#loginPanel').style.display = show ? 'none' : '';
}

function statusCard(label, value, ok) {
  const cls = ok === true ? 'ok' : ok === false ? 'bad' : 'warn';
  return `<div class="status-card"><span>${label}</span><strong class="${cls}">${value}</strong></div>`;
}

async function login() {
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#loginEmail').value.trim(), password: $('#loginPassword').value })
    });
    state.token = data.token;
    localStorage.setItem('fh_admin_token', data.token);
    toast('Signed in.');
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadAll() {
  try {
    const [me, account, usage, status, users, backups, orgs, billing, plans] = await Promise.all([
      api('/api/auth/me'),
      api('/api/account'),
      api('/api/usage'),
      api('/api/admin/status'),
      api('/api/users'),
      api('/api/backups'),
      api('/api/platform/organizations').catch(() => []),
      api('/api/billing'),
      api('/api/admin/plans'),
    ]);

    showApp(true);
    $('#signedInAs').textContent = `${me.user.name} (${me.user.role})`;
    $('#tenantName').textContent = account.organization.name;
    $('#planName').textContent = account.plan.name;
    $('#aiDocsCount').textContent = String(usage.usage.ai_document_generated || 0);

    $('#statusGrid').innerHTML = [
      statusCard('Real Login', status.auth.sessionAuth ? 'Session auth enabled' : 'Missing', status.auth.sessionAuth),
      statusCard('Service Token', status.auth.serviceTokenEnabled ? 'Enabled' : 'Disabled by default', true),
      statusCard('Tenant Isolation', `${status.tenant.organizations} organization(s)`, true),
      statusCard('Daily AI Limit', `${status.aiLimits.dailyDocumentLimit} docs/day`, true),
      statusCard('Monthly AI Hard Limit', `${status.aiLimits.monthlyDocumentHardLimit} docs/month`, true),
      statusCard('HTTPS', status.security.forceHttps ? 'Forced' : 'Proxy/cert configurable', status.security.forceHttps ? true : null),
      statusCard('Stripe Secret', status.stripe.configured ? 'Configured' : 'Not configured', status.stripe.configured),
      statusCard('Stripe Webhook', status.stripe.webhookConfigured ? 'Configured' : 'Missing signing secret', status.stripe.webhookConfigured),
      statusCard('Stripe Prices', Object.values(status.stripe.priceIds).every(Boolean) ? 'Configured' : 'Missing price IDs', Object.values(status.stripe.priceIds).every(Boolean)),
      statusCard('Legal Pages', 'Privacy / Terms / Disclaimer live', true),
    ].join('');

    $('#usersBody').innerHTML = users.map(u => `<tr><td>${u.name}</td><td>${u.email}</td><td>${u.role}</td><td>${u.active ? 'Active' : 'Inactive'}</td></tr>`).join('');
    $('#backupBody').innerHTML = backups.map(b => `<tr><td>${b.status}</td><td>${b.created_at}</td><td><code>${b.path}</code></td></tr>`).join('') || '<tr><td colspan="3">No backups yet.</td></tr>';
    $('#orgBody').innerHTML = orgs.map(o => `<tr><td>${o.name}</td><td><code>${o.id}</code></td><td>${o.plan_name || o.plan_id}</td><td>${o.user_count}</td><td>${o.case_count}</td><td>${o.status}</td></tr>`).join('') || '<tr><td colspan="6">No platform access or no tenants.</td></tr>';
    renderBilling(billing);
    renderPlans(plans);
  } catch (err) {
    showApp(false);
    toast(err.message, true);
  }
}

function renderPlans(plans) {
  $('#plansBody').innerHTML = plans.map(plan => `
    <tr>
      <td><strong>${escHtml(plan.name)}</strong><div class="muted">${escHtml(plan.id)}</div></td>
      <td><input data-plan-field="${plan.id}:monthly_price" type="number" step="1" value="${Number(plan.monthly_price || 0)}" /></td>
      <td><input data-plan-field="${plan.id}:included_cases" type="number" step="1" value="${Number(plan.included_cases || 0)}" /></td>
      <td><input data-plan-field="${plan.id}:included_ai_documents" type="number" step="1" value="${Number(plan.included_ai_documents || 0)}" /></td>
      <td><input data-plan-field="${plan.id}:overage_case_price" type="number" step="0.01" value="${Number(plan.overage_case_price || 0)}" /></td>
      <td><input data-plan-field="${plan.id}:overage_document_price" type="number" step="0.01" value="${Number(plan.overage_document_price || 0)}" /></td>
      <td><input data-plan-field="${plan.id}:stripe_price_id" value="${escHtml(plan.stripe_price_id || '')}" /></td>
      <td><button class="btn ghost" data-plan-save="${plan.id}">Save</button></td>
    </tr>
  `).join('');
  document.querySelectorAll('[data-plan-save]').forEach(button => {
    button.addEventListener('click', () => savePlan(button.dataset.planSave));
  });
}

function renderBilling(billing) {
  const account = billing.account || {};
  const payment = billing.payment || {};
  const orders = billing.orders || [];

  $('#billingBalance').textContent = `$${Number(account.balance || 0).toFixed(2)}`;
  $('#paymentsEnabled').textContent = payment.payments_enabled ? 'Enabled' : 'Disabled';
  $('#paymentProvider').textContent = payment.payment_provider || 'stripe';
  $('#paymentMode').textContent = payment.payment_mode || 'test';
  $('#paymentProviderInput').value = payment.payment_provider || 'stripe';
  $('#paymentModeInput').value = payment.payment_mode || 'test';
  $('#paymentsEnabledInput').value = payment.payments_enabled ? '1' : '0';
  $('#paymentPublicKey').value = payment.payment_public_key || '';
  $('#paymentInstructions').value = payment.payment_instructions || '';

  $('#rechargeBody').innerHTML = orders.map(order => `
    <tr>
      <td><input data-order-amount="${order.id}" type="number" step="0.01" value="${Number(order.amount || 0).toFixed(2)}" /></td>
      <td>${escHtml(order.payment_method || 'manual')}</td>
      <td>${escHtml(order.status || 'completed')}</td>
      <td>${escHtml(order.created_at || '')}</td>
      <td><input data-order-note="${order.id}" value="${escHtml(order.note || '')}" /></td>
      <td>
        <select data-order-status="${order.id}">
          <option value="pending" ${order.status === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="completed" ${order.status === 'completed' ? 'selected' : ''}>Completed</option>
          <option value="failed" ${order.status === 'failed' ? 'selected' : ''}>Failed</option>
          <option value="cancelled" ${order.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
        </select>
        <button class="btn ghost" data-order-save="${order.id}">Save</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="6">No recharge records yet.</td></tr>';

  document.querySelectorAll('[data-order-save]').forEach(button => {
    button.addEventListener('click', () => {
      const id = button.dataset.orderSave;
      updateRechargeOrder(
        id,
        document.querySelector(`[data-order-status="${id}"]`)?.value,
        document.querySelector(`[data-order-amount="${id}"]`)?.value,
        document.querySelector(`[data-order-note="${id}"]`)?.value
      );
    });
  });
}

async function createBackup() {
  try {
    await api('/api/backups', { method: 'POST', body: JSON.stringify({ backup_type: 'manual-admin' }) });
    toast('Backup created.');
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function createOrg() {
  try {
    await api('/api/platform/organizations', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#orgName').value.trim(),
        slug: $('#orgSlug').value.trim(),
        admin_email: $('#orgAdminEmail').value.trim(),
        admin_password: $('#orgAdminPassword').value,
        plan_id: 'professional',
      })
    });
    ['orgName', 'orgSlug', 'orgAdminEmail', 'orgAdminPassword'].forEach(id => { $('#' + id).value = ''; });
    toast('Tenant created.');
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function createCheckout() {
  try {
    const data = await api('/api/billing/stripe/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan_id: $('#stripePlan').value })
    });
    $('#checkoutUrl').value = data.url || '';
    toast('Stripe checkout session created.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function adjustBalance() {
  try {
    await api('/api/billing/adjust', {
      method: 'POST',
      body: JSON.stringify({
        amount: Number($('#adjustAmount').value),
        note: $('#adjustNote').value.trim(),
      })
    });
    $('#adjustAmount').value = '';
    $('#adjustNote').value = '';
    toast('Balance adjusted.');
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function savePaymentSettings() {
  try {
    await api('/api/billing/settings', {
      method: 'PUT',
      body: JSON.stringify({
        payment_provider: $('#paymentProviderInput').value,
        payment_mode: $('#paymentModeInput').value,
        payments_enabled: $('#paymentsEnabledInput').value === '1',
        payment_public_key: $('#paymentPublicKey').value.trim(),
        payment_instructions: $('#paymentInstructions').value.trim(),
      })
    });
    toast('Payment settings saved.');
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function updateRechargeOrder(id, status, amount, note) {
  try {
    await api(`/api/billing/recharge-orders/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ status, amount: Number(amount), note })
    });
    toast('Recharge order updated.');
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function savePlan(id) {
  try {
    const fieldValue = field => document.querySelector(`[data-plan-field="${id}:${field}"]`)?.value;
    await api(`/api/admin/plans/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        monthly_price: Number(fieldValue('monthly_price')),
        included_cases: Number(fieldValue('included_cases')),
        included_ai_documents: Number(fieldValue('included_ai_documents')),
        overage_case_price: Number(fieldValue('overage_case_price')),
        overage_document_price: Number(fieldValue('overage_document_price')),
        stripe_price_id: fieldValue('stripe_price_id') || '',
      })
    });
    toast('Package pricing saved.');
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
}

$('#btnLogin').addEventListener('click', login);
$('#loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
$('#btnLogout').addEventListener('click', () => {
  state.token = '';
  localStorage.removeItem('fh_admin_token');
  showApp(false);
});
$('#btnRefresh').addEventListener('click', loadAll);
$('#btnBackup').addEventListener('click', createBackup);
$('#btnCreateOrg').addEventListener('click', createOrg);
$('#btnCheckout').addEventListener('click', createCheckout);
$('#btnAdjustBalance').addEventListener('click', adjustBalance);
$('#btnSavePaymentSettings').addEventListener('click', savePaymentSettings);

if (state.token) loadAll();
