/// <reference types="@angular/localize" />

/**
 * Loads the `$localize` runtime and its ambient global declaration into every
 * TypeScript program (build and unit tests). The renderer uses `$localize`
 * directly in a few component classes, where the global is otherwise only
 * available in programs that import `@angular/localize` (e.g. `main.ts`).
 */
