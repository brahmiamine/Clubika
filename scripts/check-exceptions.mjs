#!/usr/bin/env node
import { loadExceptions, assertExceptionsFresh } from './audit-dependencies.mjs';

try {
  assertExceptionsFresh(loadExceptions());
  console.log('Exceptions d’audit valides (datées, pas de suppression globale).');
} catch (error) {
  console.error('[audit:exceptions]', error instanceof Error ? error.message : error);
  process.exit(1);
}
