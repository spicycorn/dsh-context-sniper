// dsh-context-sniper: shared RPC channel + endpoint names (client ⇄ host).
// Kept separate so both halves import the same constants without a cycle.
export const CONTEXT_SNIPER_RPC_CHANNEL = '/context-sniper';
export const CONTEXT_SNIPER_ENDPOINTS = Object.freeze({
  getState: 'get-state',
  setBudget: 'set-budget',
  sessionState: 'session-state',
});
