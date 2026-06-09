import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../events/bus.js';
import type { BoardEvent } from '../events/types.js';

const sampleEvent: BoardEvent = {
  type: 'item.created',
  projectId: 'proj_1',
  entityId: 'item_1',
  data: {
    item: {
      id: 'item_1',
      project_id: 'proj_1',
      title: 'Test item',
      type: 'task',
    },
  },
};

describe('EventBus', () => {
  it('emit calls a subscribed listener with the event', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.subscribe(listener);
    bus.emit(sampleEvent);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(sampleEvent);
  });

  it('emit calls multiple subscribers', () => {
    const bus = new EventBus();
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    bus.subscribe(listener1);
    bus.subscribe(listener2);
    bus.emit(sampleEvent);
    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
  });

  it('unsubscribe stops delivery', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    unsubscribe();
    bus.emit(sampleEvent);
    expect(listener).not.toHaveBeenCalled();
  });

  it('emitting with no subscribers does not throw', () => {
    const bus = new EventBus();
    expect(() => bus.emit(sampleEvent)).not.toThrow();
  });

  it('emits correct payload for item.created shape', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.subscribe(listener);

    const event: BoardEvent = {
      type: 'item.created',
      projectId: 'proj_abc',
      entityId: 'item_xyz',
      data: {
        item: { id: 'item_xyz', title: 'My task', type: 'task', project_id: 'proj_abc' },
      },
    };

    bus.emit(event);

    expect(listener).toHaveBeenCalledOnce();
    const received = listener.mock.calls[0][0] as BoardEvent;
    expect(received.type).toBe('item.created');
    expect(received.data.item).toBeDefined();
  });
});
