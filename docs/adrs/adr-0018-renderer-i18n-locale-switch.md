---
id: adr-0018-renderer-i18n-locale-switch
category: adrs
tags:
- adr
- i18n
- renderer
aliases:
- ADR-0018
- Renderer i18n locale switch
related:
- adr-0017-docs-language-en
- renderer-slice
- documentation-system
version: 1.0
status: active
---

# ADR-0018: Renderer i18n with an EN/ES locale switch

## Problem

The renderer is English-only and has no way to switch language. The product requires an EN/ES switch with **English as the default**, and the documentation corpus now declares `doc_language: en` (ADR-0017), so the product language and the documented language must agree.

Angular's `@angular/localize` is a **build-time** mechanism: the standard `--localize` flow inlines one locale per build and emits a separate tree per locale. Angular provides no supported way to swap the runtime locale after bootstrap. A runtime i18n library would allow an in-place switch without a reload, but that option was explicitly rejected by the human decision. A decision is needed on the mechanism, the default locale, the persistence key, the switch UX and the scope.

## Solution

Use Angular's built-in `@angular/localize` in **single-build runtime `$localize` mode**. The decision, itemized:

1. **Mechanism = runtime `$localize`, not per-locale inlining.** Do **not** configure per-locale `--localize` in `angular.json`. Instead set project `i18n: { sourceLocale: 'en-US' }` and add `@angular/localize/init` to `polyfills`. An `extract-i18n` target (`format: json`) emits `apps/angular/src/locale/messages.json`; Spanish lives in `messages.es.json` alongside it.
2. **English is the source/default locale.** Spanish is loaded at boot in `src/main.ts` via `loadTranslations(doc.translations)`. The extractor JSON wraps translations as `{locale, translations}`, while `loadTranslations` expects the **inner** flat map — pass `doc.translations`, not the wrapper. Register `localeEs` via `registerLocaleData(localeEs)` and provide a matching `LOCALE_ID`.
3. **Persistence** = `localStorage['st:language']`, default `'en'`, invalid value falls back to `'en'`. This mirrors the `st:` key convention already used by `ThemeService`.
4. **`LanguageService`** is a root-provided service exposing signal-based `language`, `setLanguage(lang)` and `toggle()`. It writes storage synchronously and invokes an injectable `PAGE_RELOAD` seam so tests can override the reload.
5. **Switching language reloads the window.** This is an unavoidable consequence of `@angular/localize`; the runtime-library alternative was explicitly excluded by the human decision. Trade-off: a brief flash, shell/store re-initialization and loss of ephemeral UI state. There is **no** Electron or packaging change, because the build stays a single `dist/browser` tree.
6. **Scope = renderer only.** Electron native menus and dialogs are **not** localized in this iteration.
7. **Switch UI** = a dumb `LanguageSwitch` component hosted in the shell menubar. Markup uses `i18n` template attributes; TypeScript strings use `$localize`.

Tests cover `LanguageService`, the `LanguageSwitch` component, and a runtime `loadTranslations` integration test (`i18n-runtime.spec.ts`).

## When to use

- When adding any user-visible string in the renderer: mark it with `i18n`/`$localize` and provide the Spanish translation in `messages.es.json`.
- When reading or persisting the active language: go through `LanguageService`, never `localStorage` directly.
- When writing tests that trigger a language change: inject/override the `PAGE_RELOAD` seam instead of letting the window reload.

## When not to use

- To localize Electron native menus or dialogs — that is out of scope for this iteration.
- To add a third locale — the mechanism supports it, but a new supported locale is a new decision, not a config tweak.
- To switch locales without a reload — this is impossible under `@angular/localize`; do not simulate an in-place swap.
- To configure per-locale `--localize` inlining — that would break the single-build `dist/browser` packaging.

## Examples

Runtime boot load in `src/main.ts`:

```ts
import localeEs from '@angular/common/locales/es';
import { registerLocaleData } from '@angular/common';
import { loadTranslations } from '@angular/localize';

registerLocaleData(localeEs);

// extractor JSON is { locale, translations }; loadTranslations wants the inner map
const doc = (await import('./locale/messages.es.json')).default;
loadTranslations(doc.translations);
```

Persisted key, mirroring the `ThemeService` convention:

```ts
const STORAGE_KEY = 'st:language'; // 'en' default; invalid -> 'en'
```

Marking strings for translation:

```html
<button i18n="@@languageSwitch">Language</button>
```

```ts
const label = $localize`:@@languageSwitch:Language`;
```

## Common mistakes

- **Passing the extractor wrapper to `loadTranslations`** instead of `doc.translations` — the flat map never registers.
- **Configuring per-locale `--localize`** — produces multiple builds and breaks the single `dist/browser` tree.
- **Reading `localStorage` directly** instead of via `LanguageService`, and forgetting the invalid-value fallback to `'en'`.
- **Assuming the switch can be in-place** and building UI state that must survive a reload — the window reloads by design.
- **Leaving TypeScript strings unmarked**: template `i18n` attributes do not cover strings built in `.ts`.
- **Trying to localize the Electron shell** in this iteration — it is explicitly out of scope.
- **Forgetting the version bump** on any touched note.

## References

- Corpus language decision: [[adr-0017-docs-language-en]]
- Renderer slice: [renderer-slice](../slices/renderer-slice.md)
- Corpus contract and generated indexes: [[documentation-system]]
- ADR hub: [[adr-index]]
