import type {
  ProfileEntry,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

interface ManagedInferenceProfile {
  source?: ProfileEntry["source"];
  provider_connection?: string | null;
}

export function isManagedInferenceConnection(
  connection: ProviderConnection,
): boolean {
  return connection.isManaged === true || connection.auth.type === "platform";
}

export function isManagedInferenceProfile(
  profile: ManagedInferenceProfile,
  connections: readonly ProviderConnection[] = [],
): boolean {
  if (profile.source === "managed") return true;
  if (!profile.provider_connection) return false;

  const connection = connections.find(
    (candidate) => candidate.name === profile.provider_connection,
  );
  return connection ? isManagedInferenceConnection(connection) : false;
}

export function profilesAvailableForManagedInference<
  T extends ManagedInferenceProfile,
>(
  profiles: readonly T[],
  connections: readonly ProviderConnection[],
  managedInferenceAvailable: boolean,
): T[] {
  if (managedInferenceAvailable) return [...profiles];
  return profiles.filter(
    (profile) => !isManagedInferenceProfile(profile, connections),
  );
}

export function connectionsAvailableForManagedInference(
  connections: readonly ProviderConnection[],
  managedInferenceAvailable: boolean,
): ProviderConnection[] {
  if (managedInferenceAvailable) return [...connections];
  return connections.filter(
    (connection) => !isManagedInferenceConnection(connection),
  );
}
