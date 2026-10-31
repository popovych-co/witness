#!/bin/sh
# witness SessionStart hook — inject the dashboard (stdout becomes session
# context). Silent everywhere that isn't a witness repo; failures swallowed:
# session start must never hang or die on this.
[ -f witness.config.yaml ] || exit 0
# row 217: a reviewer reads; it never runs witness
[ -n "$WITNESS_REVIEWER" ] && exit 0
${WITNESS_BIN:-npx -y @popovych.co/witness@0.26.2} 2>/dev/null || true
