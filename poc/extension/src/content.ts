// Content script for UI element capture

// Type definitions
interface AncestorInfo {
  tagName: string;
  id: string | undefined;
  classList: string[];
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ElementInfo {
  tagName: string;
  id: string | undefined;
  classList: string[];
  textContent: string;
  attributes: Record<string, string>;
  boundingBox: BoundingBox;
  xpath: string;
  cssSelector: string;
}

interface PageInfo {
  url: string;
  title: string;
}

interface CapturedElement {
  element: ElementInfo;
  ancestors: AncestorInfo[];
  page: PageInfo;
}

interface ChromeMessage {
  type: string;
  context?: CapturedElement;
}

// State
let clickModeActive = false;
let currentHighlight: HTMLElement | null = null;

// Listen for messages from side panel
chrome.runtime.onMessage.addListener((message: ChromeMessage, _sender, sendResponse) => {
  if (message.type === 'toggle_click_mode') {
    clickModeActive = !clickModeActive;
    sendResponse({ active: clickModeActive });
    return true; // Keep channel open for async response
  }
});

// Generate XPath for an element
function getXPath(element: Element): string {
  if (element.id !== '') {
    return `//*[@id="${element.id}"]`;
  }

  if (element === document.body) {
    return '/html/body';
  }

  const path: string[] = [];
  let currentElement: Element | null = element;

  while (currentElement && currentElement.nodeType === Node.ELEMENT_NODE) {
    let index = 0;
    let sibling = currentElement.previousSibling;

    while (sibling) {
      if (sibling.nodeType === Node.ELEMENT_NODE && (sibling as Element).tagName === currentElement.tagName) {
        index++;
      }
      sibling = sibling.previousSibling;
    }

    const tagName = currentElement.tagName.toLowerCase();
    const pathIndex = index > 0 ? `[${index + 1}]` : '';
    path.unshift(`${tagName}${pathIndex}`);

    currentElement = currentElement.parentElement;
  }

  return path.length ? `/${path.join('/')}` : '';
}

// Generate CSS selector for an element
function getCSSSelector(element: HTMLElement): string {
  if (element.id) {
    return `#${element.id}`;
  }

  const path: string[] = [];
  let currentElement: HTMLElement | null = element;

  while (currentElement && currentElement !== document.body) {
    let selector = currentElement.tagName.toLowerCase();

    if (currentElement.classList.length > 0) {
      selector += '.' + Array.from(currentElement.classList).join('.');
    }

    // Add nth-child if needed for uniqueness
    if (currentElement.parentElement) {
      const siblings = Array.from(currentElement.parentElement.children);
      const sameTagSiblings = siblings.filter(s => s.tagName === currentElement!.tagName);
      if (sameTagSiblings.length > 1) {
        const index = siblings.indexOf(currentElement) + 1;
        selector += `:nth-child(${index})`;
      }
    }

    path.unshift(selector);
    currentElement = currentElement.parentElement;
  }

  return path.join(' > ');
}

// Capture element data
function captureElement(element: HTMLElement): CapturedElement {
  const rect = element.getBoundingClientRect();

  // Get ancestors (up to 3 levels)
  const ancestors: AncestorInfo[] = [];
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
document.addEventListener('mousemove', (e: MouseEvent) => {
  if (!clickModeActive) return;

  // Remove previous highlight
  if (currentHighlight) {
    currentHighlight.classList.remove('ui-chatter-highlight');
  }

  // Add highlight to hovered element
  const element = e.target as HTMLElement;
  if (element && element !== document.body && element !== document.documentElement) {
    element.classList.add('ui-chatter-highlight');
    currentHighlight = element;
  }
});

// Click handler for element selection
document.addEventListener('click', (e: MouseEvent) => {
  if (!clickModeActive) return;

  e.preventDefault();
  e.stopPropagation();

  const element = e.target as HTMLElement;

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

export {};
