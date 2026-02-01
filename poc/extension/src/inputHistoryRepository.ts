// Input History Repository - Storage abstraction layer
// Implements Repository pattern for persisting input history to chrome.storage.local

import type { InputHistoryEntry } from './types.js';

/**
 * Repository for managing input history storage
 *
 * Provides an abstraction layer over chrome.storage.local for storing
 * and retrieving per-tab input history.
 */
export class InputHistoryRepository {
  private readonly storageKeyPrefix = 'input_history_';
  private readonly maxSize: number;

  constructor(maxSize: number = 50) {
    this.maxSize = maxSize;
  }

  /**
   * Get storage key for a specific tab
   */
  private getStorageKey(tabId: number): string {
    return `${this.storageKeyPrefix}${tabId}`;
  }

  /**
   * Save history entries for a tab
   */
  async save(tabId: number, entries: InputHistoryEntry[]): Promise<void> {
    if (!tabId) {
      throw new Error('Tab ID is required');
    }

    // Enforce max size
    const limitedEntries = entries.slice(0, this.maxSize);

    const storageKey = this.getStorageKey(tabId);

    try {
      await chrome.storage.local.set({
        [storageKey]: {
          entries: limitedEntries,
          savedAt: Date.now()
        }
      });
      console.log(`[INPUT HISTORY REPO] Saved ${limitedEntries.length} entries for tab ${tabId}`);
    } catch (error) {
      console.error('[INPUT HISTORY REPO] Failed to save:', error);
      throw error;
    }
  }

  /**
   * Load history entries for a tab
   */
  async load(tabId: number): Promise<InputHistoryEntry[]> {
    if (!tabId) {
      throw new Error('Tab ID is required');
    }

    const storageKey = this.getStorageKey(tabId);

    try {
      const result = await chrome.storage.local.get(storageKey);
      const saved = result[storageKey];

      if (saved && Array.isArray(saved.entries)) {
        console.log(`[INPUT HISTORY REPO] Loaded ${saved.entries.length} entries for tab ${tabId}`);
        return saved.entries;
      }

      console.log(`[INPUT HISTORY REPO] No history found for tab ${tabId}`);
      return [];
    } catch (error) {
      console.error('[INPUT HISTORY REPO] Failed to load:', error);
      throw error;
    }
  }

  /**
   * Delete history for a specific tab
   */
  async delete(tabId: number): Promise<void> {
    if (!tabId) {
      throw new Error('Tab ID is required');
    }

    const storageKey = this.getStorageKey(tabId);

    try {
      await chrome.storage.local.remove(storageKey);
      console.log(`[INPUT HISTORY REPO] Deleted history for tab ${tabId}`);
    } catch (error) {
      console.error('[INPUT HISTORY REPO] Failed to delete:', error);
      throw error;
    }
  }

  /**
   * Clear all input history for all tabs
   */
  async clear(): Promise<void> {
    try {
      // Get all keys from storage
      const allKeys = await chrome.storage.local.get(null) as unknown as Record<string, any>;

      // Filter keys that match our prefix
      const historyKeys = Object.keys(allKeys).filter(key =>
        key.startsWith(this.storageKeyPrefix)
      );

      if (historyKeys.length > 0) {
        await chrome.storage.local.remove(historyKeys);
        console.log(`[INPUT HISTORY REPO] Cleared ${historyKeys.length} tab histories`);
      }
    } catch (error) {
      console.error('[INPUT HISTORY REPO] Failed to clear all:', error);
      throw error;
    }
  }

  /**
   * Get all tab IDs that have stored history
   */
  async getAllTabIds(): Promise<number[]> {
    try {
      const allKeys = await chrome.storage.local.get(null) as unknown as Record<string, any>;

      const tabIds = Object.keys(allKeys)
        .filter(key => key.startsWith(this.storageKeyPrefix))
        .map(key => parseInt(key.replace(this.storageKeyPrefix, ''), 10))
        .filter(id => !isNaN(id));

      return tabIds;
    } catch (error) {
      console.error('[INPUT HISTORY REPO] Failed to get tab IDs:', error);
      throw error;
    }
  }

  /**
   * Add a single entry to history for a tab
   * This is a convenience method that loads, prepends, and saves
   */
  async addEntry(tabId: number, message: string, deduplicateConsecutive: boolean = true): Promise<void> {
    if (!message || message.trim() === '') {
      throw new Error('Message cannot be empty');
    }

    const entries = await this.load(tabId);

    // Check for consecutive duplicate
    if (deduplicateConsecutive && entries.length > 0 && entries[0].message === message) {
      console.log('[INPUT HISTORY REPO] Skipping duplicate message');
      return;
    }

    // Prepend new entry (newest first)
    const newEntry: InputHistoryEntry = {
      message,
      timestamp: Date.now()
    };

    const updatedEntries = [newEntry, ...entries];

    // Save with max size enforcement
    await this.save(tabId, updatedEntries);
  }
}
