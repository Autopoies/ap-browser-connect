// In-page snapshots keep node identity, not just a writable DOM attribute.
// Expressions run in the inspected page and must be self-contained.
export const STATE_ELEMENT_SELECTOR =
	'button, input, select, textarea, a[href], summary, [onclick], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [contenteditable], [tabindex]';
export const STATE_MAX_REFS = 250;

export function refSelector(ref) {
	return `[data-ap-ref="${ref}"]`;
}

export function isRefTarget(target) {
	return /^\d+$/.test(target);
}

export function snapshotIdentity(el) {
	const tag = el.tagName.toLowerCase();
	const field = tag === "input" || tag === "textarea" || tag === "select";
	return JSON.stringify([
		tag, el.getAttribute("role"), el.getAttribute("type"), el.getAttribute("href"),
		el.getAttribute("aria-label"), el.getAttribute("placeholder"),
		field ? "" : (el.textContent || "").replace(/\s+/g, " ").trim(),
	]);
}

export function resolveSnapshotRef(documentObject, ref) {
	const state = (documentObject.defaultView || window).__apBrowserRefs;
	const entry = state?.entries.get(Number(ref));
	const stale = () => ({ error: { code: "STALE_REF", message: `ref ${ref} changed or expired; run state again` } });
	if (!entry || !entry.el.isConnected || snapshotIdentity(entry.el) !== entry.identity) return stale();
	const r = entry.el.getBoundingClientRect();
	const view = documentObject.defaultView || window;
	if (view.innerWidth !== entry.vw || view.innerHeight !== entry.vh ||
		["x", "y", "width", "height"].some(key => Math.abs(r[key] - entry.rect[key]) > 2)) return stale();
	return { target: entry.el };
}

// refBase is reserved in extension session storage, so a navigation/worker
// restart cannot recycle old numbers. Same-node refs remain stable across reads.
export function buildSnapshotExpression(refBase = 0) {
	return `(() => {
  const MAX = ${STATE_MAX_REFS};
  const SEL = ${JSON.stringify(STATE_ELEMENT_SELECTOR)};
  const snapshotIdentity = ${snapshotIdentity.toString()};
  const state = window.__apBrowserRefs ||= { ids: new WeakMap(), entries: new Map(), next: ${refBase} };
  state.next = Math.max(state.next, ${refBase});
  state.entries.clear();
  const out = [], frames = [];
  let shadowRoots = 0, truncated = false;
  const visit = root => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { shadowRoots++; visit(el.shadowRoot); }
      const tag = el.tagName.toLowerCase();
      if (tag === 'iframe') frames.push({ src: el.getAttribute('src') || '', inspected: false });
      const style = getComputedStyle(el);
      const pointer = ['div', 'p', 'span', 'li', 'label'].includes(tag) && style.cursor === 'pointer' &&
        (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer');
      if (!el.matches(SEL) && typeof el.onclick !== 'function' && !pointer) continue;
      if (el.getAttribute('role') === 'presentation' || el.getAttribute('aria-hidden') === 'true') continue;
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) continue;
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) continue;
      if (out.length >= MAX) { truncated = true; continue; }
      let ref = state.ids.get(el);
      if (ref == null) { ref = state.next++; state.ids.set(el, ref); }
      const role = el.getAttribute('role') || (tag === 'button' ? 'button' : tag);
      const field = tag === 'input' || tag === 'textarea' || tag === 'select';
      const raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
        (field ? ((el.getAttribute('type') || '').toLowerCase() === 'password' ? '' : el.value) : el.textContent) || '';
      const name = raw.replace(/\\s+/g, ' ').trim().slice(0, 120);
      el.setAttribute('data-ap-ref', String(ref));
      state.entries.set(ref, { el, identity: snapshotIdentity(el), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, vw: window.innerWidth, vh: window.innerHeight });
      out.push({ ref, tag, role, name, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    }
  };
  visit(document);
  return JSON.stringify({ elements: out, scroll: { y: Math.round(window.scrollY), h: document.documentElement.scrollHeight, vh: window.innerHeight, vw: window.innerWidth }, url: location.href,
    coverage: { document: true, open_shadow_roots: shadowRoots, closed_shadow_roots: 'not accessible', iframes: frames, truncated } });
})()`;
}
