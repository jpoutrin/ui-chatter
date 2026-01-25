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

// Generate XPath for an element
function getXPath(element) {
  if (element.id !== '') {
    return `//*[@id="${element.id}"]`;
  }

  if (element === document.body) {
    return '/html/body';
  }

  let path = [];
  while (element && element.nodeType === Node.ELEMENT_NODE) {
    let index = 0;
    let sibling = element.previousSibling;

    while (sibling) {
      if (sibling.nodeType === Node.ELEMENT_NODE && sibling.tagName === element.tagName) {
        index++;
      }
      sibling = sibling.previousSibling;
    }

    const tagName = element.tagName.toLowerCase();
    const pathIndex = index > 0 ? `[${index + 1}]` : '';
    path.unshift(`${tagName}${pathIndex}`);

    element = element.parentElement;
  }

  return path.length ? `/${path.join('/')}` : '';
}

// Generate CSS selector for an element
function getCSSSelector(element) {
  if (element.id) {
    return `#${element.id}`;
  }

  let path = [];
  while (element && element !== document.body) {
    let selector = element.tagName.toLowerCase();

    if (element.classList.length > 0) {
      selector += '.' + Array.from(element.classList).join('.');
    }

    // Add nth-child if needed for uniqueness
    if (element.parentElement) {
      const siblings = Array.from(element.parentElement.children);
      const sameTagSiblings = siblings.filter(s => s.tagName === element.tagName);
      if (sameTagSiblings.length > 1) {
        const index = siblings.indexOf(element) + 1;
        selector += `:nth-child(${index})`;
      }
    }

    path.unshift(selector);
    element = element.parentElement;
  }

  return path.join(' > ');
}

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
      },
      xpath: getXPath(element),
      cssSelector: getCSSSelector(element)
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
