type IdentityChangeListener = (epoch: number) => void;

let identityChangeEpoch = 0;
const identityChangeListeners = new Set<IdentityChangeListener>();

export function getIdentityChangeEpoch(): number {
  return identityChangeEpoch;
}

export function advanceIdentityChangeEpoch(): number {
  identityChangeEpoch += 1;

  for (const listener of identityChangeListeners) {
    try {
      listener(identityChangeEpoch);
    } catch {
      // Identity persistence must not fail because cache invalidation did.
    }
  }

  return identityChangeEpoch;
}

export function onIdentityChange(listener: IdentityChangeListener): () => void {
  identityChangeListeners.add(listener);
  return () => identityChangeListeners.delete(listener);
}
