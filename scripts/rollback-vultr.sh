#!/bin/bash
set -euo pipefail

printf '%s\n' \
  'general manual rollback is retired; no second operational deployment protocol is available.' \
  'For the one-time acceptance rollback check, an interactive root operator may run:' \
  '  /opt/minori/bin/rehearse-release <accepted-current-sha> <accepted-current-digest>' >&2
exit 2
