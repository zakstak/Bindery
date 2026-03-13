#!/bin/bash
# Sync Bindery fork with upstream (https://github.com/badlogic/pi-mono).
#
# Prerequisites: run scripts/setup-fork.sh once per clone first.
#
# Strategy:
#   - Merges upstream/main into our main.
#   - .gitattributes merge=ours driver auto-resolves conflicts in tsconfig.json,
#     package.json, package-lock.json, and any files in stripped packages.
#   - Post-merge cleanup re-enforces stripped directory deletions in case upstream
#     added new files to those paths cleanly (no conflict, just new paths).
set -e

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Verify the ours merge driver is configured
if ! git config merge.ours.driver &>/dev/null; then
    echo "ERROR: merge driver not configured. Run scripts/setup-fork.sh first."
    exit 1
fi

# Verify working tree is clean
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "ERROR: Working tree has uncommitted changes. Commit or stash before syncing."
    exit 1
fi

echo "Fetching upstream..."
git fetch upstream

UPSTREAM_HEAD=$(git rev-parse upstream/main)
LOCAL_HEAD=$(git rev-parse HEAD)

if [ "$UPSTREAM_HEAD" = "$LOCAL_HEAD" ]; then
    echo "Already up to date with upstream/main."
    exit 0
fi

BEHIND=$(git rev-list --count HEAD..upstream/main)
echo "Merging $BEHIND upstream commit(s) into main..."

# Merge - .gitattributes handles conflict resolution automatically for our owned files.
# Any remaining conflict in un-owned files (e.g. packages/coding-agent src changes) surfaces
# for manual resolution as normal.
if ! git merge upstream/main --no-edit -m "chore: sync upstream main"; then
    echo ""
    echo "Merge conflict in an un-owned file. Resolve conflicts above, then:"
    echo "  git add <conflicted-files>"
    echo "  git commit"
    echo ""
    echo "Then re-run this script to complete the post-merge cleanup, or run:"
    echo "  scripts/pull-upstream.sh --cleanup-only"
    exit 1
fi

# Post-merge: strip package directories upstream may have added cleanly.
STRIPPED_PKGS=(
    packages/mom
    packages/web-ui
    packages/pods
    packages/agent-old
    packages/ai
    packages/agent
    packages/tui
)
NEED_COMMIT=false

for pkg in "${STRIPPED_PKGS[@]}"; do
    if [ -d "$pkg" ] || git ls-files --error-unmatch "$pkg" &>/dev/null 2>&1; then
        echo "Removing upstream path: $pkg"
        git rm -rf "$pkg" 2>/dev/null || true
        NEED_COMMIT=true
    fi
done

# Also remove upstream examples directory we've stripped
if [ -d "packages/coding-agent/examples" ] && git ls-files --error-unmatch "packages/coding-agent/examples" &>/dev/null 2>&1; then
    echo "Removing upstream examples directory"
    git rm -rf packages/coding-agent/examples 2>/dev/null || true
    NEED_COMMIT=true
fi

# Strip individual upstream files we've removed
STRIPPED_FILES=(
    .github
    CONTRIBUTING.md
    test.sh
    scripts/build-binaries.sh
    scripts/release.mjs
    scripts/sync-versions.js
    scripts/browser-smoke-entry.ts
)

for f in "${STRIPPED_FILES[@]}"; do
    if git ls-files --error-unmatch "$f" &>/dev/null 2>&1; then
        echo "Removing upstream file: $f"
        git rm -rf "$f" 2>/dev/null || true
        NEED_COMMIT=true
    fi
done

if [ "$NEED_COMMIT" = true ] && ! git diff --cached --quiet; then
    git commit -m "chore: re-strip upstream-only paths after sync"
fi

echo ""
echo "Sync complete. Local main now includes upstream/main."

if git remote get-url origin &>/dev/null; then
    if git show-ref --verify --quiet refs/remotes/origin/main; then
        echo "$(git rev-list --count origin/main..HEAD) local commit(s) ahead of origin/main."
    else
        echo "Origin remote is configured, but origin/main is not available locally yet."
    fi

    echo "Push to your private origin when ready: git push origin HEAD"
else
    echo "No origin remote configured. Push to your private fork remote when ready."
fi
