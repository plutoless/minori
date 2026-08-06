import { createApp } from './app.js';
import { loadConfig } from './runtime/config.js';
import { createLogger } from './runtime/logger.js';

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const app = createApp(config, logger);
let stopping = false;

async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutdown requested');

  try {
    await app.stop();
  } catch {
    logger.error({ errorCode: 'shutdown_failed' }, 'shutdown failed');
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.start();
} catch {
  logger.fatal({ errorCode: 'startup_failed' }, 'startup failed');
  process.exitCode = 1;
}
