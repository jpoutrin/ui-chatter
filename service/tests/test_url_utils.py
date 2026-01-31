"""Tests for URL normalization utilities."""

import pytest
from ui_chatter.utils.url_utils import normalize_url_for_matching


def test_normalize_url_strips_query():
    """Query parameters should be stripped."""
    url = "https://app.com/page?tab=settings&view=grid"
    assert normalize_url_for_matching(url) == "https://app.com/page"


def test_normalize_url_strips_fragment():
    """Fragment (#hash) should be stripped."""
    url = "https://app.com/page#section1"
    assert normalize_url_for_matching(url) == "https://app.com/page"


def test_normalize_url_strips_trailing_slash():
    """Trailing slash should be stripped."""
    url = "https://app.com/page/"
    assert normalize_url_for_matching(url) == "https://app.com/page"


def test_normalize_url_preserves_path():
    """Multi-segment paths should be preserved."""
    url = "https://app.com/dashboard/settings"
    assert normalize_url_for_matching(url) == "https://app.com/dashboard/settings"


def test_normalize_url_strips_all_extras():
    """Query, fragment, and trailing slash should all be stripped."""
    url = "https://app.com/page/?tab=1#section"
    assert normalize_url_for_matching(url) == "https://app.com/page"


def test_normalize_url_normalizes_to_https():
    """HTTP should be normalized to HTTPS."""
    url = "http://app.com/page"
    assert normalize_url_for_matching(url) == "https://app.com/page"


def test_normalize_url_handles_empty():
    """Empty URL should return empty string."""
    assert normalize_url_for_matching("") == ""
    assert normalize_url_for_matching(None) == ""


def test_normalize_url_preserves_domain():
    """Domain should be preserved exactly."""
    url = "https://subdomain.example.com/path"
    assert normalize_url_for_matching(url) == "https://subdomain.example.com/path"


def test_normalize_url_handles_root():
    """Root URL should work correctly."""
    url = "https://example.com/"
    assert normalize_url_for_matching(url) == "https://example.com"


def test_normalize_url_complex_query():
    """Complex query strings should be fully stripped."""
    url = "https://app.com/search?q=test&page=2&sort=date&filter[]=active&filter[]=new"
    assert normalize_url_for_matching(url) == "https://app.com/search"
