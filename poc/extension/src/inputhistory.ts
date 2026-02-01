// Input History Controller for managing per-tab input history with arrow key navigation and fuzzy search

import { InputHistoryRepository } from './inputHistoryRepository.js';
import type { InputHistoryEntry } from './types.js';

/**
 * Input History Controller
 *
 * Manages per-tab input history with:
 * - Arrow Up/Down navigation through previous messages
 * - Ctrl+R fuzzy search modal
 * - Per-tab isolation
 * - Persistence via InputHistoryRepository
 */
export const InputHistoryController = {
  // In-memory storage for per-tab histories (navigation state only)
  histories: {} as Record<number, { entries: InputHistoryEntry[], currentPosition: number, draftMessage: string }>,
  repository: new InputHistoryRepository(50),
  modal: null as HTMLElement | null,
  searchInput: null as HTMLInputElement | null,
  resultsContainer: null as HTMLElement | null,
  closeBtn: null as HTMLButtonElement | null,
  selectedIndex: -1,
  filteredResults: [] as Array<{ message: string; timestamp: number }>,
  fuse: null as any,
  // Callbacks to get current state from sidepanel
  getCurrentTabId: null as (() => number | null) | null,
  getMessageInput: null as (() => HTMLTextAreaElement | null) | null,

  init(getCurrentTabId: () => number | null, getMessageInput: () => HTMLTextAreaElement | null) {
    this.getCurrentTabId = getCurrentTabId;
    this.getMessageInput = getMessageInput;

    this.modal = document.getElementById('historyModal');
    this.searchInput = document.getElementById('historySearchInput') as HTMLInputElement;
    this.resultsContainer = document.getElementById('historyResults');
    this.closeBtn = this.modal?.querySelector('.history-close-btn') as HTMLButtonElement;

    if (!this.modal || !this.searchInput || !this.resultsContainer || !this.closeBtn) {
      console.error('[INPUT HISTORY] Required DOM elements not found');
      return;
    }

    // Close button handler
    this.closeBtn.addEventListener('click', () => this.closeModal());

    // Search input handler
    this.searchInput.addEventListener('input', (e) => this.performSearch());

    // Keyboard navigation in search
    this.searchInput.addEventListener('keydown', (e) => this.handleSearchKeydown(e));

    // Close on overlay click
    const overlay = this.modal.querySelector('.history-overlay');
    overlay?.addEventListener('click', () => this.closeModal());

    console.log('[INPUT HISTORY] Controller initialized');
  },

  // Get or create history for current tab
  getHistory(tabId: number) {
    if (!this.histories[tabId]) {
      this.histories[tabId] = {
        entries: [],
        currentPosition: -1,
        draftMessage: ''
      };
    }
    return this.histories[tabId];
  },

  // Add message to history
  async addToHistory(tabId: number, message: string) {
    if (!tabId || !message || message.trim() === '') return;

    // Use repository to add entry (handles deduplication and persistence)
    await this.repository.addEntry(tabId, message, true);

    // Reload history into memory
    const history = this.getHistory(tabId);
    history.entries = await this.repository.load(tabId);

    // Reset navigation state
    history.currentPosition = -1;
    history.draftMessage = '';

    console.log(`[INPUT HISTORY] Added to history for tab ${tabId}:`, message.substring(0, 50));
  },

  // Load history from repository
  async loadHistory(tabId: number) {
    if (!tabId) return;

    try {
      const entries = await this.repository.load(tabId);
      this.histories[tabId] = {
        entries,
        currentPosition: -1,
        draftMessage: ''
      };
      console.log(`[INPUT HISTORY] Loaded ${entries.length} entries for tab ${tabId}`);
    } catch (error) {
      console.error('[INPUT HISTORY] Failed to load history:', error);
    }
  },

  // Handle arrow key navigation
  handleArrowNavigation(direction: 'up' | 'down') {
    const currentTabId = this.getCurrentTabId?.();
    const messageInput = this.getMessageInput?.();

    if (!currentTabId || !messageInput) return;

    const history = this.getHistory(currentTabId);

    if (history.entries.length === 0) {
      return; // No history to navigate
    }

    // Save draft message when entering navigation mode
    if (history.currentPosition === -1 && direction === 'up') {
      history.draftMessage = messageInput.value;
    }

    // Navigate
    if (direction === 'up') {
      // Go to older messages
      if (history.currentPosition < history.entries.length - 1) {
        history.currentPosition++;
      }
    } else {
      // Go to newer messages
      if (history.currentPosition > -1) {
        history.currentPosition--;
      }
    }

    // Update input
    if (history.currentPosition === -1) {
      // Restore draft
      messageInput.value = history.draftMessage;
    } else {
      // Show history entry
      messageInput.value = history.entries[history.currentPosition].message;
    }

    console.log(`[INPUT HISTORY] Navigated ${direction}, position: ${history.currentPosition}`);
  },

  // Exit navigation mode (user started typing)
  exitNavigationMode() {
    const currentTabId = this.getCurrentTabId?.();
    if (!currentTabId) return;

    const history = this.getHistory(currentTabId);
    if (history.currentPosition !== -1) {
      history.currentPosition = -1;
      history.draftMessage = '';
      console.log('[INPUT HISTORY] Exited navigation mode');
    }
  },

  // Open fuzzy search modal
  openSearchModal() {
    const currentTabId = this.getCurrentTabId?.();
    const messageInput = this.getMessageInput?.();

    if (!currentTabId || !this.modal || !this.searchInput || !this.resultsContainer) return;

    // Don't open if input is disabled (streaming)
    if (messageInput?.disabled) return;

    const history = this.getHistory(currentTabId);

    // Initialize Fuse.js
    if (typeof (window as any).Fuse !== 'undefined') {
      this.fuse = new (window as any).Fuse(history.entries, {
        keys: ['message'],
        threshold: 0.3,
        includeMatches: true,
        shouldSort: true
      });
    } else {
      console.error('[INPUT HISTORY] Fuse.js not loaded');
      return;
    }

    // Reset search
    this.searchInput.value = '';
    this.selectedIndex = -1;
    this.filteredResults = [...history.entries];

    // Render all history (newest first)
    this.renderResults();

    // Show modal
    this.modal.style.display = 'block';

    // Focus search input
    setTimeout(() => this.searchInput?.focus(), 10);

    console.log('[INPUT HISTORY] Opened search modal');
  },

  // Close modal
  closeModal() {
    if (!this.modal) return;

    this.modal.style.display = 'none';
    this.fuse = null;
    this.selectedIndex = -1;
    this.filteredResults = [];

    // Return focus to message input
    const messageInput = this.getMessageInput?.();
    messageInput?.focus();

    console.log('[INPUT HISTORY] Closed search modal');
  },

  // Perform fuzzy search
  performSearch() {
    const currentTabId = this.getCurrentTabId?.();
    if (!currentTabId || !this.searchInput) return;

    const query = this.searchInput.value.trim();
    const history = this.getHistory(currentTabId);

    if (query === '') {
      // Show all history (newest first)
      this.filteredResults = [...history.entries];
    } else if (this.fuse) {
      // Fuzzy search
      const results = this.fuse.search(query);
      this.filteredResults = results.map((r: any) => r.item);
    } else {
      this.filteredResults = [];
    }

    this.selectedIndex = -1;
    this.renderResults();
  },

  // Render search results
  renderResults() {
    if (!this.resultsContainer) return;

    this.resultsContainer.innerHTML = '';

    if (this.filteredResults.length === 0) {
      this.resultsContainer.innerHTML = '<div class="history-empty">No matching history found</div>';
      return;
    }

    this.filteredResults.forEach((entry, index) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.dataset.index = String(index);

      const messageEl = document.createElement('div');
      messageEl.className = 'history-item-message';
      messageEl.textContent = entry.message;

      const timestampEl = document.createElement('div');
      timestampEl.className = 'history-item-timestamp';
      timestampEl.textContent = this.formatTimestamp(entry.timestamp);

      item.appendChild(messageEl);
      item.appendChild(timestampEl);

      item.addEventListener('click', () => this.selectResult(index));

      this.resultsContainer.appendChild(item);
    });
  },

  // Handle keyboard navigation in search modal
  handleSearchKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.moveResultSelection(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.moveResultSelection(-1);
        break;
      case 'Enter':
        e.preventDefault();
        if (this.selectedIndex >= 0) {
          this.selectResult(this.selectedIndex);
        } else if (this.filteredResults.length > 0) {
          this.selectResult(0);
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.closeModal();
        break;
    }
  },

  // Move selection in results
  moveResultSelection(delta: number) {
    if (!this.resultsContainer) return;

    const items = this.resultsContainer.querySelectorAll('.history-item');
    if (items.length === 0) return;

    // Remove current selection
    if (this.selectedIndex >= 0 && this.selectedIndex < items.length) {
      items[this.selectedIndex].classList.remove('selected');
    }

    // Update index
    this.selectedIndex += delta;

    if (this.selectedIndex < 0) {
      this.selectedIndex = items.length - 1;
    } else if (this.selectedIndex >= items.length) {
      this.selectedIndex = 0;
    }

    // Add selection
    items[this.selectedIndex].classList.add('selected');
    items[this.selectedIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },

  // Select a result
  selectResult(index: number) {
    if (index < 0 || index >= this.filteredResults.length) return;

    const selected = this.filteredResults[index];
    const messageInput = this.getMessageInput?.();

    // Fill input with selected message
    if (messageInput) {
      messageInput.value = selected.message;
    }

    // Close modal
    this.closeModal();

    console.log('[INPUT HISTORY] Selected:', selected.message.substring(0, 50));
  },

  // Format timestamp as relative time
  formatTimestamp(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) {
      return 'Just now';
    } else if (minutes < 60) {
      return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    } else if (hours < 24) {
      return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    } else if (days === 1) {
      return 'Yesterday';
    } else if (days < 7) {
      return `${days} days ago`;
    } else {
      return new Date(timestamp).toLocaleDateString();
    }
  }
};
