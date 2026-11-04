/**
 * Installing the app: registers the service worker (needed by browsers to offer
 * installation and to work offline) and drives the "Install the app" button.
 * Where the browser can install by itself (Android Chrome, desktop Chrome/Edge,
 * via `beforeinstallprompt`) the button opens its dialog; everywhere else (iPhone,
 * in-app browsers, a browser that has not offered it yet) it shows the steps.
 */
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallHelpKey = 'install.ios' | 'install.android' | 'install.desktop';

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  // Embedded previews (sandboxed frames) refuse it: the app works the same without.
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}

export function installHelpKey(ua: string, touchPoints: number): InstallHelpKey {
  if (/iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && touchPoints > 1)) return 'install.ios';
  if (/Android/.test(ua)) return 'install.android';
  return 'install.desktop';
}

/** `show` writes a help text into an element by key, so a language switch re-renders it. */
export function setupInstall(button: HTMLButtonElement, help: HTMLElement, show: (el: HTMLElement, key: InstallHelpKey) => void) {
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;
  if (standalone) return;
  button.hidden = false;

  let deferred: InstallPrompt | null = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    button.hidden = true;
    help.hidden = true;
  });
  button.addEventListener('click', async () => {
    if (deferred) {
      const prompt = deferred;
      deferred = null;
      await prompt.prompt();
      const choice = await prompt.userChoice.catch(() => null);
      if (choice?.outcome === 'accepted') {
        button.hidden = true;
        return;
      }
    }
    show(help, installHelpKey(navigator.userAgent, navigator.maxTouchPoints));
    help.hidden = false;
  });
}
