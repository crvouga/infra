.PHONY: gh sync-dns sync-dev-keys-to-prd seed-vault-token \
	clone-b2-from-legacy alias-s3-from-b2 check-object-storage \
	check-database-url clone-prod-db-to-dev

gh:
	open "https://github.com/crvouga/vault/actions"

sync-dns:
	chmod +x scripts/sync-dns.sh
	./scripts/sync-dns.sh

sync-dev-keys-to-prd:
	./scripts/sync-dev-keys-to-prd.sh

seed-vault-token:
	./scripts/seed-vault-token.sh

clone-b2-from-legacy:
	./scripts/vault-run.sh -- ./scripts/clone-b2-bucket-from-legacy.sh

alias-s3-from-b2:
	./scripts/vault-run.sh -- ./scripts/create-s3-secrets-from-b2.sh --dry-run

check-object-storage:
	./scripts/vault-run.sh -- ./scripts/check-object-storage-creds.sh

check-database-url:
	./scripts/vault-run.sh -- ./scripts/check-database-url-health.sh

clone-prod-db-to-dev:
	./scripts/vault-run.sh -- ./scripts/clone-prod-database-to-dev.sh