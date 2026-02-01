/**
 * PermissionModeController
 *
 * Centralized controller for managing permission modes (Plan, Fast, Balanced).
 * Handles mode initialization, switching, icon updates, and persistence.
 */

import type { PermissionMode } from './types.js';

export interface ModeConfig {
  icon: string;
  label: string;
  colorClass: string;
}

export class PermissionModeController {
  private currentMode: PermissionMode = 'plan';
  private selectElement: HTMLSelectElement | null = null;
  private iconElement: Element | null = null;

  private readonly modeConfigs: Record<PermissionMode, ModeConfig> = {
    plan: {
      icon: '⏸',
      label: 'Planning',
      colorClass: 'plan-mode'
    },
    bypassPermissions: {
      icon: '⚠',
      label: 'Fast',
      colorClass: 'fast-mode'
    },
    acceptEdits: {
      icon: '▶',
      label: 'Balanced',
      colorClass: 'balanced-mode'
    }
  };

  private readonly modes: PermissionMode[] = ['plan', 'bypassPermissions', 'acceptEdits'];

  // Callbacks for external integration
  private onModeChangeCallback: ((mode: PermissionMode) => void) | null = null;

  constructor(
    selectElementId: string,
    private addMessageFn: (type: string, message: string) => void,
    private sendRuntimeMessageFn: (message: any) => void
  ) {
    this.selectElement = document.getElementById(selectElementId) as HTMLSelectElement | null;

    if (this.selectElement) {
      // Find the icon element within the same parent container
      const container = this.selectElement.closest('.permission-mode-selector');
      this.iconElement = container?.querySelector('.mode-icon') || null;

      // Set up event listener for dropdown changes
      this.selectElement.addEventListener('change', (e) => this.handleModeChange(e));
    }
  }

  /**
   * Initialize the controller by loading the saved mode from storage
   */
  async initialize(): Promise<void> {
    console.log('[PERMISSION MODE] Initializing controller...');

    try {
      const result = await chrome.storage.local.get(['permissionMode']);
      const savedMode = result.permissionMode || 'plan';

      if (this.isValidMode(savedMode)) {
        this.currentMode = savedMode;
        this.updateUI(this.currentMode);
        console.log('[PERMISSION MODE] Loaded from storage:', this.currentMode);
      } else {
        console.warn('[PERMISSION MODE] Invalid mode in storage, using default:', savedMode);
        await this.setMode('plan');
      }
    } catch (error) {
      console.error('[PERMISSION MODE] Failed to load from storage:', error);
      this.updateUI('plan');
    }
  }

  /**
   * Set the permission mode programmatically
   */
  async setMode(mode: PermissionMode, showMessage: boolean = false): Promise<void> {
    if (!this.isValidMode(mode)) {
      console.error('[PERMISSION MODE] Invalid mode:', mode);
      return;
    }

    this.currentMode = mode;

    // Update UI
    this.updateUI(mode);

    // Save to storage
    try {
      await chrome.storage.local.set({ permissionMode: mode });
    } catch (error) {
      console.error('[PERMISSION MODE] Failed to save to storage:', error);
    }

    // Notify background script
    this.sendRuntimeMessageFn({
      type: 'permission_mode_changed',
      mode: mode
    });

    // Show user message if requested
    if (showMessage) {
      const config = this.modeConfigs[mode];
      this.addMessageFn('status', `Conversation mode changed to: ${config.label}`);
    }

    // Trigger callback
    if (this.onModeChangeCallback) {
      this.onModeChangeCallback(mode);
    }

    console.log('[PERMISSION MODE] Set to:', mode);
  }

  /**
   * Cycle to the next mode (used by keyboard shortcut)
   */
  async cycleMode(): Promise<void> {
    const currentIndex = this.modes.indexOf(this.currentMode);
    const nextIndex = (currentIndex + 1) % this.modes.length;
    const nextMode = this.modes[nextIndex];

    await this.setMode(nextMode, true);
  }

  /**
   * Get the current mode
   */
  getMode(): PermissionMode {
    return this.currentMode;
  }

  /**
   * Get the label for a specific mode
   */
  getModeLabel(mode?: PermissionMode): string {
    const targetMode = mode || this.currentMode;
    return this.modeConfigs[targetMode]?.label || targetMode;
  }

  /**
   * Set a callback to be called when mode changes
   */
  onModeChange(callback: (mode: PermissionMode) => void): void {
    this.onModeChangeCallback = callback;
  }

  /**
   * Handle auto-switch from plan to balanced mode after plan approval
   */
  async handlePlanApproval(): Promise<void> {
    if (this.currentMode === 'plan') {
      console.log('[PLAN APPROVAL] Auto-switching from plan to balanced mode');
      await this.setMode('acceptEdits', false);
      this.addMessageFn('status', '✅ Plan approved! Switched to Balanced mode for implementation.');
    }
  }

  /**
   * Private: Update the UI (select and icon) to reflect the current mode
   */
  private updateUI(mode: PermissionMode): void {
    const config = this.modeConfigs[mode];

    // Update select element
    if (this.selectElement) {
      this.selectElement.value = mode;
    }

    // Update icon element
    if (this.iconElement) {
      this.iconElement.textContent = config.icon;
      this.iconElement.className = 'mode-icon';
      this.iconElement.classList.add(config.colorClass);
    }
  }

  /**
   * Private: Handle dropdown change events
   */
  private async handleModeChange(event: Event): Promise<void> {
    const newMode = (event.target as HTMLSelectElement).value;

    if (this.isValidMode(newMode)) {
      await this.setMode(newMode, true);
    }
  }

  /**
   * Private: Type guard to check if a string is a valid PermissionMode
   */
  private isValidMode(mode: string): mode is PermissionMode {
    return this.modes.includes(mode as PermissionMode);
  }
}
