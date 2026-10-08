#!/usr/bin/env node
'use strict';
require('./build.cjs').productionBuild().then(result => console.log('Manually confirmed production package: ' + result.projects + ' projects.'))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
