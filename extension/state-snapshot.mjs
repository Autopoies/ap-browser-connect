// In-page state snapshot: interactive-element enumeration with stable [N] refs.
//
// Modeled on opencli's `browser state` contract: the snapshot assigns a
// numeric ref to every visible interactive element and tags the DOM with
// `data-ap-ref="N"` so later interaction commands (click/fill/wait) can
// target `[N]` without a CSS selector. Refs survive soft DOM drift; when the
// page re-renders so hard that the element is gone, the interaction returns
// STALE_REF and the agent re-runs `state`.
//
// Everything here runs inside the page via Runtime.evaluate, so each
// expression must be a self-contained IIFE.

export const STATE_ELEMENT_SELECTOR =
	'button, input, select, textarea, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [contenteditable], [tabindex]';

export const STATE_MAX_REFS = 120;

const REF_ATTR = "data-ap-ref";

// NOTE: annotated screenshots are composited CLI-side (cli/src/annotate.rs)
// from this snapshot's rects — DOM overlays don't survive CDP capture on
// background tabs (stale compositor frames), so keep the snapshot output as
// the single source of truth for annotation geometry.

export function refSelector(ref) {
	return `[data-ap-ref="${ref}"]`;
}

export function isRefTarget(target) {
	return /^\d+$/.test(target);
}

export function buildSnapshotExpression() {
	return `(() => {
  const MAX = ${STATE_MAX_REFS};
  const SEL = ${JSON.stringify(STATE_ELEMENT_SELECTOR)};
  const REF = ${JSON.stringify(REF_ATTR)};
  let n = 0;
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (n >= MAX) break;
    // tabindex="-1" is programmatic focus only, not tabbable; role
    // "presentation" wrappers are containers, not controls.
    if (el.getAttribute('tabindex') === '-1') continue;
    if (el.getAttribute('role') === 'presentation') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'button' ? 'button' : tag);
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    const raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') || (isField ? el.value : el.textContent) || '';
    const name = raw.replace(/\\s+/g, ' ').trim().slice(0, 120);
    el.setAttribute(REF, String(n));
    out.push({ ref: n, tag, role, name, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    n++;
  }
  return JSON.stringify({ elements: out, scroll: { y: Math.round(window.scrollY), h: document.documentElement.scrollHeight, vh: window.innerHeight, vw: window.innerWidth }, url: location.href });
})()`;
}
