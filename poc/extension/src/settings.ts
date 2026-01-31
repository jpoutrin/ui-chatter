// Settings page logic

// Type definitions
interface Settings {
  preferredEditor: EditorType;
  maxFilesDisplayed: number;
  projectPath: string;
}

type EditorType = 'vscode' | 'cursor' | 'webstorm' | 'sublime' | 'vim';

interface Elements {
  editorSelect: HTMLSelectElement;
  projectPath: HTMLInputElement;
  maxFiles: HTMLInputElement;
  saveBtn: HTMLButtonElement;
  resetBtn: HTMLButtonElement;
  successMessage: HTMLElement;
  editorInfo: HTMLElement;
}

// Helper function to get element with type assertion
function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Element with id "${id}" not found`);
  }
  return element as T;
}

// DOM elements
const elements: Elements = {
  editorSelect: getElement<HTMLSelectElement>('editorSelect'),
  projectPath: getElement<HTMLInputElement>('projectPath'),
  maxFiles: getElement<HTMLInputElement>('maxFiles'),
  saveBtn: getElement<HTMLButtonElement>('saveBtn'),
  resetBtn: getElement<HTMLButtonElement>('resetBtn'),
  successMessage: getElement<HTMLElement>('successMessage'),
  editorInfo: getElement<HTMLElement>('editorInfo'),
};

// Default settings
const DEFAULT_SETTINGS: Settings = {
  preferredEditor: 'vscode',
  maxFilesDisplayed: 5,
  projectPath: '',
};

// Editor protocol examples
const EDITOR_PROTOCOLS: Record<EditorType, string> = {
  vscode: '<strong>VS Code Protocol:</strong> <code>vscode://file/path/to/file.js:42:1</code>',
  cursor: '<strong>Cursor Protocol:</strong> <code>cursor://file/path/to/file.js:42:1</code>',
  webstorm: '<strong>WebStorm Protocol:</strong> <code>webstorm://open?file=/path/to/file.js&line=42</code>',
  sublime: '<strong>Sublime Protocol:</strong> <code>subl://open?url=file:///path/to/file.js:42</code>',
  vim: '<strong>Vim:</strong> Uses VS Code protocol as fallback',
};

// Load settings on page load
function loadSettings(): void {
  chrome.storage.local.get(
    ['preferredEditor', 'maxFilesDisplayed', 'projectPath'],
    (result: Partial<Settings>) => {
      elements.editorSelect.value = result.preferredEditor || DEFAULT_SETTINGS.preferredEditor;
      elements.maxFiles.value = String(result.maxFilesDisplayed || DEFAULT_SETTINGS.maxFilesDisplayed);
      elements.projectPath.value = result.projectPath || DEFAULT_SETTINGS.projectPath;

      updateEditorInfo();
    }
  );
}

// Update editor info display
function updateEditorInfo(): void {
  const selectedEditor = elements.editorSelect.value as EditorType;
  elements.editorInfo.innerHTML = EDITOR_PROTOCOLS[selectedEditor];
}

// Save settings
function saveSettings(): void {
  const settings: Settings = {
    preferredEditor: elements.editorSelect.value as EditorType,
    maxFilesDisplayed: parseInt(elements.maxFiles.value, 10),
    projectPath: elements.projectPath.value.trim(),
  };

  // Validate max files
  if (settings.maxFilesDisplayed < 3 || settings.maxFilesDisplayed > 20) {
    alert('Maximum files displayed must be between 3 and 20');
    return;
  }

  chrome.storage.local.set(settings, () => {
    showSuccessMessage();
    console.log('Settings saved:', settings);
  });
}

// Reset to defaults
function resetSettings(): void {
  if (confirm('Reset all settings to defaults?')) {
    chrome.storage.local.set(DEFAULT_SETTINGS, () => {
      loadSettings();
      showSuccessMessage();
      console.log('Settings reset to defaults');
    });
  }
}

// Show success message
function showSuccessMessage(): void {
  elements.successMessage.classList.add('visible');
  setTimeout(() => {
    elements.successMessage.classList.remove('visible');
  }, 3000);
}

// Event listeners
elements.editorSelect.addEventListener('change', updateEditorInfo);
elements.saveBtn.addEventListener('click', saveSettings);
elements.resetBtn.addEventListener('click', resetSettings);

// Handle Enter key in inputs
elements.projectPath.addEventListener('keypress', (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    saveSettings();
  }
});

elements.maxFiles.addEventListener('keypress', (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    saveSettings();
  }
});

// Load settings on startup
loadSettings();

export {};
