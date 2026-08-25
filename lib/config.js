// dsh-context-sniper: configuration resolution.
//
// The single user-facing knob is `keepRounds` (N): how many recent rounds to
// keep in the model context when the context overflows. Everything else is a
// sane internal default that the settings panel surfaces but the user rarely
// needs to touch.

/** Fixed marker text substituted into the model surface in place of archived rounds. */
export const ARCHIVE_MARKER_PLUGIN = 'context-sniper';

export const DEFAULTS = Object.freeze({
  /** How many recent rounds to keep in context when archiving. */
  keepRounds: 20,
  /**
   * Proactively archive at this fraction of the routed context window (before
   * the provider hard-fails). 0 disables the proactive path and leaves
   * detection to the provider's context-window overflow.
   */
  pressureRatio: 0,
  /** Max archived records returned by the recall tool for one query. */
  maxSearchHits: 8,
  /** Max characters of each archived message included in a recall hit. */
  hitMaxChars: 4000,
  /** Directory (relative to the harness home) for archive files. */
  archiveDir: 'context-sniper',
  /** When true, log every archival decision at info level. */
  verbose: false,
});

const ALLOWED_KEYS = new Set(Object.keys(DEFAULTS));

function assertInt(name, value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`context-sniper config: ${name} must be an integer in [${min}, ${max}], got ${value}`);
  }
}

/**
 * Validate and normalize the raw composition config.
 * @param config raw plugin config from the composition (cordis.yml `config:`).
 * @returns a frozen, fully-resolved config object.
 */
export function resolveConfig(config = {}) {
  for (const key of Object.keys(config)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`context-sniper: unknown config key "${key}" (allowed: ${[...ALLOWED_KEYS].join(', ')})`);
    }
  }
  const resolved = { ...DEFAULTS, ...config };
  assertInt('keepRounds', resolved.keepRounds, { min: 1, max: 100000 });
  assertInt('maxSearchHits', resolved.maxSearchHits, { min: 1, max: 1000 });
  assertInt('hitMaxChars', resolved.hitMaxChars, { min: 1, max: 1000000 });
  if (!(resolved.pressureRatio >= 0 && resolved.pressureRatio < 1)) {
    throw new Error(`context-sniper config: pressureRatio must be in [0, 1), got ${resolved.pressureRatio}`);
  }
  if (typeof resolved.archiveDir !== 'string' || resolved.archiveDir.length === 0) {
    throw new Error('context-sniper config: archiveDir must be a non-empty string');
  }
  return Object.freeze(resolved);
}
