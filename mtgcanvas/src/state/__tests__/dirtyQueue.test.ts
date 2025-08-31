import { describe, it, expect, vi } from 'vitest';
import * as repo from '../../data/repositories';
import { markDirtyPosition, flushNow, resetDirtyQueue } from '../dirtyQueue';

describe('dirtyQueue', () => {
  it('batches updates and is robust to repo errors', () => {
    resetDirtyQueue();
    const spy = vi.spyOn(repo.InstancesRepo, 'updatePositions').mockImplementation(() => { throw new Error('fail'); });
    // should not throw
    markDirtyPosition(1, 10, 20);
    markDirtyPosition(2, 30, 40);
    flushNow();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockReset();
    // success path
    const spy2 = vi.spyOn(repo.InstancesRepo, 'updatePositions').mockImplementation(() => {});
    markDirtyPosition(3, 50, 60);
    flushNow();
    expect(spy2).toHaveBeenCalledWith([{ id: 3, x: 50, y: 60 }]);
    spy2.mockRestore();
  });
});
