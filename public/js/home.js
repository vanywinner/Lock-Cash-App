// User dashboard: balance, lock status, top-up, withdraw, history.
import { api, requireUser, logout, getConfig, kes, fmtDate, fmtDateTime, daysLeft, h, icon, toast, busy, showError, mountFooter } from './common.js';
import { installApp, isInstalled } from './pwa.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
let cfg, user, txs = [];

const LOCK_CHOICES = [
  { days: 30, label: '1 month' }, { days: 90, label: '3 months' },
  { days: 180, label: '6 months' }, { days: 365, label: '1 year' }, { days: 0, label: 'Custom' },
];

/* ---------- loading & rendering ---------- */
async function load() {
  cfg = await getConfig();
  user = await requireUser();
  await refresh();
  mountFooter();
}

async function refresh() {
  const [me, list] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/transactions')]);
  user = me.user; txs = list.transactions;
  render();
}

function render() {
  const firstName = user.name.split(' ')[0];
  const pendingDeposits = txs.filter((t) => t.type === 'deposit' && t.status === 'pending');
  const pendingWithdrawal = txs.find((t) => t.type === 'withdrawal' && t.status === 'pending');

  let lockText, lockOpen = false;
  if (user.status === 'frozen') lockText = 'Account frozen';
  else if (user.balance === 0 && !pendingDeposits.length) lockText = 'No money locked yet';
  else if (user.canWithdraw) { lockText = 'Unlocked — you can withdraw'; lockOpen = true; }
  else if (user.dueDate) {
    const d = daysLeft(user.dueDate);
    lockText = `Locked until ${fmtDate(user.dueDate)} · ${d === 0 ? 'opens today' : d === 1 ? '1 day left' : d + ' days left'}`;
  } else lockText = 'No money locked yet';

  const withdrawBtn = h('button', { class: 'btn', type: 'button', text: 'Withdraw', onclick: openWithdraw, disabled: !user.canWithdraw || !!pendingWithdrawal });
  const topupBtn = h('button', { class: 'btn', type: 'button', onclick: openTopup, disabled: user.status === 'frozen' }, icon('plus'), 'Top up');

  let hint = '';
  if (pendingWithdrawal) hint = `Your withdrawal of ${kes(pendingWithdrawal.amount)} is being sent to ${user.phoneDisplay}.`;
  else if (user.status !== 'frozen' && !user.canWithdraw && user.dueDate && user.balance > 0) hint = `Withdrawals open on ${fmtDate(user.dueDate)}. This protects your savings.`;

  app.replaceChildren(...[
    h('h1', { text: `Welcome back, ${firstName}` }),
    user.status === 'frozen' && h('div', { class: 'error', role: 'alert', text: 'Your account is frozen. Please call support.' }),
    h('section', { class: 'card hero', 'aria-label': 'Balance' },
      h('div', { class: 'eyebrow', text: 'Saved balance' }),
      h('div', { class: 'amount' }, h('small', { text: 'KES' }), user.balance.toLocaleString('en-KE')),
      h('div', { class: 'lockchip' + (lockOpen ? ' open' : '') }, icon(lockOpen ? 'unlock' : 'lock'), lockText),
      h('div', { class: 'actions' }, topupBtn, withdrawBtn),
      hint && h('p', { class: 'lockhint', text: hint })),
    pendingDeposits.length > 0 && h('div', { class: 'notice warn' },
      `${pendingDeposits.length === 1 ? 'A top-up of' : pendingDeposits.length + ' top-ups totalling'} ${kes(pendingDeposits.reduce((s, t) => s + t.amount, 0))} is waiting for payment confirmation. It will show in your balance once confirmed.`),
    h('section', { class: 'card' },
      h('h2', { text: 'History' }),
      txs.length === 0
        ? h('p', { class: 'empty', text: 'Nothing here yet. Tap “Top up” to start saving.' })
        : h('ul', { class: 'list' }, txs.map(txItem)))].filter(Boolean));

  const installBtn = $('btn-install');
  installBtn.hidden = isInstalled();
}

function txItem(t) {
  const label = { deposit: 'Top-up', withdrawal: 'Withdrawal', adjustment: 'Adjustment' }[t.type];
  const positive = t.type === 'deposit' || (t.type === 'adjustment' && t.amount > 0);
  const amountText = (positive ? '+' : '−') + Math.abs(t.amount).toLocaleString('en-KE');
  return h('li', {},
    h('div', {},
      h('div', { class: 'title' }, label + ' ', h('span', { class: 'pill ' + t.status, text: t.status })),
      h('div', { class: 'small muted', text: fmtDateTime(t.createdAt) + (t.mpesaCode ? ' · ' + t.mpesaCode : '') }),
      t.status === 'rejected' && t.note && h('div', { class: 'small muted', text: 'Reason: ' + t.note }),
      t.type === 'adjustment' && t.note && h('div', { class: 'small muted', text: t.note })),
    h('div', { class: 'amt' + (positive && t.status !== 'rejected' ? ' in' : ''), text: amountText }));
}

/* ---------- top up ---------- */
const dlgTopup = $('dlg-topup');
function openTopup() {
  const lockRunning = user.lockActive && user.balance > 0;
  const seg = $('tu-lock');
  const choices = lockRunning ? [{ days: -1, label: 'Keep current' }, ...LOCK_CHOICES] : LOCK_CHOICES;
  const initial = lockRunning ? -1 : 90;
  seg.replaceChildren(...choices.flatMap((c, i) => [
    h('input', { type: 'radio', name: 'lockChoice', id: 'lc' + i, value: c.days, checked: c.days === initial }),
    h('label', { for: 'lc' + i, text: c.label }),
  ]));
  $('tu-lock-label').textContent = lockRunning ? 'Extend the lock? (optional)' : 'Lock this money for';
  $('tu-lock-hint').textContent = lockRunning
    ? `Your savings are locked until ${fmtDate(user.dueDate)}. You can only extend the lock, never shorten it.`
    : user.balance > 0
      ? 'Your earlier savings are already unlocked. Choosing a lock now will lock your whole balance until the new date.'
      : `Between ${cfg.minLockDays} days and ${Math.floor(cfg.maxLockDays / 365)} years. You cannot withdraw before the due date.`;
  $('tu-custom').hidden = true; $('tu-custom').value = '';
  $('tu-pochi').textContent = cfg.pochiPhone;
  $('tu-pochi-name').textContent = cfg.pochiName;
  $('tu-amount').min = cfg.minDeposit; $('tu-amount').max = cfg.maxDeposit;
  $('tu-amount').placeholder = `Minimum ${cfg.minDeposit}`;
  $('tu-amount').value = ''; $('tu-code').value = ''; $('tu-amount-echo').textContent = 'the amount above';
  showError($('tu-error'), '');
  dlgTopup.showModal();
}
$('tu-lock').addEventListener('change', (e) => {
  const custom = $('tu-custom');
  custom.hidden = e.target.value !== '0';
  if (!custom.hidden) custom.focus();
});
$('tu-amount').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('tu-amount-echo').textContent = v > 0 ? kes(v) : 'the amount above';
});
$('form-topup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target; const err = $('tu-error'); showError(err, '');
  const choice = Number(new FormData(f).get('lockChoice'));
  const lockDays = choice === -1 ? undefined : choice === 0 ? Number(f.customDays.value) : choice;
  const button = f.querySelector('button[type="submit"]');
  try {
    await busy(button, 'Submitting…', () => api('POST', '/api/deposits', {
      amount: Number(f.amount.value), lockDays, mpesaCode: f.mpesaCode.value,
    }));
    dlgTopup.close();
    toast('Top-up submitted. We will confirm your payment shortly.');
    await refresh();
  } catch (ex) { showError(err, ex.message); }
});

/* ---------- withdraw ---------- */
const dlgWithdraw = $('dlg-withdraw');
function openWithdraw() {
  $('wd-phone').textContent = user.phoneDisplay;
  $('wd-amount').max = user.balance; $('wd-amount').value = user.balance;
  $('wd-max').textContent = `You can withdraw up to ${kes(user.balance)}.`;
  $('wd-password').value = '';
  showError($('wd-error'), '');
  dlgWithdraw.showModal();
}
$('form-withdraw').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target; const err = $('wd-error'); showError(err, '');
  const button = f.querySelector('button[type="submit"]');
  try {
    await busy(button, 'Requesting…', () => api('POST', '/api/withdrawals', { amount: Number(f.amount.value), password: f.password.value }));
    dlgWithdraw.close();
    toast('Withdrawal requested. You will receive it on M-Pesa shortly.');
    await refresh();
  } catch (ex) { showError(err, ex.message); }
});

/* ---------- misc ---------- */
document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); })); // click backdrop
$('btn-logout').addEventListener('click', logout);
$('btn-install').addEventListener('click', async () => {
  if ((await installApp()) === 'manual') $('dlg-install').showModal();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && user) refresh().catch(() => {}); });

load().catch((e) => {
  app.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'error', text: e.message }), h('button', { class: 'btn', type: 'button', text: 'Try again', onclick: () => location.reload() })));
});
