#!/bin/bash
# Run once per clone to configure the local git repo for Bindery fork maintenance.
set -e

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "Configuring fork merge drivers..."

# Register the 'ours' merge driver - takes our version on any conflict.
# Used by .gitattributes for tsconfig.json, package.json, and stripped dirs.
git config merge.ours.driver true

# Ensure upstream remote exists
if ! git remote get-url upstream &>/dev/null; then
    echo "Adding upstream remote..."
    git remote add upstream https://github.com/badlogic/pi-mono.git
else
    echo "Upstream remote already configured: $(git remote get-url upstream)"
fi

echo ""
echo "Setup complete. You can now run scripts/pull-upstream.sh to sync with upstream."
