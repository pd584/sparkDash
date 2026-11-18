import { getSettings } from "../settings.js";
import { createOccupancyPoller } from "./poller.js";
import { registerOccupancyRoutes } from "./routes.js";
import { createTailnetPeersService } from "../tailnet/peersService.js";

/** Dashboard-side owner of helper polling. Bridges stay on the helper host. */
export function createOccupancyRuntime({ listSparks } = {}) {
  const poller = createOccupancyPoller({
    listSparks,
    maxAgeMs: () => getSettings().occupancyMaxAgeMs,
  });
  const tailnet = createTailnetPeersService({ listSparks });
  return {
    poller,
    tailnet,
    start() {
      poller.start();
      // Warm the peer map so first paint already resolves names.
      void tailnet.refresh();
    },
    async stop() {
      await poller.stop();
    },
    projection() {
      return poller.projection();
    },
    register(app) {
      registerOccupancyRoutes(app, { poller, listSparks, tailnet });
    },
  };
}
