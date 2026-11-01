// Makes the website installable as a phone app (PWA) and wires up the "Download App" button.
let deferredPrompt = null;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

export const isInstalled = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

/** Triggers the native install prompt when available. Returns 'installed' | 'dismissed' | 'manual'. */
export async function installApp() {
  if (!deferredPrompt) return 'manual';
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  return outcome === 'accepted' ? 'installed' : 'dismissed';
}
