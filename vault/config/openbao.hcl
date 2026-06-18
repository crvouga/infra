# OpenBao server configuration for Docker deployment.
# Connection URL is provided via BAO_PG_CONNECTION_URL (set from DB_CONNECTION_URI by entrypoint).
# API address is provided via BAO_API_ADDR (set by infra compose / services.yaml).

storage "postgresql" {
  table             = "vault_kv_store"
  ha_table          = "vault_ha_locks"
  skip_create_table = true
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

ui             = true
disable_mlock  = true
