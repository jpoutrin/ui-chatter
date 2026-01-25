"""Models for captured UI context from browser extension."""

from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class CapturedElement(BaseModel):
    """Represents a captured DOM element."""

    tagName: str = Field(..., description="HTML tag name (e.g., 'button', 'div')")
    id: Optional[str] = Field(None, description="Element ID attribute")
    classList: List[str] = Field(default_factory=list, description="CSS class names")
    textContent: Optional[str] = Field(None, description="Element text content")
    attributes: Dict[str, str] = Field(
        default_factory=dict, description="Element attributes"
    )
    boundingBox: Optional[Dict[str, float]] = Field(
        None, description="Element bounding box {x, y, width, height}"
    )
    xpath: Optional[str] = Field(None, description="XPath to element")
    cssSelector: Optional[str] = Field(None, description="CSS selector")


class PageInfo(BaseModel):
    """Information about the page where element was captured."""

    url: str = Field(..., description="Page URL")
    title: Optional[str] = Field(None, description="Page title")
    viewport: Optional[Dict[str, int]] = Field(
        None, description="Viewport dimensions {width, height}"
    )


class CapturedContext(BaseModel):
    """Complete context captured from browser."""

    element: CapturedElement = Field(..., description="The selected element")
    page: PageInfo = Field(..., description="Page information")
    ancestors: List[CapturedElement] = Field(
        default_factory=list, description="Parent elements (for context)"
    )
    timestamp: Optional[str] = Field(None, description="Capture timestamp")
    metadata: Dict[str, Any] = Field(
        default_factory=dict, description="Additional metadata"
    )
