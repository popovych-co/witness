#!/bin/sh
status=0
(cd packages/pkg-a && node "$VITEST_BIN" run -t "@spec:$1" --passWithNoTests) || status=1
(cd packages/pkg-b && node "$VITEST_BIN" run -t "@spec:$1" --passWithNoTests) || status=1
exit $status
