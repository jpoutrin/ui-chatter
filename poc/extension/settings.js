// Settings page logic
const elements = {
  editorSelect: document.getElementById('editorSelect'),
  projectPath: document.getElementById('projectPath'),
  maxFiles: document.getElementById('maxFiles'),
  saveBtn: document.getElementById('saveBtn'),
  resetBtn: document.getElementById('resetBtn'),
  successMessage: document.getElementById('successMessage'),
  editorInfo: document.getElementById('editorInfo'),
};

// Default settings
const DEFAULT_SETTINGS = {
  preferredEditor: 'vscode',
  maxFilesDisplayed: 5,
  projectPath: '',
};

// Editor protocol examples
const EDITOR_PROTOCOLS = {
  vscode: '<strong>VS Code Protocol:</strong> <code>vscode://file/path/to/file.js:42:1</code>',
  cursor: '<strong>Cursor Protocol:</strong> <code>cursor://file/path/to/file.js:42:1</code>',
  webstorm: '<strong>WebStorm Protocol:</strong> <code>webstorm://open?file=/path/to/file.js&line=42</code>',
  sublime: '<strong>Sublime Protocol:</strong> <code>subl://open?url=file:///path/to/file.js:42</code>',
  vim: '<strong>Vim:</strong> Uses VS Code protocol as fallback',
};

// Load settings on page load
function loadSettings() {
  chrome.storage.local.get(
    ['preferredEditor', 'maxFilesDisplayed', 'projectPath'],
    (result) => {
      elements.editorSelect.value = result.preferredEditor || DEFAULT_SETTINGS.preferredEditor;
      elements.maxFiles.value = result.maxFilesDisplayed || DEFAULT_SETTINGS.maxFilesDisplayed;
      elements.projectPath.value = result.projectPath || DEFAULT_SETTINGS.projectPath;

      updateEditorInfo();
    }
  );
}

// Update editor info display
function updateEditorInfo() {
  const selectedEditor = elements.editorSelect.value;
  elements.editorInfo.innerHTML = EDITOR_PROTOCOLS[selectedEditor];
}

// Save settings
function saveSettings() {
  const settings = {
    preferredEditor: elements.editorSelect.value,
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
function resetSettings() {
  if (confirm('Reset all settings to defaults?')) {
    chrome.storage.local.set(DEFAULT_SETTINGS, () => {
      loadSettings();
      showSuccessMessage();
      console.log('Settings reset to defaults');
    });
  }
}

// Show success message
function showSuccessMessage() {
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
elements.projectPath.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    saveSettings();
  }
});

elements.maxFiles.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    saveSettings();
  }
});

// Load settings on startup
loadSettings();
