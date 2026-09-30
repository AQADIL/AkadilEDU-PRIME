const { createBot } = require('./index');

createBot().start().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
