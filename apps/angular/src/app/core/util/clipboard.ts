/**
 * Clipboard helpers (ADR-025).
 *
 * Copy follows the precedent set by `graph-page.ts`: prefer the async Clipboard
 * API and fall back to a hidden textarea + `execCommand` when it is unavailable
 * (jsdom, insecure contexts). Read degrades to `''` when the API is missing, so
 * the clipboard-clone affordance never throws. The renderer never contacts Git.
 */

/** Copy `text` to the clipboard; never throws, returns whether it succeeded. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyFallback(text);
  }
}

/** Read text from the clipboard; returns `''` when the API is unavailable. */
export async function readClipboardText(): Promise<string> {
  try {
    const text = await navigator.clipboard.readText();
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/** Hidden-textarea `execCommand('copy')` fallback for environments without the async API. */
function copyFallback(text: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
