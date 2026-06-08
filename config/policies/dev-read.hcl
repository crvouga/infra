# Read-only access to migrated Doppler secrets (KV v2 mount: doppler).
path "doppler/data/*" {
  capabilities = ["read"]
}

path "doppler/metadata/*" {
  capabilities = ["list", "read"]
}
