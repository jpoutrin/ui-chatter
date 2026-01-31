// Global type declarations for UI Chatter Extension

// Libraries loaded via script tags in HTML
declare const marked: {
  parse(markdown: string): string;
};

declare const DOMPurify: {
  sanitize(html: string, config?: any): string;
};

declare const Prism: {
  highlightAllUnder(element: Element): void;
  highlightElement(element: Element): void;
};

// Chrome types are provided by @types/chrome
declare const chrome: typeof import('chrome');
