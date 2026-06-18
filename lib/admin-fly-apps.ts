import { flyOrg, flyRegion, loadServicesConfig, vaultAddr, type ServicesConfig } from "./services.js";

export type AdminFlyAppSpec = {
  readonly id: "pgweb" | "filestash";
  readonly flyApp: string;
  readonly hostname: string;
  readonly flyConfig: string;
  readonly deployTokenVaultKey: string;
  readonly deployTokenGhSecret: string;
  readonly runtimeFlySecrets: readonly string[];
  readonly volume?: {
    readonly name: string;
    readonly sizeGb: number;
  };
};

const PGWEB_APP = "pgweb-chrisvouga" as const;
const FILESTASH_APP = "filestash-chrisvouga" as const;

export function adminFlyApps(config: ServicesConfig = loadServicesConfig()): readonly AdminFlyAppSpec[] {
  const zone = config.zone;
  return [
    {
      id: "pgweb",
      flyApp: PGWEB_APP,
      hostname: `pgweb.${zone}`,
      flyConfig: "pgweb/fly.toml",
      deployTokenVaultKey: "FLY_API_TOKEN_PGWEB",
      deployTokenGhSecret: "FLY_API_TOKEN_PGWEB",
      runtimeFlySecrets: ["VAULT_ADDR", "VAULT_TOKEN", "PGWEB_AUTH_USER", "PGWEB_AUTH_PASS"],
    },
    {
      id: "filestash",
      flyApp: FILESTASH_APP,
      hostname: `filestash.${zone}`,
      flyConfig: "filestash/fly.toml",
      deployTokenVaultKey: "FLY_API_TOKEN_FILESTASH",
      deployTokenGhSecret: "FLY_API_TOKEN_FILESTASH",
      runtimeFlySecrets: ["VAULT_ADDR", "VAULT_TOKEN", "ADMIN_PASSWORD"],
      volume: { name: "filestash_data", sizeGb: 1 },
    },
  ];
}

export function findAdminFlyApp(
  id: string,
  config?: ServicesConfig,
): AdminFlyAppSpec | undefined {
  return adminFlyApps(config).find((app) => app.id === id);
}

export function adminFlyOrg(config: ServicesConfig = loadServicesConfig()): string {
  return flyOrg(config);
}

export function adminFlyRegion(config: ServicesConfig = loadServicesConfig()): string {
  return flyRegion(config);
}

export function adminVaultAddr(config: ServicesConfig = loadServicesConfig()): string {
  return vaultAddr(config);
}
