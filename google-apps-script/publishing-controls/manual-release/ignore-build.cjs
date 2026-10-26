#!/usr/bin/env node
'use strict';
// Netlify skips ordinary Git builds on exit 0. Hooks bypass this command, so
// Both publication commands must still enforce their explicit requests.
process.exitCode = ['main', 'develop'].includes(process.env.BRANCH) ? 0 : 1;
