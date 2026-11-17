#!/usr/bin/env bash
# Run the plugin's own test suites here, with no host and no `claude` on PATH.
#
#   bash test-harness/run.sh
#
# The suites under `hooks/` import two modules only the host provides;
# `stand-in/` supplies them and `loader.mjs` points those specifiers at it.
#
# The run happens from `hooks/` on purpose: the fixture in `stand-in/fixtures.js`
# imports `register.ts` from the working directory. That is why this tests the
# source itself rather than a copy of it — there is nothing to refresh.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
HOOKS="$(cd "$HERE/../hooks" && pwd)"

cd "$HOOKS" || exit 1
# Relative on purpose: `--import` takes a path, but an absolute Windows path
# (`C:/…`) is read as a URL with scheme `c:` and rejected. The harness is the
# sibling of `hooks/`, so this is stable.
exec node --import "../test-harness/loader.mjs" --test plan.test.ts register.test.ts
