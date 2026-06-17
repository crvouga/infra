.PHONY: gh sync-dns

gh:
	open "https://github.com/crvouga/vault/actions"

sync-dns:
	chmod +x scripts/sync-dns.sh
	./scripts/sync-dns.sh

sync-dev-keys-to-prd:
	./scripts/sync-dev-keys-to-prd.sh

seed-vault-token:
	./scripts/seed-vault-token.sh