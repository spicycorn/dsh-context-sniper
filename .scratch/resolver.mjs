// ESM resolve hook: map bare specifiers to the profile node_modules so the
// plugin's imports resolve without a local install.
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const req = createRequire('C:/Users/spicycorn/.dsh/profiles/web/node_modules/.resolver-anchor.js');

export async function resolve(specifier, context, next) {
  if (!specifier.startsWith('node:') && !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:')) {
    try {
      const resolved = req.resolve(specifier);
      return { url: pathToFileURL(resolved).href, shortCircuit: true };
    } catch {}
  }
  return next(specifier, context);
}
