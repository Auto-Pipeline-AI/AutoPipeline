/**
 * Cross-platform script to copy .env-example to .env if .env doesn't exist
 * Works on both Windows and Unix systems
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');

// Files to process
const envFiles = [
  // Copy root .env-example to root .env
  { source: path.join(rootDir, '.env-example'), dest: path.join(rootDir, '.env') },
];

envFiles.forEach(({ source, dest }) => {
  if (fs.existsSync(source) && !fs.existsSync(dest)) {
    fs.copyFileSync(source, dest);
    console.log(`Created ${path.relative(rootDir, dest)} from ${path.basename(source)}`);
  } else if (fs.existsSync(dest)) {
    console.log(`${path.relative(rootDir, dest)} already exists, skipping`);
  } else {
    console.log(`Warning: ${path.relative(rootDir, source)} not found, skipping`);
  }
});
