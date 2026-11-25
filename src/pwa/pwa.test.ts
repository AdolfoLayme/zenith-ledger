import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { isMobileDevice, MOBILE_NO_NANO_NOTICE, registerServiceWorker } from './pwa';

function readPngDimensions(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  // IHDR chunk starts at byte 8 (4 len + 4 'IHDR' + 4 width + 4 height)
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

describe('PWA manifest, proprietary icons, service worker, and mobile detection', () => {
  it('detects Android and iOS user agents as mobile devices without Gemini Nano', () => {
    expect(
      isMobileDevice(
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe(true);
    expect(
      isMobileDevice(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(true);
    expect(
      isMobileDevice(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
      ),
    ).toBe(false);
    expect(MOBILE_NO_NANO_NOTICE).toBe(
      'On-device AI is not available on this device: local rules still run; cloud only sees aliases after your approval',
    );
  });

  it('ships a valid manifest.webmanifest with proprietary SVG and PNG icons of exact dimensions', () => {
    expect(existsSync('public/manifest.webmanifest')).toBe(true);
    const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as {
      name: string;
      short_name: string;
      display: string;
      start_url: string;
      theme_color: string;
      background_color: string;
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };

    expect(manifest.name).toBe('Zenith Ledger');
    expect(manifest.short_name).toBe('Zenith Ledger');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.theme_color).toBe('#4f46e5');
    expect(manifest.background_color).toBe('#ffffff');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);

    for (const icon of manifest.icons) {
      const diskPath = `public${icon.src}`;
      expect(existsSync(diskPath), `missing icon: ${diskPath}`).toBe(true);
    }

    const svg = readFileSync('public/icons/icon.svg', 'utf8');
    expect(svg).toContain('<svg');
    expect(readPngDimensions('public/icons/icon-192.png')).toEqual({ width: 192, height: 192 });
    expect(readPngDimensions('public/icons/icon-512.png')).toEqual({ width: 512, height: 512 });
    expect(readPngDimensions('public/icons/apple-touch-icon.png')).toEqual({ width: 180, height: 180 });

    const html = readFileSync('index.html', 'utf8');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toContain('href="/icons/apple-touch-icon.png"');
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(html).toContain('leaving your device');
    expect(html).not.toContain('leaving your laptop');

    const appUi = readFileSync('src/ui/App.tsx', 'utf8');
    expect(appUi).toContain('without your bank data leaving your device.');
    expect(appUi).not.toContain('leaving your laptop');
  });

  it('ships a hand-written service worker that caches the app shell for offline local analysis', () => {
    expect(existsSync('public/sw.js')).toBe(true);
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(sw).toContain('zenith-ledger-shell');
    expect(sw).toContain('/manifest.webmanifest');
    expect(sw).toContain("addEventListener('install'");
    expect(sw).toContain("addEventListener('activate'");
    expect(sw).toContain("addEventListener('fetch'");
    // Only same-origin GET requests are cached; Firebase API calls are never intercepted
    expect(sw).toContain('url.origin !== self.location.origin');
  });

  it('registers /sw.js on http/https origins and skips chrome-extension protocol', async () => {
    const register = vi.fn().mockResolvedValue({});
    await registerServiceWorker({
      protocol: 'https:',
      serviceWorker: { register },
    });
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });

    const extRegister = vi.fn();
    await registerServiceWorker({
      protocol: 'chrome-extension:',
      serviceWorker: { register: extRegister },
    });
    expect(extRegister).not.toHaveBeenCalled();
  });
});
