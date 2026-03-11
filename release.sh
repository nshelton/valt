#!/usr/bin/env bash
set -euo pipefail

# ── Prerequisites ──────────────────────────────────────────────────────────────

if ! command -v vsce &>/dev/null; then
  echo "Installing @vscode/vsce..."
  npm install -g @vscode/vsce
fi

if ! command -v gh &>/dev/null; then
  echo "Installing GitHub CLI..."
  brew install gh
fi

# ── Version ────────────────────────────────────────────────────────────────────

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

echo "Releasing ${TAG}..."

# ── Build & package ───────────────────────────────────────────────────────────

echo "Building extension..."
npm run build

echo "Packaging VSIX..."
vsce package

VSIX=$(ls -t *.vsix | head -1)
echo "Created: ${VSIX}"

# ── Git tag ───────────────────────────────────────────────────────────────────

if git rev-parse "${TAG}" &>/dev/null; then
  echo "Tag ${TAG} already exists — skipping tag creation."
else
  git tag "${TAG}"
  git push origin "${TAG}"
fi

# ── GitHub release ────────────────────────────────────────────────────────────

echo "Creating GitHub release ${TAG}..."
gh release create "${TAG}" "${VSIX}" \
  --title "${TAG}" \
  --notes "Install: download the .vsix and run \`code --install-extension ${VSIX}\`" \
  --repo nshelton/valt

echo "Done! https://github.com/nshelton/valt/releases/tag/${TAG}"
