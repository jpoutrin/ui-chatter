"""Typer CLI interface for UI Chatter."""

import asyncio
import os
import signal
import sys
from pathlib import Path
from typing import Optional

import httpx
import typer
import uvicorn
from rich.console import Console
from rich.panel import Panel

app = typer.Typer(
    name="ui-chatter",
    help="UI Chatter - Browser to Claude Code integration",
    add_completion=False,
)
console = Console()


async def check_service_running(port: int) -> bool:
    """Check if service is already running on port."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"http://localhost:{port}/health", timeout=2.0)
            return resp.status_code == 200
    except:
        return False


@app.command()
def serve(
    project: str = typer.Option(
        ".", "--project", "-p", help="Project directory"
    ),
    backend: str = typer.Option(
        "claude-cli",
        "--backend",
        "-b",
        help="Backend strategy: 'claude-cli' (uses Claude Code auth) or 'anthropic-sdk' (needs API key)",
    ),
    permission_mode: Optional[str] = typer.Option(
        None,
        "--permission-mode",
        help="[DEPRECATED] Permission mode for Claude CLI. Use extension UI instead. "
        "Valid values: acceptEdits, bypassPermissions, default, delegate, dontAsk, plan",
    ),
    port: int = typer.Option(3456, "--port", help="WebSocket port"),
    host: str = typer.Option("localhost", "--host", help="Bind address"),
    debug: bool = typer.Option(False, "--debug", help="Enable debug logging"),
    reload: bool = typer.Option(
        False, "--reload", help="Enable auto-reload (dev mode)"
    ),
):
    """Start UI Chatter service."""
    project_path = Path(project).resolve()

    # Validate project directory
    if not project_path.exists():
        console.print(
            f"[red]Error:[/red] Project directory not found: {project_path}"
        )
        raise typer.Exit(1)

    # Validate backend strategy
    if backend not in ("claude-cli", "anthropic-sdk"):
        console.print(
            f"[red]Error:[/red] Invalid backend: {backend}. Use 'claude-cli' or 'anthropic-sdk'"
        )
        raise typer.Exit(1)

    # Set environment variables BEFORE importing settings to ensure they're picked up
    os.environ["UI_CHATTER_PROJECT_PATH"] = str(project_path)
    os.environ["BACKEND_STRATEGY"] = backend
    os.environ["DEBUG"] = "true" if debug else "false"

    # Handle permission mode (deprecated CLI flag)
    valid_modes = ["acceptEdits", "bypassPermissions", "default", "delegate", "dontAsk", "plan"]
    if permission_mode is not None:
        # Validate if provided
        if permission_mode not in valid_modes:
            console.print(
                f"[red]Error:[/red] Invalid permission mode: {permission_mode}. "
                f"Use one of: {', '.join(valid_modes)}"
            )
            raise typer.Exit(1)

        # Show deprecation warning
        console.print(
            "[yellow]Warning:[/yellow] --permission-mode flag is deprecated. "
            "Permission mode is now managed via the browser extension UI (Shift+Tab to toggle)."
        )
    else:
        # Use default from settings
        from .config import settings
        permission_mode = settings.PERMISSION_MODE

    # Update permission mode env var after it's determined
    os.environ["PERMISSION_MODE"] = permission_mode

    # Check if already running
    if asyncio.run(check_service_running(port)):
        console.print(f"[red]Error:[/red] Service already running on port {port}")
        raise typer.Exit(1)

    # Auto-add .ui-chatter/ to .gitignore
    gitignore = project_path / ".gitignore"
    if gitignore.exists():
        content = gitignore.read_text()
        if ".ui-chatter/" not in content:
            with gitignore.open("a") as f:
                f.write("\n# UI Chatter\n.ui-chatter/\n")
            console.print("[green]✓[/green] Added .ui-chatter/ to .gitignore")

    # Setup signal handlers for graceful shutdown
    def signal_handler(sig, frame):
        console.print("\n[yellow]Shutting down gracefully...[/yellow]")
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Display startup info
    backend_desc = "Claude Code CLI" if backend == "claude-cli" else "Anthropic SDK"
    permission_info = (
        f"\n🔒 Default Permission Mode: {permission_mode} (can be changed via extension)"
        if backend == "claude-cli"
        else ""
    )
    console.print(
        Panel.fit(
            f"[bold]UI Chatter Service[/bold]\n\n"
            f"📁 Project: {project_path}\n"
            f"🤖 Backend: {backend_desc}{permission_info}\n"
            f"📡 WebSocket: ws://{host}:{port}\n"
            f"🔍 Debug: {'enabled' if debug else 'disabled'}",
            border_style="green",
        )
    )

    # Start Uvicorn with WebSocket keepalive
    from .config import settings as ws_settings

    uvicorn.run(
        "ui_chatter.main:app",
        host=host,
        port=port,
        log_level="debug" if debug else "info",
        reload=reload,
        access_log=debug,
        # WebSocket keepalive - protocol-level pings
        ws_ping_interval=ws_settings.WS_PROTOCOL_PING_INTERVAL,
        ws_ping_timeout=ws_settings.WS_PROTOCOL_PING_TIMEOUT,
        timeout_keep_alive=120,  # HTTP keepalive 2min
    )


if __name__ == "__main__":
    app()
