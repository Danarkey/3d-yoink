#!/bin/bash
# ══════════════════════════════════════════════════════════
#  3D Yoink — Double-click to launch
# ══════════════════════════════════════════════════════════

cd "$(dirname "$0")"
PORT=${YOINK_PORT:-8787}
URL="http://127.0.0.1:$PORT"

clear
echo ""
echo "  ╔═══════════════════════════╗"
echo "  ║       3D  Y O I N K       ║"
echo "  ╚═══════════════════════════╝"
echo ""

# ── Check Node.js ────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "  ✗  Node.js is not installed."
  echo ""
  echo "     Download it from https://nodejs.org (LTS)"
  echo "     or run:  brew install node"
  echo ""
  echo "  Press any key to close."
  read -n1 -s
  exit 1
fi
echo "  ✓  Node.js $(node -v)"

# ── Check Blender (optional) ────────────────────────────
BLENDER=""
if [ -n "$BLENDER_PATH" ]; then
  BLENDER="$BLENDER_PATH"
elif [ -x "/Applications/Blender.app/Contents/MacOS/Blender" ]; then
  BLENDER="/Applications/Blender.app/Contents/MacOS/Blender"
elif command -v blender &>/dev/null; then
  BLENDER="blender"
fi

if [ -n "$BLENDER" ]; then
  echo "  ✓  $("$BLENDER" --version 2>/dev/null | head -1)"
else
  echo "  ⚠  Blender not found (FBX models will export geometry only)"
fi

echo ""
echo "  Starting server..."
echo ""

# ── Open browser after a short delay ────────────────────
(sleep 2 && open "$URL") &

# ── Run the server (keeps this window open) ─────────────
node server.mjs

# If server exits, keep window open so they can see errors
echo ""
echo "  Server stopped. Press any key to close."
read -n1 -s