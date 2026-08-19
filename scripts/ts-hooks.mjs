// Registers sync module hooks so plain `node scripts/*.mjs` can import the
// extensionless TypeScript modules under src/lib/server (Node 26 strips types,
// but won't guess the .ts extension on its own).
// Also maps the `@/` tsconfig alias to <root>/src/ so route handlers under
// src/app/api can be exercised directly in tests.
import { registerHooks } from 'node:module';

const srcRoot = new URL('../src/', import.meta.url);

export function registerTsHooks() {
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('@/')) {
        const rel = specifier.slice(2);
        if (/\.[a-z0-9]+$/i.test(rel)) return next(new URL(rel, srcRoot).href, context);
        try {
          return next(new URL(`${rel}.ts`, srcRoot).href, context);
        } catch {
          return next(new URL(`${rel}.tsx`, srcRoot).href, context);
        }
      }
      try {
        return next(specifier, context);
      } catch (error) {
        if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z0-9]+$/i.test(specifier)) {
          return next(`${specifier}.ts`, context);
        }
        throw error;
      }
    },
  });
}
