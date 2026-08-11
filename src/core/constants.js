// Core domain constants for SpecFlow.

export const SPEC_STATUSES = [
  'backlog',     // defined, not scheduled
  'in_progress', // an agent job is actively working it
  'review',      // implementation pushed, waiting for human review
  'done',        // accepted & merged
] ;

export const JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] ;

export const FEATURE_TYPES = ['feature', 'bugfix', 'chore', 'refactor'] ;

// Channel identifiers supported by the comms layer
export const CHANNEL_TYPES = ['whatsapp', 'rest', 'cli', 'web', 'slack', 'telegram'] ;