#!/bin/sh
# witness SessionStart hook — inject the dashboard (stdout becomes session
# context). Silent everywhere that isn't a witness repo; failures swallowed:
# session start must never hang or die on this.
[ -f witness.config.yaml ] || exit 0
${WITNESS_BIN:-npx -y @popovych.co/witness@0.5.1} 2>/dev/null || true
