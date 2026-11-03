/**
 * Installing the app: registers the service worker (needed by browsers to offer
 * installation and to work offline) and drives an "Install the app" button.
 * Android and desktop Chrome/Edge raise `beforeinstallprompt`, which the button
 * replays; iPhone Safari has no such event, so it gets a short instruction.
 */
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  // Embedded previews (sandboxed frames) refuse it: the app works the same without.
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}

export function setupInstall(button: HTMLButtonElement, iosHint: HTMLElement) {
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;
  if (standalone) return;

  let deferred: InstallPrompt | null = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    button.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    button.hidden = true;
  });
  button.addEventListener('click', async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice.catch(() => undefined);
    deferred = null;
    button.hidden = true;
  });

  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  if (ios) iosHint.hidden = false;
}
