#!/usr/bin/env bash
#
# gen-large-repo.sh — generate a large, synthetic Git repository for the
# Week-8 "bug bash repos grandes" / large-repo performance harness.
#
# Why: docs/context/git-client/testing-strategy.md calls for a 50k-commit
# synthetic repo to exercise GraphService.Lanes (<100ms). Building that with
# 50k sequential `git commit` invocations is far too slow, so this script
# streams the whole history through `git fast-import` (one process) and is
# deterministic/reproducible.
#
# Topology (default): a mostly-linear `main` chain with a 2-parent merge every
# `--interval` commits (the side spur is folded back in). This exercises the
# lane/convergence code paths without exploding lane count. Commit count is
# EXACT: `git rev-list --count HEAD` equals `--commits`.
#
# Edge-case shapes produced (Week-8 bug bash):
#   - two binary blobs: assets/logo.png (a real 1x1 PNG) and assets/data.bin
#     (4 KiB of NUL bytes) so the renderer/diff paths see binary content.
#   - `--with-submodule`: adds a `.gitmodules` + a `vendor/dep` gitlink
#     (mode 160000) pointing at a one-commit nested repo created next to OUT.
#     Skipped by default because a submodule needs a second repo and is only a
#     cheap edge case when explicitly requested.
#
# Determinism: fixed author/committer identity ("Large Repo
# <large-repo@example.com>"), fixed base timestamp 1600000000 (+60s/commit,
# +0000) and sequential commit messages. No randomness anywhere, so the same
# inputs produce the same object ids (note: `git fast-import` output is
# deterministic for a given git version; ids may differ across git versions
# because of zlib/pack details).
#
# Usage:
#   tools/scripts/gen-large-repo.sh [--commits N] [--out DIR] [--interval K]
#                                   [--with-submodule] [--force]
#
# Flags:
#   --commits N        Number of commits to generate (default: 50000).
#   --out DIR          Output repository directory.
#                      Default: ${TMPDIR:-/tmp}/singulari-tree-large-repo-N
#   --interval K       Merge every K commits, K >= 4 (default: 250).
#   --with-submodule   Also emit a vendor/dep gitlink + .gitmodules.
#   --force            Overwrite an existing repo/dir at --out.
#   -h, --help         Show this help.
#
# Idempotency: if --out is already a git repo with exactly N commits it is
# reused (fast); any other pre-existing path is an error unless --force.
#
# Cross-platform: bash + coreutils. Uses GNU/BSD-portable `printf`, `head -c`
# and `sed` only. No `sha1sum`/`shasum` dependency (git computes the hashes).
# No BSD-only or GNU-only flags. `/dev/zero` is POSIX.
#
set -euo pipefail

usage() {
  cat <<'EOF'
gen-large-repo.sh -- generate a large, synthetic Git repository (fast-import).

Usage:
  tools/scripts/gen-large-repo.sh [--commits N] [--out DIR] [--interval K]
                                  [--with-submodule] [--force]

Flags:
  --commits N        Number of commits to generate (default: 50000).
  --out DIR          Output repository directory.
                     Default: ${TMPDIR:-/tmp}/singulari-tree-large-repo-N
  --interval K       Merge every K commits, K >= 4 (default: 250).
  --with-submodule   Also emit a vendor/dep gitlink + .gitmodules.
  --force            Overwrite an existing repo/dir at --out.
  -h, --help         Show this help.

Deterministic: fixed identity/timestamps, no randomness. Commit count is
exact (git rev-list --count HEAD == N). See the file header for details.
EOF
}

COMMITS=50000
OUT=""
INTERVAL=250
WITH_SUBMODULE=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commits) COMMITS="${2:?--commits needs a value}"; shift 2 ;;
    --commits=*) COMMITS="${1#*=}"; shift ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --out=*) OUT="${1#*=}"; shift ;;
    --interval) INTERVAL="${2:?--interval needs a value}"; shift 2 ;;
    --interval=*) INTERVAL="${1#*=}"; shift ;;
    --with-submodule) WITH_SUBMODULE=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "error: git not found on PATH" >&2
  exit 1
fi
if ! [[ "$COMMITS" =~ ^[0-9]+$ ]] || (( COMMITS < 1 )); then
  echo "error: --commits must be a positive integer (got '$COMMITS')" >&2
  exit 2
fi
if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]] || (( INTERVAL < 4 )); then
  echo "error: --interval must be an integer >= 4 (got '$INTERVAL')" >&2
  exit 2
fi

OUT="${OUT:-${TMPDIR:-/tmp}/singulari-tree-large-repo-${COMMITS}}"

# --- Idempotency / safety --------------------------------------------------
if [[ -e "$OUT" ]]; then
  if git -C "$OUT" rev-parse --git-dir >/dev/null 2>&1; then
    existing="$(git -C "$OUT" rev-list --count HEAD 2>/dev/null || echo 0)"
    if (( FORCE == 1 )); then
      echo "Removing existing repo at $OUT (--force)"
      rm -rf "$OUT"
    elif [[ "$existing" == "$COMMITS" ]]; then
      echo "Reusing existing repo at $OUT ($existing commits)"
      echo "Repo:    $OUT"
      echo "Commits: $existing"
      exit 0
    else
      echo "error: $OUT is a git repo with $existing commits, expected $COMMITS;" >&2
      echo "       re-run with --force to regenerate." >&2
      exit 1
    fi
  else
    if (( FORCE == 1 )); then
      rm -rf "$OUT"
    else
      echo "error: $OUT exists and is not a git repo; use --force to overwrite." >&2
      exit 1
    fi
  fi
fi

mkdir -p "$OUT"
git -C "$OUT" init -q
git -C "$OUT" symbolic-ref HEAD refs/heads/main
git -C "$OUT" config commit.gpgsign false

# --- Optional submodule fixture -------------------------------------------
SUBDIR=""
SUBSHA=""
if (( WITH_SUBMODULE == 1 )); then
  SUBDIR="${OUT}.submodule"
  rm -rf "$SUBDIR"
  mkdir -p "$SUBDIR"
  git -C "$SUBDIR" init -q
  git -C "$SUBDIR" symbolic-ref HEAD refs/heads/main
  git -C "$SUBDIR" config user.name "Large Repo"
  git -C "$SUBDIR" config user.email "large-repo@example.com"
  git -C "$SUBDIR" config commit.gpgsign false
  printf 'dep\n' > "$SUBDIR/README.md"
  git -C "$SUBDIR" add README.md
  GIT_AUTHOR_DATE="2020-09-13T12:26:40+00:00" \
  GIT_COMMITTER_DATE="2020-09-13T12:26:40+00:00" \
    git -C "$SUBDIR" commit -q -m "dep: initial"
  SUBSHA="$(git -C "$SUBDIR" rev-parse HEAD)"
fi

# --- fast-import stream -----------------------------------------------------
# Blob marks: 1 README, 2..17 rotating src/main.go, 100 logo.png, 101 data.bin,
# 102 .gitmodules. Commit marks: 100000 + sequence number.
emit_blob() { # $1 mark, $2 content (byte length counted, not chars)
  local mark="$1" content="$2" n
  n="$(printf '%s' "$content" | wc -c)"
  printf 'blob\nmark :%s\ndata %d\n%s\n' "$mark" "$n" "$content"
}

emit_png_blob() {
  # Valid 70-byte 1x1 transparent PNG (see header).
  local hex="89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fccfc0500f000485018084a98c210000000049454e44ae426082"
  local n=$(( ${#hex} / 2 ))
  printf 'blob\nmark :100\ndata %d\n' "$n"
  printf '%b' "$(printf '%s' "$hex" | sed 's/../\\x&/g')"
  printf '\n'
}

emit_zero_blob() {
  local size=4096
  printf 'blob\nmark :101\ndata %d\n' "$size"
  head -c "$size" /dev/zero
  printf '\n'
}

emit_blobs() {
  emit_blob 1 "# synthetic large repo

Generated by tools/scripts/gen-large-repo.sh - do not edit.
"
  local i
  for (( i = 0; i < 16; i++ )); do
    emit_blob $(( 2 + i )) "package main

// src/main.go variant $i
func main() {}
"
  done
  emit_png_blob
  emit_zero_blob
  if (( WITH_SUBMODULE == 1 )); then
    emit_blob 102 "[submodule \"vendor/dep\"]
	path = vendor/dep
	url = ./dep
"
  fi
}

emit_commits() {
  awk -v n="$COMMITS" -v interval="$INTERVAL" \
      -v withSub="$WITH_SUBMODULE" -v subSha="$SUBSHA" '
function emit(prev, extra, msgnum, ts,    msg, len) {
  msg = "commit " msgnum " (synthetic large repo)"
  len = length(msg)
  print "commit refs/heads/main"
  print "mark :" (base + msgnum)
  print "author " ident " " int(ts) " +0000"
  print "committer " ident " " int(ts) " +0000"
  print "data " len
  print msg
  if (prev > 0)  print "from :" (base + prev)
  if (extra > 0) print "merge :" (base + extra)
  print "M 100644 :1 README.md"
  print "M 100644 :" (2 + (msgnum % 16)) " src/main.go"
  print "M 100644 :100 assets/logo.png"
  print "M 100644 :101 assets/data.bin"
  if (withSub == "1") {
    print "M 100644 :102 .gitmodules"
    print "M 160000 " subSha " vendor/dep"
  }
  return msgnum
}
BEGIN {
  base = 100000
  ident = "Large Repo <large-repo@example.com>"
  ci = 0
  prev = 0
  ts = 1600000000
  nblocks = int(n / interval)
  tail = n % interval
  for (b = 0; b < nblocks; b++) {
    blockBase = prev
    last = blockBase
    # plain chain commits
    for (j = 0; j < interval - 2; j++) {
      ci++
      last = emit(last, 0, ci, ts)
      ts += 60
    }
    # side spur off the block base, then fold it back with a merge
    ci++
    spur = emit(blockBase, 0, ci, ts)
    ts += 60
    ci++
    last = emit(last, spur, ci, ts)
    ts += 60
    prev = last
  }
  # straight tail so total is exactly n
  for (j = 0; j < tail; j++) {
    ci++
    prev = emit(prev, 0, ci, ts)
    ts += 60
  }
  if (ci != n) {
    print "internal error: generated " ci " commits, expected " n > "/dev/stderr"
    exit 3
  }
}
'
}

echo "Generating $COMMITS commits at $OUT ..."
start_ts="$(date +%s)"

{
  emit_blobs
  emit_commits
} | git -C "$OUT" fast-import --quiet

git -C "$OUT" symbolic-ref HEAD refs/heads/main
git -C "$OUT" reset --hard -q HEAD

end_ts="$(date +%s)"
count="$(git -C "$OUT" rev-list --count HEAD)"

echo "Repo:     $OUT"
echo "Commits:  $count"
echo "Elapsed:  $(( end_ts - start_ts ))s"
if (( WITH_SUBMODULE == 1 )); then
  echo "Submodule: $SUBDIR (vendor/dep -> ${SUBSHA:0:12})"
fi
