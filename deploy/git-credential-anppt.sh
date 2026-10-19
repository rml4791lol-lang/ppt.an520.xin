#!/usr/bin/env bash
# Server-side Git credential helper. The token is root-only; the helper is
# executed as ubuntu through the deploy account and reads it with sudo -n.
set -euo pipefail
if [[ "${1:-}" == "get" ]]; then
  printf 'username=x-access-token\n'
  printf 'password=%s\n' "$(sudo -n cat /opt/anppt-v2/git/github_token)"
fi
