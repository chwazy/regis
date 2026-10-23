const SCCACHE_WRAPPER = /(^|[\\/])sccache(\.exe)?$/i;

export function sccacheState(env, onPath) {
  if (SCCACHE_WRAPPER.test(env.RUSTC_WRAPPER ?? '')) {
    return 'active';
  }
  return onPath ? 'installed-inactive' : 'absent';
}
