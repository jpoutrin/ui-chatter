.PHONY: help install test test-watch test-coverage clean

help:  ## Show this help message
	@echo "UI Chatter Extension - Test Commands"
	@echo ""
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

##@ Setup

install:  ## Install dependencies
	npm install

##@ Testing

test:  ## Run all tests
	npm test

test-watch:  ## Run tests in watch mode
	npm run test:watch

test-coverage:  ## Run tests with coverage report
	npm run test:coverage

test-specific:  ## Run specific test file (usage: make test-specific FILE=background)
	npm test -- tests/$(FILE).test.js

##@ Code Quality

lint:  ## Run ESLint
	npm run lint

lint-fix:  ## Auto-fix linting issues
	npm run lint -- --fix

type-check:  ## Run TypeScript type checking
	npm run type-check

##@ Cleanup

clean:  ## Remove node_modules and coverage
	rm -rf node_modules coverage

clean-cache:  ## Clear Jest cache
	npx jest --clearCache

##@ Development

dev-setup: install  ## Complete development setup
	@echo "✓ Dependencies installed"
	@echo "✓ Run 'make test' to verify setup"

ci:  ## Run all CI checks
	@echo "Running CI checks..."
	@make lint
	@make test-coverage
	@echo "✓ All checks passed"
