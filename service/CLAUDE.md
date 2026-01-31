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

## Type Checking

**IMPORTANT**: After making any Python code edits in the service, always run type checking to catch type errors early.

```bash
# From the service directory
builtin cd /Users/jeremiepoutrin/projects/github/jpoutrin/ui-chatter/service
/usr/bin/make type-check
```

This project uses strict mypy configuration to ensure type safety. Running type checks before committing helps maintain code quality and catches potential runtime errors.

## Running the Service

```bash
# Start the service
uv run ui-chatter

# With options
uv run ui-chatter --port 3456 --debug
uv run ui-chatter --project /path/to/project
```
