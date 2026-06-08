.PHONY: gh

gh:
	open "https://github.com/crvouga/vault/actions"

sync-dev-keys-to-prd:
	./scripts/sync-dev-keys-to-prd.sh

seed-vault-token:
	./scripts/seed-vault-token.sh