# Arena — common entry points (see README.md)
.PHONY: install test demo dev go-live status

install:
	pnpm install

test:
	cd contracts && forge test

# Local end-to-end harness: anvil + test token + deploy + seed, then all services (web http://localhost:3000)
demo:
	pnpm local:up
	pnpm dev:local

# Arc testnet: waits for faucet funding + Anthropic key, then deploys, seeds and smoke-tests
go-live:
	pnpm go-live

dev:
	pnpm dev

status:
	pnpm status
