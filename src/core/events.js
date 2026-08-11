// Event bus used across the core so channels + UI stay in sync over SSE/WebSocket.
import { EventEmitter } from 'node:events' ;

export const bus = new EventEmitter() ;
bus.setMaxListeners(100) ;

export const EVT = {
  SPEC_UPDATED   : 'spec:updated',
  JOB_UPDATED    : 'job:updated',
  JOB_LOG        : 'job:log',
  JOB_STEP       : 'job:step',
  AGENT_UPDATED  : 'agent:updated',
  MESSAGE        : 'message:new',
  NOTIFY         : 'notify',
} ;

export function emit(event, payload) {
  bus.emit(event, payload) ;
}

export function on(event, handler) {
  bus.on(event, handler);
  // Return an unsubscribe function so clients can detach cleanly.
  return () => bus.off(event, handler);
}