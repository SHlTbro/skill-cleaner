// Pure gate: unit tests can verify refusal without invoking a real write command.
export function assertProductionAuthorization({ record, authorization, executionAuthorized }) {
  if (!executionAuthorized) throw new Error('AUTHORIZATION_REQUIRED');
  if (!record.probe && (!authorization?.owner_authorized || authorization.consumed_by
    || authorization.before_state_hash !== record.before.state_hash
    || authorization.target !== record.target)) throw new Error('EXACT_PRODUCTION_AUTHORIZATION_REQUIRED');
}
