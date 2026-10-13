// Does rc.1 schemastery wrap .volatile() fields into Volatile refs when
// compiling a config object? If NOT, rawConfig.surfaceTokenBudget.get()
// throws at use time and trimming silently dies.
import z from '@deepseek-ai/schemastery';

const Config = z.object({
  surfaceTokenBudget: z.number().step(1).min(1024).max(1048576).default(32768).volatile(),
  pressureRatio: z.number().min(0).max(0.999).default(0),
});

// schemastery compiles defaults when called with no input:
const compiled = Config();
console.log('typeof surfaceTokenBudget:', typeof compiled.surfaceTokenBudget);
console.log('has .get:', typeof compiled.surfaceTokenBudget?.get === 'function');
console.log('VOLATILE_WRITE in obj:', Symbol.for('cosmokit.volatile.write') in Object(compiled.surfaceTokenBudget));
console.log('value:', String(compiled.surfaceTokenBudget));
try {
  console.log('get():', compiled.surfaceTokenBudget.get());
} catch (e) {
  console.log('get() throws:', String(e));
}
const withInput = Config({ surfaceTokenBudget: 40000 });
console.log('input value:', String(withInput.surfaceTokenBudget), 'get:', typeof withInput.surfaceTokenBudget?.get === 'function' ? withInput.surfaceTokenBudget.get() : '(no get)');
