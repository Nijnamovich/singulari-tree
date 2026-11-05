/**
 * Lazy delivery of Monaco's stylesheet.
 *
 * Monaco's ESM modules import their CSS as side-effect bundles. `@angular/build`
 * 22 only collects CSS whose output has an `entryPoint` set; esbuild's
 * `cssBundle` association is ignored, so the imported Monaco CSS is emitted as
 * orphan `chunk-*.css` files that nothing references — the editor then mounts
 * unstyled (`position: static`, `overflow: visible`) and its panes bleed into
 * each other.
 *
 * `apps/angular/angular.json` therefore declares a second global-style entry for
 * `monaco-editor/min/vs/editor/editor.main.css` with `inject: false` and
 * `bundleName: "monaco"`. That builds the sheet in a non-initial bundler context
 * and emits a stable `monaco.css` next to `index.html`, excluded from the initial
 * bundle/budget and never linked by `index.html`. This module injects that link
 * on demand, just before Monaco is created.
 *
 * The href is resolved against `document.baseURI`: production loads the bundle
 * through the privileged `app://bundle/index.html` protocol, so a hardcoded
 * `/monaco.css` would resolve against the wrong origin. A missing or blocked
 * stylesheet must never hang the editor: the promise also resolves on `error`
 * and after a bounded safety timeout, leaving the existing fallback path in
 * charge if the sheet cannot be applied.
 */
export const MONACO_CSS_HREF = 'monaco.css';

const LINK_SELECTOR = 'link[data-st-monaco-css]';
/** Safety valve: a link that never fires load/error must not block Monaco. */
const LOAD_TIMEOUT_MS = 3000;

/** Module-level cache so duplicate callers share one link (and one wait). */
let pending: Promise<void> | null = null;

function existingMonacoLink(doc: Document): HTMLLinkElement | null {
  return doc.head?.querySelector<HTMLLinkElement>(LINK_SELECTOR) ?? null;
}

/**
 * Ensure Monaco's non-injected `monaco.css` is linked into `doc`.
 *
 * Idempotent: reuses the module-level promise and, when a
 * `<link data-st-monaco-css>` already exists (HMR or a duplicate module
 * instance), resolves immediately without appending a second link. Resolves on
 * `load`, `error` or after {@link LOAD_TIMEOUT_MS}; the `doc` parameter exists so
 * unit tests can drive an isolated document.
 */
export function ensureMonacoCss(doc: Document = document): Promise<void> {
  if (pending) return pending;

  if (existingMonacoLink(doc)) {
    pending = Promise.resolve();
    return pending;
  }

  pending = new Promise<void>((resolve) => {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL(MONACO_CSS_HREF, doc.baseURI).href;
    link.setAttribute('data-st-monaco-css', '');

    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      link.removeEventListener('load', finish);
      link.removeEventListener('error', finish);
      resolve();
    };

    link.addEventListener('load', finish);
    link.addEventListener('error', finish);
    timer = setTimeout(finish, LOAD_TIMEOUT_MS);
    doc.head.appendChild(link);
  });

  return pending;
}
