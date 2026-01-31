# TypeScript Migration Guide

## Overview

The UI Chatter Chrome Extension has been migrated from JavaScript to TypeScript using a gradual migration approach. The codebase is now TypeScript-compatible with relaxed type checking, allowing us to incrementally add proper types over time.

## Current Status

✅ **Completed:**
- Created `src/` directory with TypeScript source files (.ts)
- Configured `tsconfig.json` with gradual migration settings
- Set up build process: TypeScript → JavaScript (dist/)
- Updated manifest.json to reference compiled files
- Updated HTML files to load from dist/
- Added global type declarations for third-party libraries
- Configured ESLint for TypeScript
- Updated Makefile with build commands

⚠️ **Temporary Measures:**
- `// @ts-nocheck` directives added to all source files
- Strict type checking disabled in tsconfig.json
- No explicit type annotations yet

## Project Structure

```
poc/extension/
├── src/                      # TypeScript source files
│   ├── background.ts
│   ├── content.ts
│   ├── settings.ts
│   ├── sidepanel.ts
│   └── global.d.ts          # Global type declarations
├── dist/                     # Compiled JavaScript (git-ignored)
│   ├── background.js
│   ├── content.js
│   ├── settings.js
│   └── sidepanel.js
├── tests/                    # Jest tests (still JavaScript)
├── libs/                     # Third-party libraries
├── tsconfig.json            # TypeScript configuration
├── package.json             # Dependencies and scripts
└── Makefile                 # Build automation
```

## Build Process

### Development Workflow

```bash
# Build once
npm run build
make build

# Build and watch for changes
npm run build:watch
make build-watch

# Run tests (still on JS files in tests/)
make test

# Lint TypeScript
make lint

# Full CI check
make ci
```

### What Happens During Build

1. TypeScript compiler (`tsc`) reads `src/**/*.ts` files
2. Compiles to ES2022 modules (matching Chrome's capabilities)
3. Outputs to `dist/` directory with source maps
4. Chrome extension loads from `dist/` via manifest.json

## Gradual Type Safety Improvement

### Phase 1: Current State (Done)
- ✅ TypeScript compilation working
- ✅ Build process automated
- ✅ Extension loads and runs

### Phase 2: Remove `@ts-nocheck` (Next Step)
Remove `// @ts-nocheck` from files one at a time and fix type errors:

```typescript
// Before
// @ts-nocheck
const element = document.getElementById('foo');
element.value = 'bar';  // Works but unsafe

// After
const element = document.getElementById('foo') as HTMLInputElement;
element.value = 'bar';  // Type-safe
```

**Recommended Order:**
1. `content.ts` (smallest file)
2. `settings.ts` (moderate size)
3. `background.ts` (medium complexity)
4. `sidepanel.ts` (largest, most complex)

### Phase 3: Add Type Annotations
Add explicit types to functions and variables:

```typescript
// Before
function connectToServer(tabId, pageUrl) {
  // ...
}

// After
function connectToServer(tabId: number, pageUrl: string): void {
  // ...
}
```

### Phase 4: Enable Strict Mode
Gradually enable strict type checking in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": false,              // → true
    "noImplicitAny": false,       // → true
    "strictNullChecks": false,    // → true
    "strictFunctionTypes": false, // → true
    // ... etc
  }
}
```

### Phase 5: Create Type Definitions
Extract common types into dedicated files:

```typescript
// types/connection.ts
export interface TabConnection {
  ws: WebSocket;
  sessionId: string;
  sdkSessionId: string | null;
  pageUrl: string;
  status: 'connected' | 'disconnected';
}

// background.ts
import { TabConnection } from './types/connection';
const tabConnections: Record<number, TabConnection> = {};
```

## Common Type Fixes

### DOM Element Access

```typescript
// ❌ Unsafe
const input = document.getElementById('myInput');
input.value = 'text';

// ✅ Type-safe
const input = document.getElementById('myInput') as HTMLInputElement;
if (input) {
  input.value = 'text';
}

// ✅ Better - null check
const input = document.getElementById('myInput');
if (input instanceof HTMLInputElement) {
  input.value = 'text';
}
```

### Event Handlers

```typescript
// ❌ Unsafe
element.addEventListener('click', (e) => {
  e.target.classList.add('active');
});

// ✅ Type-safe
element.addEventListener('click', (e: Event) => {
  const target = e.target as HTMLElement;
  target.classList.add('active');
});
```

### Chrome API Calls

```typescript
// ❌ Implicit types
chrome.tabs.query({ active: true }, (tabs) => {
  const tab = tabs[0];
});

// ✅ Explicit types
chrome.tabs.query({ active: true }, (tabs: chrome.tabs.Tab[]) => {
  const tab = tabs[0];
  if (tab?.id) {
    // Type-safe access
  }
});
```

## Testing Strategy

### Current State
- Tests remain in JavaScript (`tests/**/*.test.js`)
- Tests verify compiled JavaScript output
- Jest configured for ES modules

### Future: TypeScript Tests
When ready, migrate tests to TypeScript:

```bash
# Create tests/tsconfig.json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": ["jest", "chrome"]
  }
}

# Rename tests to .ts
mv tests/background.test.js tests/background.test.ts
```

## Configuration Files

### tsconfig.json
- **target**: ES2022 (modern Chrome)
- **module**: ES2022 (native modules)
- **outDir**: dist/
- **rootDir**: src/
- **strict**: false (for gradual migration)
- **sourceMap**: true (for debugging)

### .eslintrc.json
- Parser: @typescript-eslint/parser
- Plugins: @typescript-eslint
- Ignores: dist/, libs/, tests/, *.js

### package.json Scripts
```json
{
  "build": "tsc",
  "build:watch": "tsc --watch",
  "lint": "eslint src",
  "type-check": "tsc --noEmit"
}
```

## Troubleshooting

### Build Errors

**Error: "Cannot find name 'chrome'"**
- Solution: Ensure `@types/chrome` is installed
- Check `tsconfig.json` has `"types": ["chrome"]`

**Error: "Cannot find name 'marked'"**
- Solution: Check `src/global.d.ts` exists
- Verify global declarations are present

### Runtime Errors

**Error: "Cannot find module" in browser**
- Check manifest.json points to `dist/` files
- Verify HTML files load from `dist/`
- Run `npm run build` to ensure files exist

**Error: "Unexpected token" in browser**
- Ensure `"type": "module"` in manifest.json background config
- Check browser console for detailed error

## Benefits of TypeScript

1. **Type Safety**: Catch errors at compile time
2. **Better IDE Support**: IntelliSense, autocomplete, refactoring
3. **Documentation**: Types serve as inline documentation
4. **Refactoring Confidence**: Rename, move code safely
5. **Chrome API Types**: Full type definitions for chrome.* APIs

## Next Steps

1. ✅ Complete initial migration (DONE)
2. ⬜ Remove `@ts-nocheck` from content.ts
3. ⬜ Add type annotations to key functions
4. ⬜ Create interface definitions for data structures
5. ⬜ Enable strict null checks
6. ⬜ Enable strict mode
7. ⬜ Migrate tests to TypeScript

## Resources

- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [Chrome Extension Types](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/chrome)
- [TypeScript Migration Guide](https://www.typescriptlang.org/docs/handbook/migrating-from-javascript.html)
