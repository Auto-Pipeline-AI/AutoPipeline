'use strict';

/** Removes the fetched apps (./apps) so setup can start fresh. */

const { APPS_DIR, log, fs } = require('./lib');

if (fs.existsSync(APPS_DIR)) {
  fs.rmSync(APPS_DIR, { recursive: true, force: true });
  log('clean', 'Removed ./apps. Run `npm run setup` to fetch and install again.');
} else {
  log('clean', 'Nothing to clean (./apps does not exist).');
}
