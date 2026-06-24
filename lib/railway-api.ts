import { requireRailwayToken } from "./railway-token.js";

const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";

export type RailwayGraphQLError = {
  readonly message: string;
  readonly path?: readonly (string | number)[];
};

export class RailwayApiError extends Error {
  readonly errors: readonly RailwayGraphQLError[];

  constructor(message: string, errors: readonly RailwayGraphQLError[] = []) {
    super(message);
    this.name = "RailwayApiError";
    this.errors = errors;
  }
}

type GraphQLResponse<T> = {
  readonly data?: T;
  readonly errors?: readonly RailwayGraphQLError[];
};

type Edge<T> = { readonly node: T };
type Connection<T> = { readonly edges: readonly Edge<T>[] };

export type RailwayProject = {
  readonly id: string;
  readonly name: string;
  readonly environments: Connection<{ readonly id: string; readonly name: string }>;
  readonly services: Connection<{ readonly id: string; readonly name: string }>;
};

export type RailwayCustomDomain = {
  readonly id: string;
  readonly domain: string;
  readonly status: {
    readonly verificationToken?: string | null;
    readonly certificateStatus?: string | null;
    readonly dnsRecords?: readonly {
      readonly hostlabel: string;
      readonly requiredValue: string;
      readonly currentValue?: string | null;
      readonly status?: string | null;
      readonly recordType?: string | null;
      readonly fqdn?: string | null;
    }[] | null;
  };
};

export type RailwayDnsRecord = {
  readonly hostlabel: string;
  readonly requiredValue: string;
  readonly recordType: "CNAME" | "TXT";
  readonly fqdn: string;
};

export type RailwayProjectContext = {
  readonly projectId: string;
  readonly environmentId: string;
};

async function railwayRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const token = requireRailwayToken();
  const response = await fetch(RAILWAY_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await response.text();
  let payload: GraphQLResponse<T>;
  try {
    payload = JSON.parse(body) as GraphQLResponse<T>;
  } catch {
    throw new RailwayApiError(`Railway API HTTP ${response.status}: ${body.slice(0, 500)}`);
  }

  if (!response.ok) {
    const detail =
      payload.errors?.map((e) => e.message).join("; ") ||
      body.slice(0, 500);
    throw new RailwayApiError(`Railway API HTTP ${response.status}: ${detail}`, payload.errors ?? []);
  }

  if (payload.errors?.length) {
    throw new RailwayApiError(
      payload.errors.map((e) => e.message).join("; "),
      payload.errors,
    );
  }
  if (!payload.data) {
    throw new RailwayApiError("Railway API returned no data");
  }
  return payload.data;
}

function nodes<T>(connection: Connection<T> | null | undefined): readonly T[] {
  return connection?.edges?.map((edge) => edge.node) ?? [];
}

export async function listProjects(): Promise<readonly { readonly id: string; readonly name: string }[]> {
  const data = await railwayRequest<{
    projects: Connection<{ readonly id: string; readonly name: string }>;
  }>(`
    query projects {
      projects {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  `);
  return nodes(data.projects);
}

export async function getProject(projectId: string): Promise<RailwayProject> {
  const data = await railwayRequest<{ project: RailwayProject }>(
    `
    query project($id: String!) {
      project(id: $id) {
        id
        name
        environments {
          edges {
            node {
              id
              name
            }
          }
        }
        services {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  `,
    { id: projectId },
  );
  return data.project;
}

export async function findProjectByName(name: string): Promise<RailwayProject | undefined> {
  const projects = await listProjects();
  const match = projects.find((p) => p.name === name);
  if (!match) return undefined;
  return getProject(match.id);
}

export async function createProject(name: string): Promise<RailwayProject> {
  const data = await railwayRequest<{ projectCreate: { readonly id: string } }>(
    `
    mutation projectCreate($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        id
      }
    }
  `,
    { input: { name } },
  );
  return getProject(data.projectCreate.id);
}

export async function ensureProject(name: string): Promise<RailwayProject> {
  const existing = await findProjectByName(name);
  if (existing) return existing;
  return createProject(name);
}

export function resolveEnvironment(
  project: RailwayProject,
  environmentName: string,
): { readonly id: string; readonly name: string } {
  const envs = nodes(project.environments);
  const match = envs.find((e) => e.name === environmentName);
  if (!match) {
    throw new RailwayApiError(
      `Environment "${environmentName}" not found in project "${project.name}" (have: ${envs.map((e) => e.name).join(", ")})`,
    );
  }
  return match;
}

export function findServiceByName(
  project: RailwayProject,
  serviceName: string,
): { readonly id: string; readonly name: string } | undefined {
  return nodes(project.services).find((s) => s.name === serviceName);
}

export async function createServiceFromImage(input: {
  readonly projectId: string;
  readonly name: string;
  readonly image: string;
  readonly variables?: Record<string, string>;
}): Promise<{ readonly id: string; readonly name: string }> {
  const data = await railwayRequest<{
    serviceCreate: { readonly id: string; readonly name: string };
  }>(
    `
    mutation serviceCreate($input: ServiceCreateInput!) {
      serviceCreate(input: $input) {
        id
        name
      }
    }
  `,
    {
      input: {
        projectId: input.projectId,
        name: input.name,
        source: { image: input.image },
        variables: input.variables ?? {},
      },
    },
  );
  return data.serviceCreate;
}

export async function ensureServiceFromImage(input: {
  readonly project: RailwayProject;
  readonly name: string;
  readonly image: string;
  readonly variables?: Record<string, string>;
}): Promise<{ readonly id: string; readonly name: string }> {
  const existing = findServiceByName(input.project, input.name);
  if (existing) return existing;
  return createServiceFromImage({
    projectId: input.project.id,
    name: input.name,
    image: input.image,
    variables: input.variables,
  });
}

export async function updateServiceInstance(input: {
  readonly serviceId: string;
  readonly environmentId: string;
  readonly healthcheckPath?: string | null;
  readonly sleepApplication?: boolean;
  readonly region?: string;
  readonly numReplicas?: number;
  readonly registryCredentials?: { readonly username: string; readonly password: string };
}): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (input.healthcheckPath !== undefined) patch.healthcheckPath = input.healthcheckPath;
  if (input.sleepApplication != null) patch.sleepApplication = input.sleepApplication;
  if (input.region) patch.region = input.region;
  if (input.numReplicas != null) patch.numReplicas = input.numReplicas;
  if (input.registryCredentials) patch.registryCredentials = input.registryCredentials;

  await railwayRequest<{ serviceInstanceUpdate: boolean }>(
    `
    mutation serviceInstanceUpdate(
      $serviceId: String!
      $environmentId: String!
      $input: ServiceInstanceUpdateInput!
    ) {
      serviceInstanceUpdate(
        serviceId: $serviceId
        environmentId: $environmentId
        input: $input
      )
    }
  `,
    {
      serviceId: input.serviceId,
      environmentId: input.environmentId,
      input: patch,
    },
  );
}

export async function connectServiceImage(serviceId: string, image: string): Promise<void> {
  await railwayRequest<{ serviceConnect: { readonly id: string } }>(
    `
    mutation serviceConnect($id: String!, $input: ServiceConnectInput!) {
      serviceConnect(id: $id, input: $input) {
        id
      }
    }
  `,
    {
      id: serviceId,
      input: { image },
    },
  );
}

export async function upsertVariables(input: {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId?: string;
  readonly variables: Record<string, string>;
  readonly replace?: boolean;
  readonly skipDeploys?: boolean;
}): Promise<void> {
  await railwayRequest<{ variableCollectionUpsert: boolean }>(
    `
    mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }
  `,
    {
      input: {
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
        variables: input.variables,
        replace: input.replace ?? false,
        skipDeploys: input.skipDeploys ?? true,
      },
    },
  );
}

export async function deployService(serviceId: string, environmentId: string): Promise<string> {
  const data = await railwayRequest<{ serviceInstanceDeployV2: string }>(
    `
    mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
      serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
    }
  `,
    { serviceId, environmentId },
  );
  return data.serviceInstanceDeployV2;
}

export async function redeployService(serviceId: string, environmentId: string): Promise<void> {
  await railwayRequest<{ serviceInstanceRedeploy: boolean }>(
    `
    mutation serviceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
      serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
    }
  `,
    { serviceId, environmentId },
  );
}

const DOMAIN_STATUS_FIELDS = `
  verificationToken
  certificateStatus
  dnsRecords {
    hostlabel
    requiredValue
    currentValue
    status
    recordType
    fqdn
  }
`;

export async function createCustomDomain(input: {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly domain: string;
  readonly targetPort?: number;
}): Promise<RailwayCustomDomain> {
  const data = await railwayRequest<{ customDomainCreate: RailwayCustomDomain }>(
    `
    mutation customDomainCreate($input: CustomDomainCreateInput!) {
      customDomainCreate(input: $input) {
        id
        domain
        status {
          ${DOMAIN_STATUS_FIELDS}
        }
      }
    }
  `,
    { input },
  );
  return data.customDomainCreate;
}

export async function getCustomDomain(
  customDomainId: string,
  projectId: string,
): Promise<RailwayCustomDomain> {
  const data = await railwayRequest<{ customDomain: RailwayCustomDomain }>(
    `
    query customDomain($id: String!, $projectId: String!) {
      customDomain(id: $id, projectId: $projectId) {
        id
        domain
        status {
          ${DOMAIN_STATUS_FIELDS}
        }
      }
    }
  `,
    { id: customDomainId, projectId },
  );
  return data.customDomain;
}

export async function listCustomDomains(input: {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
}): Promise<readonly RailwayCustomDomain[]> {
  const data = await railwayRequest<{
    domains: { readonly customDomains: readonly RailwayCustomDomain[] };
  }>(
    `
    query domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
      domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
        customDomains {
          id
          domain
          status {
            ${DOMAIN_STATUS_FIELDS}
          }
        }
      }
    }
  `,
    input,
  );
  return data.domains.customDomains;
}

export async function ensureCustomDomain(input: {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly domain: string;
  readonly targetPort?: number;
}): Promise<RailwayCustomDomain> {
  const existing = await listCustomDomains(input);
  const match = existing.find((d) => d.domain === input.domain);
  if (match) return match;
  return createCustomDomain(input);
}

export function isCustomDomainCertificateReady(status: string | null | undefined): boolean {
  const normalized = status?.toUpperCase() ?? "";
  return normalized === "CERTIFICATE_STATUS_TYPE_VALID" || normalized === "ISSUED";
}

export function railwayDnsRecords(
  domain: RailwayCustomDomain,
  zone: string,
): readonly RailwayDnsRecord[] {
  const records: RailwayDnsRecord[] = [];
  const token = domain.status.verificationToken?.trim();

  for (const record of domain.status.dnsRecords ?? []) {
    const hostlabel = record.hostlabel?.trim() || "@";
    const requiredValue = record.requiredValue?.trim();
    if (!requiredValue) continue;

    const typeRaw = record.recordType?.toUpperCase() ?? "";
    const recordType: "CNAME" | "TXT" =
      typeRaw.includes("TXT") || requiredValue.startsWith("railway-verify=") ? "TXT" : "CNAME";

    const fqdn =
      record.fqdn?.trim() ||
      (hostlabel === "@" || hostlabel === domain.domain
        ? domain.domain
        : hostlabel.includes(".")
          ? hostlabel
          : `${hostlabel}.${zone}`);

    records.push({ hostlabel, requiredValue, recordType, fqdn });
  }

  if (token && !records.some((r) => r.recordType === "TXT")) {
    records.push({
      hostlabel: `_railway-verify.${domain.domain}`,
      requiredValue: token,
      recordType: "TXT",
      fqdn: `_railway-verify.${domain.domain}`,
    });
  }

  return records;
}

export async function createVolume(input: {
  readonly projectId: string;
  readonly serviceId: string;
  readonly environmentId: string;
  readonly mountPath: string;
  readonly region?: string;
}): Promise<{ readonly id: string; readonly name: string }> {
  const data = await railwayRequest<{ volumeCreate: { readonly id: string; readonly name: string } }>(
    `
    mutation volumeCreate($input: VolumeCreateInput!) {
      volumeCreate(input: $input) {
        id
        name
      }
    }
  `,
    {
      input: {
        projectId: input.projectId,
        serviceId: input.serviceId,
        environmentId: input.environmentId,
        mountPath: input.mountPath,
        region: input.region,
      },
    },
  );
  return data.volumeCreate;
}

export async function listVolumeMounts(input: {
  readonly projectId: string;
  readonly serviceId: string;
}): Promise<readonly { readonly id: string; readonly mountPath: string }[]> {
  const data = await railwayRequest<{
    project: {
      volumes: Connection<{
        id: string;
        volumeInstances: Connection<{ id: string; mountPath: string; serviceId: string }>;
      }>;
    };
  }>(
    `
    query projectVolumeMounts($projectId: String!) {
      project(id: $projectId) {
        volumes {
          edges {
            node {
              id
              volumeInstances {
                edges {
                  node {
                    id
                    mountPath
                    serviceId
                  }
                }
              }
            }
          }
        }
      }
    }
  `,
    { projectId: input.projectId },
  );

  const mounts: { readonly id: string; readonly mountPath: string }[] = [];
  for (const volume of nodes(data.project.volumes)) {
    for (const instance of nodes(volume.volumeInstances)) {
      if (instance.serviceId !== input.serviceId) continue;
      mounts.push({ id: instance.id, mountPath: instance.mountPath });
    }
  }
  return mounts;
}

/** @deprecated Use listVolumeMounts */
export async function listVolumes(input: {
  readonly projectId: string;
  readonly serviceId: string;
}): Promise<readonly { readonly id: string; readonly name: string; readonly mountPath?: string }[]> {
  const mounts = await listVolumeMounts(input);
  return mounts.map((mount) => ({ id: mount.id, name: mount.mountPath, mountPath: mount.mountPath }));
}

export async function ensureVolume(input: {
  readonly projectId: string;
  readonly serviceId: string;
  readonly environmentId: string;
  readonly mountPath: string;
  readonly name: string;
  readonly region?: string;
}): Promise<void> {
  const existing = await listVolumeMounts({
    projectId: input.projectId,
    serviceId: input.serviceId,
  });
  if (existing.some((v) => v.mountPath === input.mountPath)) {
    return;
  }
  await createVolume(input);
}

export async function resolveProjectContext(
  projectName: string,
  environmentName: string,
): Promise<RailwayProjectContext & { readonly project: RailwayProject }> {
  const project = await ensureProject(projectName);
  const environment = resolveEnvironment(project, environmentName);
  return {
    project,
    projectId: project.id,
    environmentId: environment.id,
  };
}

export async function waitForDeployment(
  deploymentId: string,
  timeoutMs = 600_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await railwayRequest<{
      deployment: { readonly status: string } | null;
    }>(
      `
      query deployment($id: String!) {
        deployment(id: $id) {
          status
        }
      }
    `,
      { id: deploymentId },
    );
    const status = data.deployment?.status?.toUpperCase() ?? "";
    if (status === "SUCCESS") return;
    if (status === "FAILED" || status === "CRASHED" || status === "REMOVED") {
      throw new RailwayApiError(`Deployment ${deploymentId} ended with status ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new RailwayApiError(`Deployment ${deploymentId} did not succeed within ${timeoutMs / 1000}s`);
}

export async function deleteService(serviceId: string): Promise<void> {
  await railwayRequest<{ serviceDelete: boolean }>(
    `
    mutation serviceDelete($id: String!) {
      serviceDelete(id: $id)
    }
  `,
    { id: serviceId },
  );
}

export async function deleteProject(projectId: string): Promise<void> {
  await railwayRequest<{ projectDelete: boolean }>(
    `
    mutation projectDelete($id: String!) {
      projectDelete(id: $id)
    }
  `,
    { id: projectId },
  );
}
