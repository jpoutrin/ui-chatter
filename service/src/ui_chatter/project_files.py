"""Project file listing with gitignore support and caching."""

import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pathspec

logger = logging.getLogger(__name__)


class ProjectFileLister:
    """
    Async file listing service with gitignore support and caching.

    Features:
    - Respects .gitignore patterns
    - Default exclusions (e.g., .git/, node_modules/)
    - Pattern matching via glob patterns
    - Prefix filtering for autocomplete
    - In-memory TTL cache (30 seconds)
    """

    # Default directories and patterns to exclude
    DEFAULT_EXCLUSIONS = {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        "dist",
        "build",
        ".tox",
        ".eggs",
        "*.egg-info",
    }

    def __init__(self, project_path: str, use_gitignore: bool = True) -> None:
        """
        Initialize file lister for a project.

        Args:
            project_path: Root directory of the project
            use_gitignore: Whether to parse and respect .gitignore
        """
        self.project_path = Path(project_path).resolve()
        self.use_gitignore = use_gitignore
        self.gitignore_spec: Optional[pathspec.PathSpec] = None
        self._cache: Dict[Tuple[Optional[str], Optional[str]], Tuple[Dict[str, Any], float]] = {}
        self._cache_ttl = 30  # seconds

        if self.use_gitignore:
            self.gitignore_spec = self._load_gitignore()

    def _load_gitignore(self) -> Optional[pathspec.PathSpec]:
        """
        Load and parse .gitignore file.

        Returns:
            PathSpec object if .gitignore exists, None otherwise
        """
        gitignore_path = self.project_path / ".gitignore"
        if not gitignore_path.exists():
            logger.debug("No .gitignore found")
            return None

        try:
            with open(gitignore_path, "r", encoding="utf-8") as f:
                patterns = f.read().splitlines()
            spec = pathspec.PathSpec.from_lines(pathspec.patterns.GitWildMatchPattern, patterns)
            logger.debug(f"Loaded .gitignore with {len(patterns)} patterns")
            return spec
        except Exception as e:
            logger.warning(f"Failed to parse .gitignore: {e}")
            return None

    def _should_exclude(self, path: Path) -> bool:
        """
        Check if a path should be excluded.

        Args:
            path: Path to check (relative to project root)

        Returns:
            True if path should be excluded
        """
        # Get relative path for checking
        try:
            rel_path = path.relative_to(self.project_path)
        except ValueError:
            # Path is outside project root
            return True

        rel_path_str = str(rel_path)

        # Check default exclusions
        for exclusion in self.DEFAULT_EXCLUSIONS:
            # Check if it's a directory name or pattern
            if exclusion.endswith("/"):
                if rel_path_str.startswith(exclusion[:-1] + "/"):
                    return True
            elif "*" in exclusion:
                # Pattern matching
                if Path(rel_path_str).match(exclusion):
                    return True
            else:
                # Exact directory name match
                parts = rel_path_str.split("/")
                if exclusion in parts:
                    return True

        # Check gitignore patterns
        if self.gitignore_spec:
            # pathspec expects forward slashes and directory paths to end with /
            check_path = rel_path_str
            if path.is_dir():
                check_path = check_path + "/"

            if self.gitignore_spec.match_file(check_path):
                return True

        return False

    async def _walk_directory(self, max_depth: int = 10) -> List[Dict[str, Any]]:
        """
        Recursively walk directory tree.

        Args:
            max_depth: Maximum depth to traverse

        Returns:
            List of file metadata dictionaries
        """
        files: List[Dict[str, Any]] = []

        def walk_recursive(current_path: Path, depth: int) -> None:
            if depth > max_depth:
                return

            try:
                for item in current_path.iterdir():
                    # Check if should exclude
                    if self._should_exclude(item):
                        continue

                    # Get relative path
                    try:
                        rel_path = item.relative_to(self.project_path)
                    except ValueError:
                        continue

                    if item.is_file():
                        # Add file metadata
                        stat = item.stat()
                        files.append(
                            {
                                "relative_path": str(rel_path),
                                "size": stat.st_size,
                                "modified_at": stat.st_mtime,
                                "type": "file",
                            }
                        )
                    elif item.is_dir():
                        # Recurse into directory
                        walk_recursive(item, depth + 1)

            except PermissionError:
                logger.warning(f"Permission denied: {current_path}")
            except Exception as e:
                logger.warning(f"Error walking {current_path}: {e}")

        walk_recursive(self.project_path, 0)
        return files

    async def list_files(
        self, pattern: Optional[str] = None, prefix: Optional[str] = None, limit: int = 100
    ) -> Dict[str, Any]:
        """
        List files in project with optional filtering.

        Args:
            pattern: Glob pattern to match (e.g., "**/*.py")
            prefix: Prefix to filter by (e.g., "src/ui_chatter/")
            limit: Maximum number of files to return

        Returns:
            Dictionary with file list and metadata
        """
        # Check cache
        cache_key = (pattern, prefix)
        if cache_key in self._cache:
            cached_result, cached_time = self._cache[cache_key]
            if time.time() - cached_time < self._cache_ttl:
                logger.debug("Returning cached result")
                return cached_result

        # Walk directory
        all_files = await self._walk_directory()

        # Apply pattern filter
        if pattern:
            filtered = []
            for file_info in all_files:
                file_path = Path(file_info["relative_path"])
                if file_path.match(pattern):
                    filtered.append(file_info)
            all_files = filtered

        # Apply prefix filter
        if prefix:
            # Normalize prefix (remove leading/trailing slashes)
            prefix_normalized = prefix.strip("/")
            filtered = []
            for file_info in all_files:
                if file_info["relative_path"].startswith(prefix_normalized):
                    filtered.append(file_info)
            all_files = filtered

        # Sort alphabetically
        all_files.sort(key=lambda x: x["relative_path"])

        # Apply limit
        truncated = len(all_files) > limit
        files = all_files[:limit]

        result = {
            "file_count": len(files),
            "total_files": len(all_files),
            "files": files,
            "truncated": truncated,
        }

        # Cache result
        self._cache[cache_key] = (result, time.time())

        return result
