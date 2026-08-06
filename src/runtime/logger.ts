import pino, { type DestinationStream, type Logger } from 'pino';
import type { AppConfig } from './config.js';

const sensitiveKeys = new Set([
  'apikey',
  'appsecret',
  'authorization',
  'authorizationurl',
  'clientsecret',
  'cookie',
  'credentials',
  'databaseurl',
  'feishuappsecret',
  'openaiapikey',
  'password',
  'refreshtoken',
  'setcookie',
  'token',
  'accesstoken',
]);

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sanitizeLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    const code = 'code' in value && typeof value.code === 'string' ? value.code : undefined;
    return code ? { name: value.name, errorCode: code } : { name: value.name };
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, seen));
  }

  return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [
    key,
    sensitiveKeys.has(normalizeKey(key))
      ? '[Redacted]'
      : sanitizeLogValue(nestedValue, seen),
  ]));
}

const redactPaths = [
  'appSecret', '*.appSecret',
  'token', '*.token',
  'authorization', '*.authorization',
  'databaseUrl', '*.databaseUrl',
  'authorizationUrl', '*.authorizationUrl',
];

export function createLogger(level: AppConfig['logLevel'], destination?: DestinationStream): Logger {
  return pino({
    level,
    redact: { paths: redactPaths, censor: '[Redacted]' },
    formatters: {
      log(object) {
        return sanitizeLogValue(object) as Record<string, unknown>;
      },
    },
  }, destination);
}
