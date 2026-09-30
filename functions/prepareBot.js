const fs = require('node:fs');
const path = require('node:path');

const source = path.resolve(__dirname, '..', 'bot');
const destination = path.resolve(__dirname, 'bot');
const relativeDestination = path.relative(__dirname, destination);

if (relativeDestination.startsWith('..') || path.isAbsolute(relativeDestination)) {
  throw new Error('Bot package destination must stay inside functions');
}
if (!fs.existsSync(path.join(source, 'index.js'))) {
  throw new Error('Bot source is missing');
}

fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(source, destination, {
  recursive: true,
  filter: (entry) => {
    if (fs.lstatSync(entry).isSymbolicLink()) {
      return false;
    }
    const relative = path.relative(source, entry);
    if (!relative) {
      return true;
    }
    const parts = relative.split(path.sep);
    return !parts.some((part) => part === 'node_modules' || part === '.env' || part === '.git')
      && !relative.endsWith('package-lock.json');
  }
});
