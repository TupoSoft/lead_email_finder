.PHONY: all help swagger
all: help
help:
	@echo "Available targets:"
	@echo "  swagger            Regenerate Swagger metadata"

swagger:
	corepack pnpm --filter @lead-email-finder-internal/verification-contracts build
	corepack pnpm --filter @tuposoft/lead-email-finder-api exec ts-node src/generate-metadata.ts
