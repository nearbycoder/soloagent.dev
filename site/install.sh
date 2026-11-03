#!/bin/sh
# soloagent installer: curl -fsSL https://soloagent.dev/install.sh | sh
#
# Installs the `soloagent` command with npm from the latest GitHub release.
# Needs Node.js 22.19 or newer. Without Node, use Docker instead:
#   docker run -d -p 7420:7420 -v soloagent:/data ghcr.io/nearbycoder/soloagent.dev
set -eu

PACKAGE="${SOLOAGENT_PACKAGE:-https://github.com/nearbycoder/soloagent.dev/releases/latest/download/soloagent.tgz}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

bold "soloagent installer"

command -v node >/dev/null 2>&1 || fail "Node.js 22.19+ is required. Install it from https://nodejs.org (or with fnm, nvm, or Homebrew), or run soloagent with Docker:
  docker run -d -p 7420:7420 -v soloagent:/data ghcr.io/nearbycoder/soloagent.dev"
command -v npm >/dev/null 2>&1 || fail "npm was not found next to node."

NODE_VERSION="$(node -p 'process.versions.node')"
node -e '
  const [a, b] = process.versions.node.split(".").map(Number);
  process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1);
' || fail "Node.js $NODE_VERSION is too old; soloagent needs 22.19 or newer."
dim "node $NODE_VERSION"

dim "installing $PACKAGE"
if ! npm install -g "$PACKAGE" --no-fund --no-audit; then
  fail "npm install -g failed. If it was a permissions error, configure a user-level npm prefix:
  npm config set prefix ~/.npm-global && export PATH=~/.npm-global/bin:\$PATH
then run this installer again."
fi

command -v soloagent >/dev/null 2>&1 || fail "Installed, but soloagent is not on your PATH. Add \$(npm prefix -g)/bin to PATH."

echo
bold "soloagent $(soloagent --version) is installed."
echo
echo "  soloagent            open the terminal UI (starts a private local server)"
echo "  soloagent serve      run the server with the web dashboard on http://localhost:7420"
echo "  soloagent token      print the admin token for the dashboard"
echo "  soloagent --help     everything else"
echo
dim "Docs: https://soloagent.dev/docs/"
