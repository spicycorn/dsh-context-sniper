// Diagnose the settings registration failure.
const z = require('@deepseek-ai/schemastery');
const { settingsNamespace } = require('@deepseek-ai/dsh-settings');

const SETTINGS_NS = settingsNamespace('dsh-context-sniper');

// Replicate the plugin's fixed schema
let schema;
try {
  schema = z.object({
    surfaceTokenBudget: z.number().step(1).min(1024).default(32768),
    maxSearchHits: z.number().step(1).min(1).max(64).default(8),
    hitMaxChars: z.number().step(1).min(200).max(20000).default(4000),
  });
  console.log('1. schema built OK');
} catch (e) {
  console.log('1. schema build FAILED:', e.constructor.name, '-', e.message);
  process.exit(1);
}

// Try resolving the base value (what register does internally)
const base = { surfaceTokenBudget: 32768, maxSearchHits: 8, hitMaxChars: 4000 };
try {
  const resolved = schema(base);
  console.log('2. resolve(base) OK ->', JSON.stringify(resolved));
} catch (e) {
  console.log('2. resolve(base) FAILED:', e.constructor.name, '-', e.message);
}

// Now test against the REAL FileSettingsProvider
const { default: FileSettingsProvider } = require('@deepseek-ai/dsh-settings-file');
console.log('3. FileSettingsProvider loaded:', typeof FileSettingsProvider);

// Minimal ctx stub to instantiate the provider
const ctx = {
  effect: (fn, label) => fn(),
  logger: { warn: (...a) => console.log('   [logger.warn]', ...a), info: (...a) => console.log('   [logger.info]', ...a), error: (...a) => console.log('   [logger.error]', ...a) },
  events: { dispatch: () => [] },
};
try {
  const provider = new FileSettingsProvider(ctx, { path: require('os').tmpdir() + '/diag-settings-' + Date.now() + '.yaml' });
  console.log('4. provider instantiated; writable =', provider.writable);
  try {
    const scope = provider.register(SETTINGS_NS, schema, { base });
    console.log('5. register OK ->', JSON.stringify(scope.get()));
  } catch (e) {
    console.log('5. register FAILED:', e.constructor.name, '-', e.message);
  }
} catch (e) {
  console.log('4. provider instantiation FAILED:', e.constructor.name, '-', e.message);
}
