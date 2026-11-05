import * as monaco from 'monaco-editor';
import { ensureMonacoCss } from './monaco-css';
import {
  SINGULARITREE_DARK,
  SINGULARITREE_LIGHT,
  singularitreeDarkTheme,
  singularitreeLightTheme,
} from './monaco-theme';

/**
 * Monaco worker factory. The worker entries are separate bundles; the Angular
 * build's web-worker transformer rewrites each `new Worker(new URL(...))` to the
 * emitted worker chunk. This module is only ever loaded lazily (never part of
 * the initial bundle), so Monaco stays out of the critical path.
 */
function getWorker(_workerId: string, label: string): Worker {
  switch (label) {
    case 'json':
      return new Worker(new URL('./workers/json.worker', import.meta.url), { type: 'module' });
    case 'css':
    case 'scss':
    case 'less':
      return new Worker(new URL('./workers/css.worker', import.meta.url), { type: 'module' });
    case 'html':
    case 'handlebars':
    case 'razor':
      return new Worker(new URL('./workers/html.worker', import.meta.url), { type: 'module' });
    case 'typescript':
    case 'javascript':
      return new Worker(new URL('./workers/typescript.worker', import.meta.url), { type: 'module' });
    default:
      return new Worker(new URL('./workers/editor.worker', import.meta.url), { type: 'module' });
  }
}

(globalThis as unknown as { MonacoEnvironment: { getWorker: typeof getWorker } }).MonacoEnvironment = {
  getWorker,
};

// Register the custom themes before handing the module back, so
// `monaco.editor.setTheme` never references an unregistered theme name.
monaco.editor.defineTheme(SINGULARITREE_DARK, singularitreeDarkTheme());
monaco.editor.defineTheme(SINGULARITREE_LIGHT, singularitreeLightTheme());

/**
 * Loaded lazily by the diff viewer. Monaco's stylesheet comes from the
 * non-injected `monaco.css` built from `angular.json`, so it must be linked
 * before the editor is created — otherwise the diff panes mount unstyled.
 */
export async function loadMonaco(): Promise<typeof monaco> {
  await ensureMonacoCss();
  return monaco;
}

export default monaco;
