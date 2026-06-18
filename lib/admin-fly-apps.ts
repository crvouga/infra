import {
  flyAppName,
  flyOrg,
  flyRegion,
  loadServicesConfig,
  vaultAddr,
  type ServicesConfig,
} from "./services.js";

export type AdminFlyAppSpec = {
  readonly id: "pgweb" | "filestash";
  readonly flyApp: string;
  readonly hostname: string;
  readonly flyConfig: string;
  readonly volume?: {
    readonly name: string;
    readonly sizeGb: number;
  };
};

export function adminFlyApps(config: ServicesConfig = loadServicesConfig()): readonly AdminFlyAppSpec[] {
  const zone = config.zone;
  return [
    {
      id: "pgweb",
      flyApp: flyAppName(config, "pgweb"),
      hostname: `pgweb.${zone}`,
      flyConfig: "pgweb/fly.toml",
    },
    {
      id: "filestash",
      flyApp: flyAppName(config, "filestash"),
      hostname: `filestash.${zone}`,
      flyConfig: "filestash/fly.toml",
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

/** Hostnames managed by setup-pgweb-filestash — sync-dns must not prune them. */
export function adminFlyAppHostnames(
  config: ServicesConfig = loadServicesConfig(),
): readonly string[] {
  return adminFlyApps(config).map((app) => app.hostname);
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
