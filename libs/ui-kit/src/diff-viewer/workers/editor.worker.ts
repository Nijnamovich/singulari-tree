// Bundled Monaco editor worker entry (lazy chunk). Kept tiny on purpose: the
// `?worker`/`new Worker(new URL(...))` machinery is owned by the bundler.
import 'monaco-editor/editor/editor.worker';
