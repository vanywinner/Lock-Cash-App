// Shared helpers used by every page. Plain ES module, no dependencies.

/* ---------- API ---------- */
export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path.replace(/^\//, ''), {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw Object.assign(new Error('No internet connection. Please check your network and try again.'), { status: 0 });
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || 'Something went wrong.'), { status: res.status });
  return data;
}

let configPromise;
export const getConfig = () => (configPromise ??= api('GET', '/api/config'));

/** Redirects to login if signed out. Returns the user. */
export async function requireUser({ admin = false } = {}) {
  try {
    const { user } = await api('GET', '/api/me');
    if (admin && user.role !== 'admin') { location.replace('home.html'); return new Promise(() => {}); }
    if (!admin && user.role === 'admin') { location.replace('admin.html'); return new Promise(() => {}); }
    return user;
  } catch (e) {
    if (e.status === 401) { location.replace('login.html'); return new Promise(() => {}); }
    throw e;
  }
}

export async function logout() {
  try { await api('POST', '/api/logout', {}); } catch { /* ignore */ }
  location.replace('login.html');
}

/* ---------- formatting (East Africa Time) ---------- */
export const kes = (n) => 'KES ' + Number(n).toLocaleString('en-KE');
const TZ = 'Africa/Nairobi';
export const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
export const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TZ });
export const daysLeft = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86400000));
/** 2026-12-31 (date input) -> end of that day in Nairobi, as ISO UTC */
export const endOfDayNairobi = (ymd) => new Date(`${ymd}T23:59:00+03:00`).toISOString();
export const toYmdNairobi = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });

/* ---------- DOM ---------- */
/** h('div', { class: 'x', onclick }, 'text', childNode) — text is always inserted safely (no innerHTML). */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const SVG_PATHS = {
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M6 10h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z',
  unlock: 'M7 10V7a5 5 0 0 1 9.6-2M6 10h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z',
  download: 'M12 3v12m0 0l-4-4m4 4l4-4M5 21h14',
  plus: 'M12 5v14M5 12h14',
  out: 'M12 19V5m0 0l-4 4m4-4l4 4',
};
export function icon(name, size = 18) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', SVG_PATHS[name]); svg.append(p);
  return svg;
}

export function toast(message, bad = false) {
  let box = document.querySelector('.toasts');
  if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), text: message });
  box.append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3500);
}

/** Disable a button + show a label while an async action runs. */
export async function busy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true; button.textContent = label;
  try { return await fn(); } finally { button.disabled = false; button.textContent = original; }
}

export function showError(el, message) {
  el.textContent = message; el.hidden = !message;
}

/** Shared page footer: policies + support call link. */
export async function mountFooter() {
  const mount = document.getElementById('site-footer');
  if (!mount) return;
  const cfg = await getConfig().catch(() => null);
  mount.className = 'footer';
  const wide = !!document.querySelector('main .wrap.wide');
  mount.replaceChildren(h('div', { class: 'wrap' + (wide ? ' wide' : '') },
    h('nav', { 'aria-label': 'Policies' },
      h('a', { href: 'legal.html#terms', text: 'Terms and conditions' }),
      h('a', { href: 'legal.html#privacy', text: 'Privacy policy' }),
      h('a', { href: 'legal.html#data', text: 'Data collection policy' }),
      cfg && h('a', { href: 'tel:' + cfg.supportPhone, text: 'Call support' })),
    h('p', { class: 'small muted', text: `© ${new Date().getFullYear()} ${cfg ? cfg.appName : 'Lock Cash'}. Savings are held in a locked ledger until your due date.` })));
}

/**
 * Form dialog. `onSubmit(values)` runs inside the dialog: if it throws, the message is shown
 * in the form and the dialog stays open; if it succeeds the dialog closes.
 * Resolves true when submitted successfully, false when cancelled.
 */
export function askForm(dialog, { title, intro, fields, submit = 'Confirm', danger = false, onSubmit }) {
  return new Promise((resolve) => {
    const err = h('div', { class: 'error', role: 'alert', hidden: true });
    const btn = h('button', { class: 'btn' + (danger ? ' danger' : ''), type: 'submit', text: submit });
    const form = h('form', { class: 'dlg', method: 'dialog' },
      h('h2', { text: title }),
      intro && h('p', { class: 'muted', text: intro }),
      ...fields.map((f) => h('div', { class: 'field' },
        h('label', { for: 'pf-' + f.name, text: f.label }),
        f.type === 'select'
          ? h('select', { id: 'pf-' + f.name, name: f.name }, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value, text: o.label })))
          : h('input', { id: 'pf-' + f.name, name: f.name, type: f.type || 'text', value: f.value ?? '', required: f.required !== false, autocomplete: 'off', inputmode: f.inputmode, min: f.min, max: f.max, class: f.code ? 'code' : null }),
        f.hint && h('span', { class: 'hint', text: f.hint }))),
      err,
      h('div', { class: 'row' }, btn, h('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => dialog.close('cancel') })));
    dialog.replaceChildren(form);
    let ok = false;
    dialog.addEventListener('close', () => resolve(ok), { once: true });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError(err, '');
      btn.disabled = true;
      try {
        await onSubmit(Object.fromEntries(new FormData(form).entries()));
        ok = true; dialog.close('ok');
      } catch (ex) {
        showError(err, ex.message || 'Something went wrong.');
      } finally { btn.disabled = false; }
    });
    if (!dialog.open) dialog.showModal();
    const first = form.querySelector('input, select'); if (first) first.focus();
  });
}
