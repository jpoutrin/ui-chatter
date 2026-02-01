# Claude Code Instructions for UI Chatter Service

## Generated Documentation

**IMPORTANT**: When generating summaries, analysis documents, or other non-critical markdown files, always save them to the `claude-feedback/` directory.

### Files that belong in `claude-feedback/`:
- SUMMARY.md - Session summaries and progress reports
- ANALYSIS.md - Code analysis and technical reports
- VERIFICATION.md - Verification checklists and test results
- IMPLEMENTATION.md - Implementation notes and decisions
- Any other .md files generated for documentation or tracking purposes

### Example:
```markdown
# Instead of creating SUMMARY.md in the project root:
# ❌ /Users/.../ui-chatter/service/SUMMARY.md

# Create it in claude-feedback:
# ✅ /Users/.../ui-chatter/service/claude-feedback/SUMMARY.md
```

### Why?
The `claude-feedback/` directory is gitignored to keep temporary analysis and session documentation separate from the actual project files. This keeps the git history clean and focused on real code changes.

## Testing

Always use `uv run pytest` to run tests:
```bash
uv run pytest
uv run pytest tests/test_auto_resume.py -v
uv run pytest -k "test_auto_resume" -v
```

## Type Checking and Testing

**IMPORTANT**: After making any Python code edits in the service, always run both type checking and unit tests to catch errors early.

```bash
# From the service directory
builtin cd /Users/jeremiepoutrin/projects/github/jpoutrin/ui-chatter/service

# 1. Run type checking
/usr/bin/make type-check

# 2. Run unit tests
/usr/bin/make test
```

This project uses strict mypy configuration to ensure type safety, and comprehensive unit tests to verify functionality. Running both checks before committing helps maintain code quality and catches potential runtime errors.

## Running the Service

```bash
# Start the service
uv run ui-chatter

# With options
uv run ui-chatter --port 3456 --debug
uv run ui-chatter --project /path/to/project
```

## Chrome Extension Development

### ⚠️ CRITICAL: Always Rebuild After Modifications

**MANDATORY RULE**: Every time you modify ANY `.ts` file in the `../poc/extension/src/` directory, you MUST immediately rebuild the extension. Changes are NOT reflected until recompiled.

### Recompiling TypeScript

**IMPORTANT**: After modifying any `.ts` files in the `../poc/extension/src/` directory, you MUST recompile the TypeScript to JavaScript.

```bash
# Navigate to the extension directory
builtin cd /Users/jeremiepoutrin/projects/github/jpoutrin/ui-chatter/poc/extension

# Compile TypeScript
npm run build

# Or use watch mode for continuous compilation during development
npm run build:watch
```

**Files affected:**
- `src/*.ts` → compiled to → `dist/*.js`
- Changes to `.ts` files are NOT reflected in the extension until compiled
- The Chrome extension loads the compiled `.js` files from the `dist/` directory

**After compilation:**
1. Reload the extension in Chrome (chrome://extensions/ → click reload icon)
2. Close and reopen any active side panels to load the new code
3. Test the changes

## Python Development Best Practices

### Use LSP MCP for Type Intelligence

**IMPORTANT**: When performing Python coding operations, always leverage the LSP (Language Server Protocol) MCP for type intelligence and validation.

The LSP MCP provides:
- **Type Discovery**: Query existing type annotations in dependencies
- **Usage Analysis**: Find all places where types should be added
- **Real-Time Validation**: Get type checking feedback as you code
- **Hover Information**: See type definitions without file switching
- **Go-to-Definition**: Navigate to type sources easily

Example workflow:
```bash
# LSP is already configured via claude-code-dev:install-lsp skill
# Use LSP hover to check type information
# Use LSP diagnostics to validate types in real-time
# Use LSP completion for type-aware suggestions
```

### Leverage Python Expert Agents

**IMPORTANT**: For complex Python tasks, always use the Python expert agents from the `python-experts` skill family.

Available Python expert agents:
- `python-experts:mypy-check` - Run Mypy type checking with detailed error reporting
- `python-experts:mypy-setup` - Set up Mypy configuration for a project
- `python-experts:django-expert` - Django web application specialist
- `python-experts:fastapi-expert` - FastAPI specialist for async APIs
- `python-experts:python-testing-expert` - Testing specialist for pytest
- `python-experts:python-style` - Enforce Python coding style and PEP standards

Example usage:
```bash
# After making type changes, use mypy-check skill
/python-experts:mypy-check

# For Django-specific work
/python-experts:django-expert

# For testing guidance
/python-experts:python-testing-expert
```

**When to use Python experts:**
- Complex typing scenarios (generics, protocols, TypedDicts)
- Django ORM and view implementations
- FastAPI endpoint design with async/await
- Pytest fixture design and test architecture
- Type hint migration and modernization
- Performance optimization and profiling
