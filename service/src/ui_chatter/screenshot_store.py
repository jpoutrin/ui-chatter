"""Async screenshot storage with automatic cleanup."""

import asyncio
import base64
import logging
from datetime import datetime, timedelta
from pathlib import Path

import aiofiles

logger = logging.getLogger(__name__)


class ScreenshotStore:
    """
    Async screenshot storage with automatic cleanup.

    Features:
    - Non-blocking base64 decode
    - Async file writes
    - Automatic old file cleanup
    """

    def __init__(self, project_path: str):
        self.screenshots_dir = Path(project_path) / ".ui-chatter" / "screenshots"
        self.screenshots_dir.mkdir(parents=True, exist_ok=True)

    async def save(
        self, session_id: str, context_id: str, base64_data: str
    ) -> str:
        """
        Save screenshot asynchronously and return file path.

        Args:
            session_id: Session identifier
            context_id: Context/element identifier
            base64_data: Base64-encoded screenshot data

        Returns:
            str: Path to saved screenshot file
        """
        filename = f"{session_id}_{context_id}.png"
        filepath = self.screenshots_dir / filename

        try:
            # Decode in thread pool to avoid blocking event loop
            loop = asyncio.get_event_loop()

            # Handle data URL format (data:image/png;base64,...)
            if "," in base64_data:
                base64_str = base64_data.split(",")[1]
            else:
                base64_str = base64_data

            image_data = await loop.run_in_executor(
                None, base64.b64decode, base64_str
            )

            # Async file write
            async with aiofiles.open(filepath, "wb") as f:
                await f.write(image_data)

            logger.debug(
                f"Saved screenshot: {filename} ({len(image_data)} bytes)"
            )
            return str(filepath)

        except Exception as e:
            logger.error(f"Failed to save screenshot: {e}", exc_info=True)
            raise

    async def cleanup_old(self, max_age_hours: int = 24) -> int:
        """
        Delete screenshots older than max_age_hours.

        Args:
            max_age_hours: Maximum age in hours

        Returns:
            int: Number of files removed
        """
        cutoff = datetime.now() - timedelta(hours=max_age_hours)
        removed_count = 0

        for screenshot in self.screenshots_dir.glob("*.png"):
            try:
                file_mtime = datetime.fromtimestamp(screenshot.stat().st_mtime)
                if file_mtime < cutoff:
                    screenshot.unlink()
                    removed_count += 1
            except Exception as e:
                logger.warning(f"Failed to delete {screenshot}: {e}")

        if removed_count > 0:
            logger.info(f"Cleaned up {removed_count} old screenshot(s)")

        return removed_count
