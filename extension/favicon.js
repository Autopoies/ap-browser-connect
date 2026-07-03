export const AP_ICON_SVG = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="16" y2="16" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#313B42"/>
      <stop offset="1" stop-color="#242B30"/>
    </linearGradient>
  </defs>
  <rect width="16" height="16" rx="3" fill="url(#bg)"/>
  <g transform="translate(-1 0.5) scale(0.0165)">
    <path d="M 237.4 310 L 258.2 310 Q 274.6 310 283.5 323.8 L 296.3 343.8 Q 326 390 271.1 390 L 130.9 390 Q 76 390 105.7 343.8 L 230.8 149.3 Q 256 110 281.2 149.3 L 436 390" fill="none" stroke="#5AA788" stroke-width="56" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

function apIconDataUrl() {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(AP_ICON_SVG)));
  return `data:image/svg+xml;base64,${b64}`;
}

const AP_ICON_URL = apIconDataUrl();

export async function swapFaviconToSparkle(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (iconUrl) => {
      if (window.__apOriginalIcon === undefined) {
        window.__apOriginalIcon = document.querySelector('link[rel*="icon"]')?.href || null;
      }
      let link = document.querySelector("link[rel~='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = iconUrl;
    },
    args: [AP_ICON_URL],
  });
}

export async function restoreFavicon(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (window.__apOriginalIcon === undefined) return;
      const link = document.querySelector("link[rel~='icon']");
      if (link) {
        if (window.__apOriginalIcon) link.href = window.__apOriginalIcon;
        else link.remove();
      }
      delete window.__apOriginalIcon;
    },
  });
}
