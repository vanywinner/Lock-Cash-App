// Admin panel: users, deposits to confirm, withdrawals to pay, ledger, audit log.
import { api, requireUser, logout, kes, fmtDate, fmtDateTime, daysLeft, h, toast, askForm, endOfDayNairobi, toYmdNairobi, mountFooter } from './common.js';

const $ = (id) => document.getElementById(id);
const dlg = $('dlg');
let overview;
let tab = sessionStorageGet('lc_admin_tab') || 'overview';
let userQuery = '';

function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } }

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'users', label: 'Users' },
  { id: 'deposits', label: 'Deposits to confirm', badge: () => overview?.pendingDeposits.count },
  { id: 'withdrawals', label: 'Withdrawals to pay', badge: () => overview?.pendingWithdrawals.count },
  { id: 'transactions', label: 'All transactions' },
  { id: 'audit', label: 'Audit log' },
];

/* ---------- shell ---------- */
async function loadOverview() {
  overview = await api('GET', '/api/admin/overview');
  const o = overview;
  const stat = (k, v, s, alert) => h('div', { class: 'stat' + (alert ? ' alert' : '') }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }), s && h('div', { class: 's', text: s }));
  $('stats').replaceChildren(
    stat('Total held for users', kes(o.totalHeld), `${o.users} user${o.users === 1 ? '' : 's'}`),
    stat('Still locked', kes(o.locked), `Available to withdraw: ${kes(o.available)}`),
    stat('Deposits to confirm', String(o.pendingDeposits.count), kes(o.pendingDeposits.amount), o.pendingDeposits.count > 0),
    stat('Withdrawals to pay', String(o.pendingWithdrawals.count), kes(o.pendingWithdrawals.amount), o.pendingWithdrawals.count > 0));
  renderTabs();
}

function renderTabs() {
  $('tabs').replaceChildren(...TABS.map((t) => {
    const n = t.badge?.();
    return h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(t.id === tab), onclick: () => select(t.id) },
      t.label, n > 0 && h('span', { class: 'badge', text: n }));
  }));
}

async function select(id) {
  tab = id; sessionStorageSet('lc_admin_tab', id);
  renderTabs();
  const panel = $('panel');
  panel.replaceChildren(h('p', { class: 'empty', text: 'Loading…' }));
  try {
    const view = await VIEWS[id]();
    panel.replaceChildren(view);
  } catch (e) {
    if (e.status === 401 || e.status === 403) return location.replace('login.html');
    panel.replaceChildren(h('div', { class: 'error', text: e.message }));
  }
}

const reload = async () => { await loadOverview(); await select(tab); };

/* ---------- table helpers ---------- */
function table(headers, rows, { empty = 'Nothing here.' } = {}) {
  if (!rows.length) return h('div', { class: 'card' }, h('p', { class: 'empty', text: empty }));
  return h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, headers.map((x) => h('th', { class: x.endsWith('>') ? 'r' : '', text: x.replace(/>$/, '') })))),
    h('tbody', {}, rows)));
}
const pill = (s) => h('span', { class: 'pill ' + s, text: s });
const typeLabel = (t) => ({ deposit: 'Top-up', withdrawal: 'Withdrawal', adjustment: 'Adjustment' }[t]);

/* ---------- views ---------- */
const VIEWS = {
  async overview() {
    const o = overview;
    const row = (k, v) => h('li', {}, h('span', { text: k }), h('b', { class: 'num', text: v }));
    return h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h2', { text: 'Money position' }),
        h('ul', { class: 'list' },
          row('Total held for users', kes(o.totalHeld)),
          row('Locked', kes(o.locked)),
          row('Unlocked (users can withdraw)', kes(o.available)),
          row('Confirmed deposits, all time', kes(o.totalDeposited)),
          row('Paid out, all time', kes(o.totalPaidOut)))),
      h('div', { class: 'card' }, h('h2', { text: 'Needs attention' }),
        h('ul', { class: 'list' },
          row('Deposits waiting for confirmation', `${o.pendingDeposits.count} · ${kes(o.pendingDeposits.amount)}`),
          row('Withdrawals waiting to be paid', `${o.pendingWithdrawals.count} · ${kes(o.pendingWithdrawals.amount)}`),
          row('Locks opening in the next 7 days', String(o.dueThisWeek))),
        h('p', { class: 'small muted', text: 'Tip: the “Total held” figure is what you owe users. Keep at least that much in your Pochi / M-Pesa.' })));
  },

  async users() {
    const { users } = await api('GET', '/api/admin/users' + (userQuery ? '?q=' + encodeURIComponent(userQuery) : ''));
    const search = h('input', { type: 'search', placeholder: 'Search name or phone…', value: userQuery, 'aria-label': 'Search users' });
    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(async () => { userQuery = search.value.trim(); await select('users'); $('panel').querySelector('input[type=search]').focus(); }, 350); });
    return h('div', {},
      h('div', { class: 'toolbar' }, search),
      table(['Name', 'Phone', 'Balance>', 'Due date', 'Status', ''], users.map((u) =>
        h('tr', { class: 'click', onclick: () => openUser(u.id) },
          h('td', { text: u.name }), h('td', { class: 'num', text: u.phoneDisplay }),
          h('td', { class: 'r num', text: kes(u.balance) }),
          h('td', { text: u.dueDate && u.balance > 0 ? `${fmtDate(u.dueDate)}${u.canWithdraw ? ' (open)' : ` · ${daysLeft(u.dueDate)}d`}` : '—' }),
          h('td', {}, pill(u.status)),
          h('td', { class: 'r' }, h('button', { class: 'btn small ghost', type: 'button', text: 'Manage' })))),
        { empty: userQuery ? 'No users match your search.' : 'No users yet. Share your sign-up link to get started.' }));
  },

  async deposits() {
    const { transactions } = await api('GET', '/api/admin/transactions?type=deposit&status=pending');
    return h('div', {},
      h('p', { class: 'notice', text: 'Match each M-Pesa code with the SMS on your Pochi phone, then confirm. If the amount received differs, correct it when confirming.' }),
      table(['Date', 'User', 'M-Pesa code', 'Amount>', 'Lock', ''], transactions.map((t) =>
        h('tr', {},
          h('td', { text: fmtDateTime(t.createdAt) }),
          h('td', {}, t.name, h('div', { class: 'small muted num', text: t.phone })),
          h('td', { class: 'num', text: t.mpesaCode }),
          h('td', { class: 'r num', text: kes(t.amount) }),
          h('td', { text: t.lockDays ? t.lockDays + ' days' : 'keep current' }),
          h('td', {}, h('div', { class: 'btns' },
            h('button', { class: 'btn small', type: 'button', text: 'Confirm', onclick: () => confirmDeposit(t) }),
            h('button', { class: 'btn small ghost', type: 'button', text: 'Reject', onclick: () => rejectTx(t) }))))),
        { empty: 'No deposits waiting. All caught up.' }));
  },

  async withdrawals() {
    const { transactions } = await api('GET', '/api/admin/transactions?type=withdrawal&status=pending');
    return h('div', {},
      h('p', { class: 'notice', text: 'Send each amount to the phone number shown via M-Pesa, then press “Mark paid” and enter the M-Pesa reference from your own confirmation SMS.' }),
      table(['Requested', 'User', 'Pay to', 'Amount>', ''], transactions.map((t) =>
        h('tr', {},
          h('td', { text: fmtDateTime(t.createdAt) }), h('td', { text: t.name }),
          h('td', { class: 'num', text: t.phone }), h('td', { class: 'r num', text: kes(t.amount) }),
          h('td', {}, h('div', { class: 'btns' },
            h('button', { class: 'btn small', type: 'button', text: 'Mark paid', onclick: () => payWithdrawal(t) }),
            h('button', { class: 'btn small ghost', type: 'button', text: 'Reject', onclick: () => rejectTx(t) }))))),
        { empty: 'No withdrawals waiting.' }));
  },

  async transactions() {
    const { transactions } = await api('GET', '/api/admin/transactions');
    return table(['Date', 'User', 'Type', 'Amount>', 'Status', 'Reference / note'], transactions.map((t) =>
      h('tr', {},
        h('td', { text: fmtDateTime(t.createdAt) }),
        h('td', {}, t.name, h('div', { class: 'small muted num', text: t.phone })),
        h('td', { text: typeLabel(t.type) }),
        h('td', { class: 'r num', text: (t.amount < 0 ? '−' : '') + kes(Math.abs(t.amount)) }),
        h('td', {}, pill(t.status)),
        h('td', { class: 'small muted', text: [t.mpesaCode, t.note].filter(Boolean).join(' · ') }))),
      { empty: 'No transactions yet.' });
  },

  async audit() {
    const { audit } = await api('GET', '/api/admin/audit');
    return table(['When', 'Admin', 'Action', 'User', 'Details'], audit.map((a) =>
      h('tr', {},
        h('td', { text: fmtDateTime(a.createdAt) }), h('td', { text: a.actor || '—' }),
        h('td', { text: a.action }), h('td', { text: a.target || '—' }),
        h('td', {}, a.detail ? h('pre', { class: 'detail', text: JSON.stringify(a.detail) }) : '—'))),
      { empty: 'No admin actions recorded yet.' });
  },
};

/* ---------- actions ---------- */
async function confirmDeposit(t) {
  await askForm(dlg, {
    title: 'Confirm deposit',
    intro: `${t.name} (${t.phone}) says they sent code ${t.mpesaCode}. Check your M-Pesa SMS first.`,
    fields: [{ name: 'amount', label: 'Amount actually received (KES)', type: 'number', value: t.amount, inputmode: 'numeric', min: 1, hint: 'Change this only if the SMS shows a different amount.' }],
    submit: 'Add to balance',
    onSubmit: async (v) => { await api('POST', `/api/admin/transactions/${t.id}/approve`, { amount: Number(v.amount) }); },
  }) && (toast('Deposit confirmed and credited.'), await reload());
}

async function payWithdrawal(t) {
  await askForm(dlg, {
    title: `Pay ${kes(t.amount)} to ${t.name}`,
    intro: `Send via M-Pesa to ${t.phone}. Then enter the confirmation code from your own SMS.`,
    fields: [{ name: 'mpesaCode', label: 'Your M-Pesa confirmation code', code: true, hint: '10 letters/numbers' }],
    submit: 'Mark as paid',
    onSubmit: async (v) => { await api('POST', `/api/admin/transactions/${t.id}/approve`, { mpesaCode: v.mpesaCode }); },
  }) && (toast('Marked as paid.'), await reload());
}

async function rejectTx(t) {
  await askForm(dlg, {
    title: `Reject ${typeLabel(t.type).toLowerCase()}`,
    intro: t.type === 'withdrawal' ? 'The held money goes back to the user’s balance.' : 'The user will see this reason.',
    fields: [{ name: 'reason', label: 'Reason', hint: 'e.g. “Payment not received”' }],
    submit: 'Reject', danger: true,
    onSubmit: async (v) => { await api('POST', `/api/admin/transactions/${t.id}/reject`, { reason: v.reason }); },
  }) && (toast('Rejected.'), await reload());
}

async function openUser(id) {
  const { user: u, transactions } = await api('GET', `/api/admin/users/${id}`);
  const again = async () => { await reload(); await openUser(id); };
  const act = (label, fn, cls = 'ghost') => h('button', { class: 'btn small ' + cls, type: 'button', text: label, onclick: fn });

  const adjust = async () => (await askForm(dlg, {
    title: 'Adjust balance', intro: `Current balance: ${kes(u.balance)}. Use a minus sign to deduct.`,
    fields: [{ name: 'amount', label: 'Amount (KES)', type: 'number', inputmode: 'numeric' }, { name: 'reason', label: 'Reason (recorded in the audit log)' }],
    onSubmit: (v) => api('POST', `/api/admin/users/${id}/adjust`, { amount: Number(v.amount), reason: v.reason }),
  })) && (toast('Balance adjusted.'), await again());

  const setDue = async () => (await askForm(dlg, {
    title: 'Change due date', intro: 'Choose the day the money becomes available.',
    fields: [{ name: 'date', label: 'New due date', type: 'date', value: u.dueDate ? toYmdNairobi(u.dueDate) : toYmdNairobi(new Date().toISOString()) }, { name: 'reason', label: 'Reason' }],
    onSubmit: (v) => api('PATCH', `/api/admin/users/${id}`, { dueDate: endOfDayNairobi(v.date), released: false, reason: v.reason }),
  })) && (toast('Due date updated.'), await again());

  const toggleRelease = async () => (await askForm(dlg, {
    title: u.released ? 'Re-lock savings' : 'Release savings early',
    intro: u.released ? 'The user will no longer be able to withdraw before the due date.' : 'The user will be able to withdraw immediately, before the due date.',
    fields: [{ name: 'reason', label: 'Reason' }], danger: !u.released,
    onSubmit: (v) => api('PATCH', `/api/admin/users/${id}`, { released: !u.released, reason: v.reason }),
  })) && (toast(u.released ? 'Savings re-locked.' : 'Savings released.'), await again());

  const toggleFreeze = async () => (await askForm(dlg, {
    title: u.status === 'frozen' ? 'Unfreeze account' : 'Freeze account',
    intro: u.status === 'frozen' ? 'The user will be able to log in and transact again.' : 'The user is logged out and cannot top up or withdraw.',
    fields: [{ name: 'reason', label: 'Reason' }], danger: u.status !== 'frozen',
    onSubmit: (v) => api('PATCH', `/api/admin/users/${id}`, { status: u.status === 'frozen' ? 'active' : 'frozen', reason: v.reason }),
  })) && (toast('Account updated.'), await again());

  const resetPw = async () => (await askForm(dlg, {
    title: 'Reset password', intro: 'Give the new password to the user by phone. They are logged out everywhere.',
    fields: [{ name: 'password', label: 'New password (8+ characters)', type: 'text' }],
    onSubmit: (v) => api('POST', `/api/admin/users/${id}/password`, { password: v.password }),
  })) && toast('Password reset.');

  dlg.replaceChildren(h('div', { class: 'dlg' },
    h('div', { class: 'row between' }, h('h2', { text: u.name }), pill(u.status)),
    h('p', { class: 'muted num', text: u.phoneDisplay + ' · joined ' + fmtDate(u.createdAt) }),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'k', text: 'Balance' }), h('div', { class: 'v', text: kes(u.balance) })),
      h('div', { class: 'stat' }, h('div', { class: 'k', text: 'Due date' }), h('div', { class: 'v', text: u.dueDate && u.balance > 0 ? fmtDate(u.dueDate) : '—' }),
        h('div', { class: 's', text: u.canWithdraw ? 'Open for withdrawal' : u.balance > 0 ? 'Locked' : '' }))),
    h('div', { class: 'row' },
      act('Adjust balance', adjust), act('Change due date', setDue),
      act(u.released ? 'Re-lock' : 'Release early', toggleRelease),
      act(u.status === 'frozen' ? 'Unfreeze' : 'Freeze', toggleFreeze, u.status === 'frozen' ? 'ghost' : 'danger'),
      act('Reset password', resetPw)),
    h('h3', { text: 'Recent activity' }),
    transactions.length
      ? h('ul', { class: 'list' }, transactions.slice(0, 8).map((t) =>
          h('li', {}, h('div', {}, h('div', { class: 'title', text: typeLabel(t.type) }), h('div', { class: 'small muted', text: fmtDateTime(t.createdAt) + (t.mpesaCode ? ' · ' + t.mpesaCode : '') + (t.note ? ' · ' + t.note : '') })),
            h('div', { class: 'amt', text: kes(t.amount) + ' · ' + t.status }))))
      : h('p', { class: 'empty', text: 'No activity yet.' }),
    h('button', { class: 'btn ghost', type: 'button', text: 'Close', onclick: () => dlg.close() })));
  if (!dlg.open) dlg.showModal();
}

/* ---------- start ---------- */
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
$('btn-logout').addEventListener('click', logout);
(async () => {
  await requireUser({ admin: true });
  mountFooter();
  await loadOverview();
  await select(tab);
})().catch((e) => $('panel').replaceChildren(h('div', { class: 'error', text: e.message })));
