#!/usr/bin/env bash
#
# fetch-libs.sh - Download markdown rendering libraries for Chrome extension
#
# This script downloads marked.js, DOMPurify, and Prism.js libraries locally
# to comply with Chrome Extension Manifest V3 Content Security Policy.
#
# CSP requires all scripts to be bundled locally (script-src 'self')
# and does not allow loading from external CDNs.
#
# Usage: ./fetch-libs.sh

set -euo pipefail

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Library versions
MARKED_VERSION="11.1.1"
DOMPURIFY_VERSION="3.0.8"
PRISM_VERSION="1.29.0"

# Base URLs
JSDELIVR_BASE="https://cdn.jsdelivr.net/npm"
MARKED_URL="${JSDELIVR_BASE}/marked@${MARKED_VERSION}/marked.min.js"
DOMPURIFY_URL="${JSDELIVR_BASE}/dompurify@${DOMPURIFY_VERSION}/dist/purify.min.js"
PRISM_BASE="${JSDELIVR_BASE}/prismjs@${PRISM_VERSION}"

# Target directory (relative to script location)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBS_DIR="${SCRIPT_DIR}/libs"

# Prism language components
PRISM_LANGUAGES=(
  "typescript"
  "python"
  "javascript"
  "jsx"
  "tsx"
  "json"
  "bash"
  "css"
)

echo -e "${YELLOW}Fetching markdown libraries for UI Chatter extension...${NC}"
echo ""

# Create libs directory
echo -e "${GREEN}→${NC} Creating libs directory..."
mkdir -p "${LIBS_DIR}"

# Download core libraries
echo -e "${GREEN}→${NC} Downloading marked.js v${MARKED_VERSION}..."
curl -sSL "${MARKED_URL}" -o "${LIBS_DIR}/marked.min.js"

echo -e "${GREEN}→${NC} Downloading DOMPurify v${DOMPURIFY_VERSION}..."
curl -sSL "${DOMPURIFY_URL}" -o "${LIBS_DIR}/purify.min.js"

echo -e "${GREEN}→${NC} Downloading Prism.js v${PRISM_VERSION}..."
curl -sSL "${PRISM_BASE}/prism.min.js" -o "${LIBS_DIR}/prism.min.js"

echo -e "${GREEN}→${NC} Downloading Prism.js CSS theme..."
curl -sSL "${PRISM_BASE}/themes/prism.min.css" -o "${LIBS_DIR}/prism.min.css"

# Download Prism language components
echo -e "${GREEN}→${NC} Downloading Prism language components..."
for lang in "${PRISM_LANGUAGES[@]}"; do
  echo "  • ${lang}"
  curl -sSL "${PRISM_BASE}/components/prism-${lang}.min.js" \
    -o "${LIBS_DIR}/prism-${lang}.min.js"
done

# Verify downloads
echo ""
echo -e "${GREEN}→${NC} Verifying downloads..."
TOTAL_SIZE=0
ERROR=0

for file in "${LIBS_DIR}"/*.{js,css}; do
  if [ -f "$file" ]; then
    size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null)
    if [ "$size" -lt 100 ]; then
      echo -e "${RED}✗${NC} $(basename "$file") is too small (${size} bytes) - may be invalid"
      ERROR=1
    else
      TOTAL_SIZE=$((TOTAL_SIZE + size))
    fi
  fi
done

# Summary
echo ""
if [ $ERROR -eq 0 ]; then
  echo -e "${GREEN}✓${NC} All libraries downloaded successfully!"
  echo ""
  echo "📦 Total size: $((TOTAL_SIZE / 1024)) KB"
  echo "📁 Location: ${LIBS_DIR}"
  echo ""
  echo "Files downloaded:"
  ls -lh "${LIBS_DIR}" | tail -n +2 | awk '{printf "  • %-30s %6s\n", $9, $5}'
  echo ""
  echo -e "${YELLOW}Next steps:${NC}"
  echo "  1. Reload the extension in chrome://extensions/"
  echo "  2. Open DevTools Console"
  echo "  3. Check for: ✓ Markdown libraries loaded"
  exit 0
else
  echo -e "${RED}✗${NC} Some downloads failed. Please check your internet connection and try again."
  exit 1
fi
