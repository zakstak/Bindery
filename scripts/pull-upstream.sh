#!/bin/bash
set -e

echo "Pulling upstream main..."
if ! git pull upstream main --no-edit; then
    echo ""
    echo "Merge conflict detected! If the conflict is in packages/mom, packages/web-ui, or packages/pods, it's because upstream modified them."
    echo "Auto-resolving by deleting them..."
    
    rm -rf packages/mom packages/web-ui packages/pods
    git rm -rf packages/mom packages/web-ui packages/pods 2>/dev/null || true
    
    # Check if package.json or tsconfig.json have conflicts
    if git diff --name-only --diff-filter=U | grep -qE "package\.json|tsconfig\.json"; then
        echo "Please manually resolve conflicts in package.json and/or tsconfig.json, then run 'git commit'."
        exit 1
    else
        git commit --no-edit
    fi
fi

# Ensure they stay gone just in case upstream recreated them cleanly
rm -rf packages/mom packages/web-ui packages/pods
git rm -rf packages/mom packages/web-ui packages/pods 2>/dev/null || true

# If we just staged a deletion, commit it
if ! git diff --cached --quiet; then
    git commit -m "chore: remove unwanted upstream packages"
fi

echo "Successfully pulled upstream! Your fork is clean."
