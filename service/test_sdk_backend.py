#!/usr/bin/env python
"""Quick integration test for Claude Agent SDK backend."""

import asyncio
import sys
from pathlib import Path

# Add src to path for imports
sys.path.insert(0, str(Path(__file__).parent / "src"))

from ui_chatter.backends import create_backend
from ui_chatter.models.context import CapturedContext, CapturedElement, PageInfo


async def test_backend():
    """Test the Claude Agent SDK backend with a simple query."""

    print("🧪 Testing Claude Agent SDK Backend\n")

    # Create backend instance
    print("1. Creating backend instance...")
    try:
        backend = create_backend(
            backend_type="claude-agent-sdk",
            project_path=".",
            permission_mode="bypassPermissions"
        )
        print(f"   ✓ Backend created: {type(backend).__name__}")
        print(f"   ✓ Permission mode: {backend.permission_mode}")
        print(f"   ✓ Allowed tools: {backend.allowed_tools}\n")
    except Exception as e:
        print(f"   ✗ Failed to create backend: {e}")
        return False

    # Create test context
    print("2. Creating test context...")
    context = CapturedContext(
        element=CapturedElement(
            tagName="button",
            id="test-button",
            classList=["btn", "btn-primary"],
            textContent="Click me",
            attributes={"type": "button"}
        ),
        page=PageInfo(
            url="https://example.com/test",
            title="Test Page"
        )
    )
    print("   ✓ Context created\n")

    # Test simple query
    print("3. Sending test message...")
    print("   Message: 'Say hello in one word'\n")

    try:
        chunks = []
        async for chunk in backend.handle_chat(
            context=context,
            message="Say hello in one word",
            screenshot_path=None
        ):
            chunks.append(chunk)

            if chunk.get("type") == "response_chunk":
                content = chunk.get("content", "")
                done = chunk.get("done", False)

                if content:
                    print(f"   📝 Chunk: {content[:50]}{'...' if len(content) > 50 else ''}")

                if done:
                    print("\n   ✓ Response complete")

            elif chunk.get("type") == "error":
                print(f"\n   ✗ Error: {chunk.get('code')} - {chunk.get('message')}")
                return False

        # Verify we got chunks
        if not chunks:
            print("   ✗ No response chunks received")
            return False

        # Count chunks
        response_chunks = [c for c in chunks if c.get("type") == "response_chunk" and c.get("content")]
        print(f"   ✓ Received {len(response_chunks)} content chunks")

        return True

    except Exception as e:
        print(f"\n   ✗ Error during chat: {e}")
        import traceback
        traceback.print_exc()
        return False


async def main():
    """Run the test."""
    print("=" * 60)
    print("Claude Agent SDK Backend Integration Test")
    print("=" * 60)
    print()

    success = await test_backend()

    print()
    print("=" * 60)
    if success:
        print("✅ Test PASSED - Backend is working correctly!")
    else:
        print("❌ Test FAILED - See errors above")
    print("=" * 60)

    return 0 if success else 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
