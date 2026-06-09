import { EventEmitter } from 'events';
import type { BoardEvent } from './types.js';

export class EventBus {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
  }

  emit(event: BoardEvent): void {
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
