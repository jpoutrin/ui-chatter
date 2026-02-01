// Unit tests for InputHistoryRepository
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { InputHistoryRepository } from '../src/inputHistoryRepository';
import type { InputHistoryEntry } from '../src/types';

// Mock chrome.storage.local
const mockStorage: Record<string, any> = {};

const chromeMock = {
  storage: {
    local: {
      get: jest.fn((keys: string | string[] | null) => {
        if (keys === null) {
          return Promise.resolve(mockStorage);
        }
        if (typeof keys === 'string') {
          return Promise.resolve({ [keys]: mockStorage[keys] });
        }
        const result: Record<string, any> = {};
        keys.forEach(key => {
          if (mockStorage[key] !== undefined) {
            result[key] = mockStorage[key];
          }
        });
        return Promise.resolve(result);
      }),
      set: jest.fn((items: Record<string, any>) => {
        Object.assign(mockStorage, items);
        return Promise.resolve();
      }),
      remove: jest.fn((keys: string | string[]) => {
        const keysArray = Array.isArray(keys) ? keys : [keys];
        keysArray.forEach(key => delete mockStorage[key]);
        return Promise.resolve();
      })
    }
  }
};

// Setup global chrome mock
(global as any).chrome = chromeMock;

describe('InputHistoryRepository', () => {
  let repository: InputHistoryRepository;

  beforeEach(() => {
    // Clear mock storage before each test
    Object.keys(mockStorage).forEach(key => delete mockStorage[key]);
    jest.clearAllMocks();

    // Create fresh repository instance
    repository = new InputHistoryRepository(50);
  });

  describe('save and load', () => {
    test('should save and load history entries', async () => {
      const tabId = 1;
      const entries: InputHistoryEntry[] = [
        { message: 'First message', timestamp: Date.now() },
        { message: 'Second message', timestamp: Date.now() - 1000 }
      ];

      await repository.save(tabId, entries);
      const loaded = await repository.load(tabId);

      expect(loaded).toEqual(entries);
      expect(loaded).toHaveLength(2);
    });

    test('should return empty array when no history exists', async () => {
      const tabId = 999;
      const loaded = await repository.load(tabId);

      expect(loaded).toEqual([]);
    });

    test('should throw error when saving with invalid tab ID', async () => {
      await expect(repository.save(0, [])).rejects.toThrow('Tab ID is required');
    });

    test('should throw error when loading with invalid tab ID', async () => {
      await expect(repository.load(0)).rejects.toThrow('Tab ID is required');
    });
  });

  describe('max size enforcement', () => {
    test('should enforce max size when saving', async () => {
      const repo = new InputHistoryRepository(5);
      const tabId = 1;

      // Create 10 entries
      const entries: InputHistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
        message: `Message ${i}`,
        timestamp: Date.now() - i * 1000
      }));

      await repo.save(tabId, entries);
      const loaded = await repo.load(tabId);

      expect(loaded).toHaveLength(5);
      expect(loaded[0].message).toBe('Message 0');
      expect(loaded[4].message).toBe('Message 4');
    });
  });

  describe('addEntry', () => {
    test('should add a new entry to empty history', async () => {
      const tabId = 1;
      const message = 'Test message';

      await repository.addEntry(tabId, message);
      const loaded = await repository.load(tabId);

      expect(loaded).toHaveLength(1);
      expect(loaded[0].message).toBe(message);
      expect(loaded[0].timestamp).toBeGreaterThan(0);
    });

    test('should prepend new entry (newest first)', async () => {
      const tabId = 1;

      await repository.addEntry(tabId, 'First');
      await repository.addEntry(tabId, 'Second');
      await repository.addEntry(tabId, 'Third');

      const loaded = await repository.load(tabId);

      expect(loaded).toHaveLength(3);
      expect(loaded[0].message).toBe('Third');
      expect(loaded[1].message).toBe('Second');
      expect(loaded[2].message).toBe('First');
    });

    test('should deduplicate consecutive messages by default', async () => {
      const tabId = 1;

      await repository.addEntry(tabId, 'Same message');
      await repository.addEntry(tabId, 'Same message');

      const loaded = await repository.load(tabId);

      expect(loaded).toHaveLength(1);
      expect(loaded[0].message).toBe('Same message');
    });

    test('should not deduplicate non-consecutive duplicates', async () => {
      const tabId = 1;

      await repository.addEntry(tabId, 'Message A');
      await repository.addEntry(tabId, 'Message B');
      await repository.addEntry(tabId, 'Message A');

      const loaded = await repository.load(tabId);

      expect(loaded).toHaveLength(3);
      expect(loaded[0].message).toBe('Message A');
      expect(loaded[1].message).toBe('Message B');
      expect(loaded[2].message).toBe('Message A');
    });

    test('should allow duplicates when deduplication is disabled', async () => {
      const tabId = 1;

      await repository.addEntry(tabId, 'Same message', false);
      await repository.addEntry(tabId, 'Same message', false);

      const loaded = await repository.load(tabId);

      expect(loaded).toHaveLength(2);
    });

    test('should throw error for empty message', async () => {
      await expect(repository.addEntry(1, '')).rejects.toThrow('Message cannot be empty');
      await expect(repository.addEntry(1, '   ')).rejects.toThrow('Message cannot be empty');
    });
  });

  describe('delete', () => {
    test('should delete history for a specific tab', async () => {
      const tabId = 1;
      const entries: InputHistoryEntry[] = [
        { message: 'Test', timestamp: Date.now() }
      ];

      await repository.save(tabId, entries);
      expect(await repository.load(tabId)).toHaveLength(1);

      await repository.delete(tabId);
      expect(await repository.load(tabId)).toHaveLength(0);
    });

    test('should throw error when deleting with invalid tab ID', async () => {
      await expect(repository.delete(0)).rejects.toThrow('Tab ID is required');
    });
  });

  describe('clear', () => {
    test('should clear all history for all tabs', async () => {
      await repository.addEntry(1, 'Tab 1 message');
      await repository.addEntry(2, 'Tab 2 message');
      await repository.addEntry(3, 'Tab 3 message');

      await repository.clear();

      expect(await repository.load(1)).toHaveLength(0);
      expect(await repository.load(2)).toHaveLength(0);
      expect(await repository.load(3)).toHaveLength(0);
    });

    test('should not affect non-history storage keys', async () => {
      // Add some non-history data
      await chrome.storage.local.set({ 'some_other_key': 'value' });

      await repository.addEntry(1, 'Message');
      await repository.clear();

      const result = await chrome.storage.local.get('some_other_key');
      expect(result.some_other_key).toBe('value');
    });
  });

  describe('getAllTabIds', () => {
    test('should return all tab IDs with history', async () => {
      await repository.addEntry(1, 'Tab 1');
      await repository.addEntry(5, 'Tab 5');
      await repository.addEntry(10, 'Tab 10');

      const tabIds = await repository.getAllTabIds();

      expect(tabIds).toContain(1);
      expect(tabIds).toContain(5);
      expect(tabIds).toContain(10);
      expect(tabIds).toHaveLength(3);
    });

    test('should return empty array when no history exists', async () => {
      const tabIds = await repository.getAllTabIds();
      expect(tabIds).toEqual([]);
    });

    test('should not include non-history storage keys', async () => {
      await chrome.storage.local.set({ 'other_key': 'value' });
      await repository.addEntry(1, 'Message');

      const tabIds = await repository.getAllTabIds();

      expect(tabIds).toEqual([1]);
    });
  });

  describe('per-tab isolation', () => {
    test('should keep histories isolated between tabs', async () => {
      await repository.addEntry(1, 'Tab 1 message');
      await repository.addEntry(2, 'Tab 2 message');

      const tab1History = await repository.load(1);
      const tab2History = await repository.load(2);

      expect(tab1History).toHaveLength(1);
      expect(tab2History).toHaveLength(1);
      expect(tab1History[0].message).toBe('Tab 1 message');
      expect(tab2History[0].message).toBe('Tab 2 message');
    });
  });

  describe('timestamp handling', () => {
    test('should store timestamp with each entry', async () => {
      const before = Date.now();
      await repository.addEntry(1, 'Test');
      const after = Date.now();

      const loaded = await repository.load(1);

      expect(loaded[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(loaded[0].timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('storage metadata', () => {
    test('should store savedAt timestamp', async () => {
      const tabId = 1;
      const entries: InputHistoryEntry[] = [
        { message: 'Test', timestamp: Date.now() }
      ];

      const before = Date.now();
      await repository.save(tabId, entries);
      const after = Date.now();

      const storageKey = `input_history_${tabId}`;
      const result = await chrome.storage.local.get(storageKey);

      expect(result[storageKey].savedAt).toBeGreaterThanOrEqual(before);
      expect(result[storageKey].savedAt).toBeLessThanOrEqual(after);
    });
  });
});
