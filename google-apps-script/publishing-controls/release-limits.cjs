'use strict';

// Keep the Apps Script store's maxBytes in sync with MAX_BYTES.
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_VIDEO_BYTES = 128 * 1024 * 1024;

module.exports = { MAX_BYTES, MAX_FILE_BYTES, MAX_VIDEO_BYTES };
