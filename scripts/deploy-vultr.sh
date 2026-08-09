#!/bin/bash
set -euo pipefail

printf '%s\n' \
  'manual Vultr deployment is retired; publish a protected release tag and use the approved GitHub production release.' \
  'For the one-time acceptance rollback check, an interactive root operator may run:' \
  '  /opt/minori/bin/rehearse-release <accepted-current-sha> <accepted-current-digest>' >&2
exit 2
