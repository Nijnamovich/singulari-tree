SingulariTree documentation assets
=================================

This folder holds images referenced from the root README.md. It is NOT part of
the docs corpus (only docs/**/*.md is validated), and these files carry no
frontmatter.

Current contents
----------------
placeholder-screenshot.svg
    A labeled SVG placeholder. It is explicitly NOT a real product capture; the
    Electron GUI cannot be screenshotted in the headless build environment. It
    exists so the README's Screenshots section renders and links correctly.

Screenshots to capture (manual, real GUI)
-----------------------------------------
Drop real captures here and update the image links in README.md -> Screenshots.
Suggested filenames and the exact state each should show:

1. repo-picker.png
   First launch, empty state: the repo path input + "Open" button before any
   repository is loaded.

2. commit-graph.png
   A repository opened and a commit row selected: the virtualized commit graph
   with the commit details panel (message + oid) visible.

3. diff-view.png
   A diff open in the renderer. NOTE: the current iteration is read-only
   history + a synthetic WIP row; there is no functional diff/stage/commit UI
   yet (see apps/electron/e2e/smoke.e2e.ts). Capture this only once that UI
   lands.

4. packaging-artifact.png
   The output of `cd apps/electron && npm run dist` — e.g. the Linux AppImage
   from apps/electron/release/ — shown as a desktop artifact. Builds are
   UNSIGNED.

Rules
-----
- Do NOT fabricate screenshots or commit mock UI images as if they were real.
- Keep filenames lowercase-kebab-case.
- Replace placeholder-screenshot.svg (and this note) once real captures exist.
