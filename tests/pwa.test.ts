import { describe, expect, it } from 'vitest';
import { installHelpKey } from '../src/pwa';

describe('install help', () => {
  it('picks the steps for the device', () => {
    expect(installHelpKey('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130 Mobile', 5)).toBe('install.android');
    expect(installHelpKey('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari', 5)).toBe('install.ios');
    // iPadOS asks for the desktop site but has a touch screen.
    expect(installHelpKey('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', 5)).toBe('install.ios');
    expect(installHelpKey('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130', 0)).toBe('install.desktop');
  });
});
