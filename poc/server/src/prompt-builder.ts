import { CapturedContext } from './types.js';

export function buildPrompt(context: CapturedContext, userMessage: string): string {
  const { element, ancestors, page } = context;

  return `
## UI Context

The user has selected an element on the page: ${page.url}

### Selected Element
- Tag: <${element.tagName}>
- ID: ${element.id || '(none)'}
- Classes: ${element.classList.join(', ') || '(none)'}
- Text: "${element.textContent}"
- Attributes: ${JSON.stringify(element.attributes)}

### Ancestor Chain
${ancestors.map((a, i) => `${i + 1}. <${a.tagName}> id="${a.id || ''}" class="${a.classList.join(' ')}"`).join('\n')}

## User Request

${userMessage}

## Instructions

Help the user with their request about this UI element. If they want to modify it, search the codebase to find the component and make the change.
`.trim();
}
