import { EventEmitter } from 'events';
import type { BoardEvent } from './types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('events');

export class EventBus {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
  }

  emit(event: BoardEvent): void {
    logger.debug('bus emit', { type: event.type, projectId: event.projectId, entityId: event.entityId });
    this.emitter.emit('board', event);
  }

  subscribe(listener: (event: BoardEvent) => void): () => void {
    this.emitter.on('board', listener);
    return () => {
      this.emitter.off('board', listener);
    };
  }
}

export const eventBus: EventBus = new EventBus();
