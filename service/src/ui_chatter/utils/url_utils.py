"""URL normalization utilities for session matching."""

from urllib.parse import urlparse, urlunparse


def normalize_url_for_matching(url: str) -> str:
    """
    Normalize URL to base URL for session matching.

    Strips:
    - Query parameters (?key=value)
    - Fragments (#hash)
    - Trailing slashes

    Preserves:
    - Scheme (http/https)
    - Domain
    - Path

    Example:
        https://app.com/page?tab=1#section
        -> https://app.com/page
    """
    if not url:
        return ""

    parsed = urlparse(url)

    # Normalize to https, drop query and fragment, strip trailing slash
    base_url = urlunparse((
        'https',  # Normalize scheme
        parsed.netloc,
        parsed.path.rstrip('/') if parsed.path else '',
        '',  # No params
        '',  # No query
        ''   # No fragment
    ))

    return base_url
