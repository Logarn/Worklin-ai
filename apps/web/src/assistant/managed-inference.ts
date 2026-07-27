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
  // A pinned profile whose connection row is unavailable is not proven
  // personal. Treat it as unavailable/managed so pickers fail closed while
  // connection inventory is loading or stale.
  return connection ? isManagedInferenceConnection(connection) : true;
}

export function profilesAvailableForManagedInference<
  T extends ManagedInferenceProfile,
>(
  profiles: readonly T[],
  connections: readonly ProviderConnection[],
  managedInferenceConfigured: boolean,
): T[] {
  if (managedInferenceConfigured) return [...profiles];
  return profiles.filter(
    (profile) => !isManagedInferenceProfile(profile, connections),
  );
}

export function connectionsAvailableForManagedInference(
  connections: readonly ProviderConnection[],
  managedInferenceConfigured: boolean,
): ProviderConnection[] {
  if (managedInferenceConfigured) return [...connections];
  return connections.filter(
    (connection) => !isManagedInferenceConnection(connection),
  );
}
