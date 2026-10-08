#!/usr/bin/env node
'use strict';
// Netlify skips ordinary Git builds on exit 0. Hooks bypass this command, so
// production-build and the preview/review wrapper must still enforce requests.
process.exitCode = ['main', 'develop', 'codex/manual-production-review'].includes(process.env.BRANCH) ? 0 : 1;
