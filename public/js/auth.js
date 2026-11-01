// Sign-up (index.html) and login (login.html) logic.
import { api, busy, showError, mountFooter, getConfig } from './common.js';

const signupForm = document.getElementById('signup-form');
const loginForm = document.getElementById('login-form');
const form = signupForm || loginForm;
const errorBox = document.getElementById('form-error');

mountFooter();

if (signupForm) {
  getConfig().then((c) => {
    const f = document.getElementById('invite-field');
    f.hidden = !c.inviteRequired;
    document.getElementById('inviteCode').required = c.inviteRequired;
  }).catch(() => {});
}

// Already signed in? Skip straight to the right page.
api('GET', '/api/me').then(({ user }) => {
  location.replace(user.role === 'admin' ? 'admin.html' : 'home.html');
}).catch(() => { /* not signed in — stay */ });

// "Show password" toggle
document.getElementById('show-pw')?.addEventListener('change', (e) => {
  form.querySelectorAll('input[data-pw]').forEach((i) => { i.type = e.target.checked ? 'text' : 'password'; });
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(errorBox, '');
  const data = Object.fromEntries(new FormData(form).entries());
  const button = form.querySelector('button[type="submit"]');

  if (signupForm) {
    if (data.password !== data.confirmPassword) return showError(errorBox, 'Passwords do not match.');
    if (!document.getElementById('agree').checked) return showError(errorBox, 'Please accept the terms to continue.');
  }
  try {
    const { user } = await busy(button, signupForm ? 'Creating account…' : 'Logging in…', () =>
      api('POST', signupForm ? '/api/signup' : '/api/login', signupForm
        ? { inviteCode: data.inviteCode, name: data.name, phone: data.phone, password: data.password, confirmPassword: data.confirmPassword }
        : { phone: data.phone, password: data.password }));
    location.replace(user.role === 'admin' ? 'admin.html' : 'home.html');
  } catch (err) {
    showError(errorBox, err.message);
    errorBox.focus?.();
  }
});
