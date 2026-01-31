"""Command discovery service for both agent (slash) and shell commands."""

import json
import logging
import re
import sys
from pathlib import Path
from typing import List, Optional

from pydantic import BaseModel

logger = logging.getLogger(__name__)


class Command(BaseModel):
    """Unified command model for both agent and shell commands."""

    name: str  # e.g., "commit" or "test"
    command: str  # e.g., "/commit" or "npm test"
    description: Optional[str] = None
    category: Optional[str] = None  # e.g., "git-workflow" or "npm-scripts"
    mode: str  # "agent" or "shell"

    # Metadata from YAML frontmatter (for commands from .claude/commands/)
    allowed_tools: Optional[List[str]] = None
    argument_hint: Optional[str] = None
    model: Optional[str] = None


class CommandDiscovery:
    """
    Discover both agent commands (slash commands) and shell commands (project scripts).

    Supports three modes:
    - agent: Slash commands for the coding agent (e.g., /commit, /review-pr)
    - shell: Project commands for shell execution (e.g., npm test, make build)
    - all: Both agent and shell commands
    """

    def __init__(self, project_path: str, backend) -> None:
        """
        Initialize command discovery.

        Args:
            project_path: Root directory of the project
            backend: AgentBackend instance for querying agent commands
        """
        self.project_path = Path(project_path).resolve()
        self.backend = backend
        self._cache: dict = {}
        self._cache_ttl = {"agent": float("inf"), "shell": 60}  # Agent: session lifetime, shell: 60s

    async def discover_commands(self, mode: str = "agent") -> List[Command]:
        """
        Discover commands based on mode.

        Args:
            mode: "agent", "shell", or "all"

        Returns:
            List of Command objects
        """
        if mode == "agent":
            return await self._discover_agent_commands()
        elif mode == "shell":
            return await self._discover_shell_commands()
        elif mode == "all":
            agent_commands = await self._discover_agent_commands()
            shell_commands = await self._discover_shell_commands()
            # Merge and sort
            all_commands = agent_commands + shell_commands
            all_commands.sort(key=lambda c: c.name)
            return all_commands
        else:
            raise ValueError(f"Invalid mode: {mode}. Use 'agent', 'shell', or 'all'")

    async def _discover_agent_commands(self) -> List[Command]:
        """
        Discover agent slash commands from two sources:
        1. SDK init message (primary) - built-in + registered custom commands
        2. Filesystem (supplementary) - local custom commands not yet executed

        Returns:
            List of agent Command objects
        """
        # Check cache
        if "agent" in self._cache:
            logger.debug("Returning cached agent commands")
            return self._cache["agent"]

        commands: List[Command] = []

        # PRIMARY SOURCE: Get slash commands from backend (SDK init message)
        try:
            if hasattr(self.backend, 'get_slash_commands'):
                sdk_commands = self.backend.get_slash_commands()
                logger.info(f"Retrieved {len(sdk_commands)} commands from SDK")

                # Convert SDK command names to Command objects
                for cmd_name in sdk_commands:
                    commands.append(
                        Command(
                            name=cmd_name.lstrip('/'),  # Remove leading slash
                            command=cmd_name if cmd_name.startswith('/') else f'/{cmd_name}',
                            description=None,  # SDK doesn't provide descriptions
                            category="built-in",
                            mode="agent"
                        )
                    )
            else:
                logger.info("Backend doesn't support slash commands, using filesystem only")
        except Exception as e:
            logger.warning(f"Failed to get slash commands from backend: {e}")

        # SUPPLEMENTARY SOURCE: Scan filesystem for custom commands
        filesystem_commands = self._scan_filesystem_commands()

        # Merge: Prefer SDK commands, add filesystem commands not in SDK
        sdk_command_names = {cmd.name for cmd in commands}
        for fs_cmd in filesystem_commands:
            if fs_cmd.name not in sdk_command_names:
                commands.append(fs_cmd)
            else:
                logger.debug(f"Skipping filesystem command {fs_cmd.name} (already in SDK)")

        # Cache results
        self._cache["agent"] = commands
        logger.info(f"Total agent commands: {len(commands)} (SDK: {len(sdk_command_names)}, Filesystem: {len(filesystem_commands)})")

        return commands

    def _scan_filesystem_commands(self) -> List[Command]:
        """
        Scan .claude/commands/ for custom command markdown files.

        Returns:
            List of Command objects from filesystem
        """
        commands: List[Command] = []

        # Look for .claude/commands/ in project and home directory
        search_paths = [
            self.project_path / ".claude" / "commands",
            Path.home() / ".claude" / "commands",
        ]

        for commands_dir in search_paths:
            if not commands_dir.exists():
                continue

            logger.debug(f"Scanning commands directory: {commands_dir}")

            try:
                # Look for *.md files (both top-level and in subdirectories)
                for item in commands_dir.rglob("*.md"):
                    if not item.is_file():
                        continue

                    # Extract command name from filename (without .md)
                    command_name = item.stem

                    # Extract category from subdirectory path if nested
                    relative_path = item.relative_to(commands_dir)
                    category = relative_path.parent.name if relative_path.parent != Path(".") else None

                    # Parse command metadata from frontmatter
                    metadata = self._parse_command_metadata(item)

                    commands.append(
                        Command(
                            name=command_name,
                            command=f"/{command_name}",
                            description=metadata.get("description"),
                            category=category,
                            mode="agent",
                            allowed_tools=metadata.get("allowed_tools"),
                            argument_hint=metadata.get("argument_hint"),
                            model=metadata.get("model"),
                        )
                    )

            except PermissionError as e:
                logger.warning(f"Permission denied reading commands directory {commands_dir}: {e}")
            except Exception as e:
                logger.error(f"Error scanning commands directory {commands_dir}: {e}")

        logger.info(f"Found {len(commands)} agent commands from filesystem")
        return commands

    def _parse_command_metadata(self, cmd_file: Path) -> dict:
        """
        Parse YAML frontmatter from command markdown file.

        Args:
            cmd_file: Path to command markdown file

        Returns:
            dict with: description, allowed_tools, argument_hint, model
        """
        try:
            with open(cmd_file, "r", encoding="utf-8") as f:
                content = f.read()

            # Extract YAML frontmatter
            frontmatter_match = re.search(
                r"^---\s*\n(.*?)\n---", content, re.MULTILINE | re.DOTALL
            )

            if frontmatter_match:
                yaml_content = frontmatter_match.group(1)
                metadata = {}

                # Simple regex-based parsing (avoid PyYAML dependency)
                # Description
                desc_match = re.search(r"description:\s*(.+)", yaml_content)
                if desc_match:
                    metadata["description"] = desc_match.group(1).strip()

                # Allowed tools (can be array or single value)
                tools_match = re.search(r"allowed-tools:\s*\[([^\]]+)\]", yaml_content)
                if tools_match:
                    # Parse array format: [Read, Grep, Write]
                    tools_str = tools_match.group(1)
                    metadata["allowed_tools"] = [t.strip() for t in tools_str.split(",")]
                else:
                    # Try single value format
                    tools_match = re.search(r"allowed-tools:\s*(.+)", yaml_content)
                    if tools_match:
                        metadata["allowed_tools"] = [tools_match.group(1).strip()]

                # Argument hint
                arg_match = re.search(r"argument-hint:\s*(.+)", yaml_content)
                if arg_match:
                    metadata["argument_hint"] = arg_match.group(1).strip()

                # Model
                model_match = re.search(r"model:\s*(.+)", yaml_content)
                if model_match:
                    metadata["model"] = model_match.group(1).strip()

                return metadata

            # Fallback: Use first non-empty line after frontmatter as description
            lines = content.split("\n")
            in_frontmatter = False
            for line in lines:
                line = line.strip()
                if line == "---":
                    in_frontmatter = not in_frontmatter
                    continue
                if not in_frontmatter and line and not line.startswith("#"):
                    return {"description": line}

            return {}

        except Exception as e:
            logger.warning(f"Error parsing command metadata: {e}")
            return {}

    async def _discover_shell_commands(self) -> List[Command]:
        """
        Discover shell commands from project config files.

        Parses:
        - pyproject.toml [project.scripts]
        - package.json "scripts"

        Returns:
            List of shell Command objects
        """
        # Check cache (with TTL)
        if "shell" in self._cache:
            logger.debug("Returning cached shell commands")
            return self._cache["shell"]

        commands: List[Command] = []

        # Parse pyproject.toml
        commands.extend(self._parse_pyproject_toml())

        # Parse package.json
        commands.extend(self._parse_package_json())

        # Sort by name
        commands.sort(key=lambda c: c.name)

        # Cache results
        self._cache["shell"] = commands

        logger.info(f"Found {len(commands)} shell commands")
        return commands

    def _parse_pyproject_toml(self) -> List[Command]:
        """
        Parse pyproject.toml for [project.scripts] section.

        Returns:
            List of shell Command objects
        """
        pyproject_path = self.project_path / "pyproject.toml"
        if not pyproject_path.exists():
            return []

        commands: List[Command] = []

        try:
            # Use tomllib (Python 3.11+) or tomli (fallback)
            if sys.version_info >= (3, 11):
                import tomllib
            else:
                try:
                    import tomli as tomllib
                except ImportError:
                    logger.warning("tomli not available, cannot parse pyproject.toml")
                    return []

            with open(pyproject_path, "rb") as f:
                data = tomllib.load(f)

            # Get [project.scripts] section
            scripts = data.get("project", {}).get("scripts", {})

            for name, entrypoint in scripts.items():
                commands.append(
                    Command(
                        name=name,
                        command=name,
                        description=f"Run {name} entrypoint: {entrypoint}",
                        category="pyproject.toml",
                        mode="shell",
                    )
                )

            logger.debug(f"Parsed {len(commands)} commands from pyproject.toml")

        except Exception as e:
            logger.warning(f"Error parsing pyproject.toml: {e}")

        return commands

    def _parse_package_json(self) -> List[Command]:
        """
        Parse package.json for "scripts" section.

        Returns:
            List of shell Command objects
        """
        package_json_path = self.project_path / "package.json"
        if not package_json_path.exists():
            return []

        commands: List[Command] = []

        try:
            with open(package_json_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            # Get "scripts" section
            scripts = data.get("scripts", {})

            for name, script_cmd in scripts.items():
                # Construct npm run command
                command_str = f"npm run {name}"

                commands.append(
                    Command(
                        name=name,
                        command=command_str,
                        description=f"Run npm script: {script_cmd}",
                        category="package.json",
                        mode="shell",
                    )
                )

            logger.debug(f"Parsed {len(commands)} commands from package.json")

        except Exception as e:
            logger.warning(f"Error parsing package.json: {e}")

        return commands
