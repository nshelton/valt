#!/usr/bin/env bash
set -euo pipefail

# Ensure vsce is available
if ! command -v vsce &>/dev/null; then
  echo "Installing @vscode/vsce..."
  npm install -g @vscode/vsce
fi

echo "Building extension..."
npm run build

echo "Packaging VSIX..."
vsce package

VSIX=$(ls -t *.vsix | head -1)
echo "Created: $VSIX"
echo "Install with: code --install-extension $VSIX"
