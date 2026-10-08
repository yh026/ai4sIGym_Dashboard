#!/usr/bin/env node
'use strict';
require('./build.cjs').reviewBuild().then(result => console.log('Production review prepared: ' + result.projects + ' projects.'))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
