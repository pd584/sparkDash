/** Keep harness configuration, but never give a child the helper's HTTP bearer. */
export function adapterEnv() {
  const env = { ...process.env };
  delete env.OCCUPANCY_TOKEN;
  return env;
}
