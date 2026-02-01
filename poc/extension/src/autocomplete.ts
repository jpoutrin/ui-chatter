// Command Autocomplete Controller for slash command suggestions

/**
 * Command Autocomplete Controller
 *
 * Provides autocomplete suggestions for slash commands:
 * - Detects "/" prefix in input
 * - Fetches matching commands from API
 * - Supports keyboard navigation (arrows, tab, enter, escape)
 * - Positioned above input field
 */
export const AutocompleteController = {
  dropdown: null as HTMLElement | null,
  listElement: null as HTMLElement | null,
  inputElement: null as HTMLTextAreaElement | null,
  selectedIndex: -1,
  suggestions: [] as Array<{ command: string; description?: string }>,
  currentPrefix: '',
  isVisible: false,
  abortController: null as AbortController | null,
  // Callback to get current session ID
  getCurrentSessionId: null as (() => string | null) | null,

  init(messageInput: HTMLTextAreaElement | null, getCurrentSessionId: () => string | null) {
    this.getCurrentSessionId = getCurrentSessionId;
    this.dropdown = document.getElementById('autocompleteDropdown');
    this.listElement = document.getElementById('autocompleteList');
    this.inputElement = messageInput;

    if (!this.dropdown || !this.listElement || !this.inputElement) {
      // console.error('[AUTOCOMPLETE] Required DOM elements not found');
      return;
    }

    this.inputElement.addEventListener('input', (e) => this.handleInput(e));
    this.inputElement.addEventListener('keydown', (e) => this.handleKeydown(e));

    document.addEventListener('click', (e) => {
      if (this.dropdown && !this.dropdown.contains(e.target as Node) && e.target !== this.inputElement) {
        this.hide();
      }
    });

    this.inputElement.addEventListener('blur', (e) => {
      setTimeout(() => {
        if (this.dropdown && !this.dropdown.contains(document.activeElement)) {
          this.hide();
        }
      }, 150);
    });

    // console.log('[AUTOCOMPLETE] Controller initialized');
  },

  async handleInput(e: Event) {
    const target = e.target as HTMLTextAreaElement;
    const input = target.value;
    const cursorPos = target.selectionStart;
    const textBeforeCursor = input.substring(0, cursorPos);
    // Match slash commands including colons, hyphens, and underscores
    // Examples: /commit, /my-plugin:command, /product-design:parallel-run
    // Use \- to escape hyphen for safety
    const slashMatch = textBeforeCursor.match(/\/([\w:\-]*)$/);

    // console.log('[AUTOCOMPLETE] Input event:', { input, cursorPos, textBeforeCursor, slashMatch });

    if (slashMatch) {
      const prefix = '/' + slashMatch[1];
      // console.log('[AUTOCOMPLETE] Slash detected, prefix:', prefix);
      if (prefix !== this.currentPrefix) {
        this.currentPrefix = prefix;
        await this.fetchSuggestions(prefix);
      }
    } else {
      this.hide();
    }
  },

  async fetchSuggestions(prefix: string) {
    // console.log('[AUTOCOMPLETE] fetchSuggestions called with prefix:', prefix);

    const currentSessionId = this.getCurrentSessionId?.();
    // console.log('[AUTOCOMPLETE] currentSessionId:', currentSessionId);

    if (!currentSessionId) {
      // console.warn('[AUTOCOMPLETE] No active session - showing waiting message');
      this.suggestions = [];
      this.showWaitingMessage();
      return;
    }

    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    try {
      const url = `http://localhost:3456/api/v1/projects/${currentSessionId}/commands?mode=agent&prefix=${encodeURIComponent(prefix)}&limit=20`;
      // console.log('[AUTOCOMPLETE] Fetching from:', url);
      const response = await fetch(url, { signal: this.abortController.signal });

      // console.log('[AUTOCOMPLETE] Response status:', response.status);

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      // console.log('[AUTOCOMPLETE] Received data:', data);
      this.suggestions = data.commands || [];
      // console.log('[AUTOCOMPLETE] Suggestions:', this.suggestions);
      this.render();

    } catch (error: any) {
      if (error.name === 'AbortError') return;
      // console.error('[AUTOCOMPLETE] Failed to fetch:', error);
      this.hide();
    }
  },

  render() {
    if (!this.listElement) return;

    // console.log('[AUTOCOMPLETE] render() called, suggestions count:', this.suggestions.length);
    this.listElement.innerHTML = '';

    if (this.suggestions.length === 0) {
      this.listElement.innerHTML = '<div class="autocomplete-empty">No matching commands found</div>';
      this.show();
      return;
    }

    this.suggestions.forEach((cmd, index) => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.dataset.index = String(index);

      const nameEl = document.createElement('div');
      nameEl.className = 'command-name';
      nameEl.textContent = cmd.command;
      item.appendChild(nameEl);

      if (cmd.description) {
        const descEl = document.createElement('div');
        descEl.className = 'command-description';
        descEl.textContent = cmd.description;
        item.appendChild(descEl);
      }

      item.addEventListener('click', () => this.selectSuggestion(index));
      this.listElement!.appendChild(item);
    });

    this.selectedIndex = -1;
    this.show();
  },

  handleKeydown(e: KeyboardEvent) {
    if (!this.isVisible) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.moveSelection(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.moveSelection(-1);
        break;
      case 'Enter':
        if (this.selectedIndex >= 0) {
          e.preventDefault();
          this.selectSuggestion(this.selectedIndex);
        }
        break;
      case 'Tab':
        if (this.selectedIndex >= 0) {
          e.preventDefault();
          this.selectSuggestion(this.selectedIndex);
        } else if (this.suggestions.length > 0) {
          e.preventDefault();
          this.selectSuggestion(0);
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.hide();
        break;
    }
  },

  moveSelection(delta: number) {
    if (!this.listElement) return;

    const items = this.listElement.querySelectorAll('.autocomplete-item');
    if (items.length === 0) return;

    if (this.selectedIndex >= 0 && this.selectedIndex < items.length) {
      items[this.selectedIndex].classList.remove('selected');
    }

    this.selectedIndex += delta;

    if (this.selectedIndex < 0) {
      this.selectedIndex = items.length - 1;
    } else if (this.selectedIndex >= items.length) {
      this.selectedIndex = 0;
    }

    items[this.selectedIndex].classList.add('selected');
    items[this.selectedIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },

  selectSuggestion(index: number) {
    if (index < 0 || index >= this.suggestions.length) return;
    if (!this.inputElement) return;

    const selected = this.suggestions[index];
    const input = this.inputElement;
    const currentValue = input.value;
    const cursorPos = input.selectionStart || 0;
    const beforeCursor = currentValue.substring(0, cursorPos);
    const afterCursor = currentValue.substring(cursorPos);
    // Match same pattern as handleInput - including colons and hyphens
    const slashMatch = beforeCursor.match(/\/([\w:\-]*)$/);

    if (!slashMatch) return;

    const startPos = cursorPos - slashMatch[0].length;
    const newValue = currentValue.substring(0, startPos) + selected.command + ' ' + afterCursor;

    input.value = newValue;
    const newCursorPos = startPos + selected.command.length + 1;
    input.setSelectionRange(newCursorPos, newCursorPos);

    this.hide();
    input.focus();

    // console.log('[AUTOCOMPLETE] Inserted:', selected.command);
  },

  showWaitingMessage() {
    if (!this.listElement) return;

    this.listElement.innerHTML = '<div class="autocomplete-empty">Connecting to session... Please wait.</div>';
    this.show();
  },

  show() {
    if (!this.dropdown || !this.inputElement) return;

    // console.log('[AUTOCOMPLETE] show() called');
    const inputRect = this.inputElement.getBoundingClientRect();
    // console.log('[AUTOCOMPLETE] Input rect:', inputRect);

    // Position above the input box
    const dropdownHeight = Math.min(400, this.suggestions.length * 60); // Estimate height
    this.dropdown.style.bottom = `${window.innerHeight - inputRect.top + 4}px`;
    this.dropdown.style.top = 'auto';
    this.dropdown.style.left = `${inputRect.left}px`;
    this.dropdown.style.width = `${Math.max(inputRect.width, 300)}px`;
    this.dropdown.style.display = 'block';

    // console.log('[AUTOCOMPLETE] Dropdown positioned above input');
    this.isVisible = true;
  },

  hide() {
    if (!this.dropdown) return;

    this.dropdown.style.display = 'none';
    this.suggestions = [];
    this.selectedIndex = -1;
    this.currentPrefix = '';
    this.isVisible = false;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
};
