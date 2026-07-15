#!/bin/sh
# specflow SessionStart hook — inject the dashboard (stdout becomes session
# context). Silent everywhere that isn't a specflow repo; failures swallowed:
# session start must never hang or die on this.
[ -f specflow.config.yaml ] || exit 0
${SPECFLOW_BIN:-npx -y specflow@0.1.2} 2>/dev/null || true
