// Registers sync module hooks so plain `node scripts/*.mjs` can import the
// extensionless TypeScript modules under src/lib/server (Node 26 strips types,
// but won't guess the .ts extension on its own).
import { registerHooks } from 'node:module';

export function registerTsHooks() {
  registerHooks({
    resolve(specifier, context, next) {
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
