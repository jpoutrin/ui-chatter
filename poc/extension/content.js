// Content script for UI element capture
let clickModeActive = false;
let currentHighlight = null;

// Listen for messages from side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'toggle_click_mode') {
    clickModeActive = !clickModeActive;
    sendResponse({ active: clickModeActive });
    return true; // Keep channel open for async response
  }
});

// Capture element data
function captureElement(element) {
  const rect = element.getBoundingClientRect();

  // Get ancestors (up to 3 levels)
  const ancestors = [];
  let parent = element.parentElement;
  let level = 0;
  while (parent && level < 3) {
    ancestors.push({
      tagName: parent.tagName.toLowerCase(),
      id: parent.id || undefined,
      classList: Array.from(parent.classList)
    });
    parent = parent.parentElement;
    level++;
  }

  return {
    element: {
      tagName: element.tagName.toLowerCase(),
      id: element.id || undefined,
      classList: Array.from(element.classList),
      textContent: element.textContent?.substring(0, 200) || '',
      attributes: Object.fromEntries(
        Array.from(element.attributes).map(attr => [attr.name, attr.value])
      ),
      boundingBox: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      }
    },
    ancestors,
    page: {
      url: window.location.href,
      title: document.title
    }
  };
}

// Mouse move handler for hover highlight
document.addEventListener('mousemove', (e) => {
  if (!clickModeActive) return;

  // Remove previous highlight
  if (currentHighlight) {
    currentHighlight.classList.remove('ui-chatter-highlight');
  }

  // Add highlight to hovered element
  const element = e.target;
  if (element && element !== document.body && element !== document.documentElement) {
    element.classList.add('ui-chatter-highlight');
    currentHighlight = element;
  }
});

// Click handler for element selection
document.addEventListener('click', (e) => {
  if (!clickModeActive) return;

  e.preventDefault();
  e.stopPropagation();

  const element = e.target;

  // Visual feedback
  element.classList.remove('ui-chatter-highlight');
  element.classList.add('ui-chatter-clicked');
  setTimeout(() => element.classList.remove('ui-chatter-clicked'), 500);

  // Capture element context
  const context = captureElement(element);

  // Send to background script
  chrome.runtime.sendMessage({
    type: 'element_selected',
    context
  });

  // Deactivate click mode
  clickModeActive = false;
  if (currentHighlight) {
    currentHighlight.classList.remove('ui-chatter-highlight');
    currentHighlight = null;
  }
}, true);

console.log('UI Chatter content script loaded');
