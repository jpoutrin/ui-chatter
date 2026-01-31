.PHONY: help test type-check mypy lint format clean install dev

help:  ## Show this help message
	@echo "UI Chatter Service - Development Commands"
	@echo ""
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

##@ Development

install:  ## Install dependencies
	uv sync

dev:  ## Install dev dependencies
	uv sync --extra dev

##@ Testing

test:  ## Run tests
	uv run pytest

test-cov:  ## Run tests with coverage
	uv run pytest --cov=src/ui_chatter --cov-report=html --cov-report=term

test-unit:  ## Run unit tests only
	uv run pytest -m unit

test-integration:  ## Run integration tests only
	uv run pytest -m integration

##@ Type Checking

type-check: mypy  ## Run type checking (alias for mypy)

mypy:  ## Run mypy type checker
	@echo "Running mypy type checker..."
	uv run mypy src/ui_chatter

mypy-strict:  ## Run mypy with stricter settings (for new modules)
	@echo "Running mypy in strict mode..."
	uv run mypy --strict src/ui_chatter

mypy-report:  ## Generate HTML type coverage report
	@echo "Generating mypy HTML report..."
	uv run mypy --html-report=.mypy_html src/ui_chatter
	@echo "Report generated at .mypy_html/index.html"

mypy-install-types:  ## Install missing type stubs
	uv run mypy --install-types --non-interactive

##@ Code Quality

lint:  ## Run ruff linter
	uv run ruff check src/ui_chatter tests

lint-fix:  ## Auto-fix linting issues
	uv run ruff check --fix src/ui_chatter tests

format:  ## Format code with black
	uv run black src/ui_chatter tests

format-check:  ## Check code formatting
	uv run black --check src/ui_chatter tests

##@ Service

run:  ## Run the service
	uv run ui-chatter

run-debug:  ## Run the service in debug mode
	uv run ui-chatter --debug

##@ Cleanup

clean:  ## Clean build artifacts and caches
	rm -rf .pytest_cache
	rm -rf .mypy_cache
	rm -rf .mypy_html
	rm -rf htmlcov
	rm -rf .coverage
	rm -rf dist
	rm -rf build
	rm -rf *.egg-info
	find . -type d -name __pycache__ -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete

clean-all: clean  ## Clean everything including venv
	rm -rf .venv

##@ CI/CD

ci:  ## Run all CI checks (type-check, lint, test)
	@echo "Running CI checks..."
	@make type-check
	@make lint
	@make test

pre-commit:  ## Run pre-commit checks (format, lint, type-check)
	@make format
	@make lint
	@make type-check
