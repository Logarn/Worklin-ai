import { createPublicEdgeRouter } from "./public-edge-router.js";

const port = Number(process.env.WORKLIN_PUBLIC_EDGE_PORT ?? process.env.PORT ?? 8080);
const host = process.env.WORKLIN_PUBLIC_EDGE_HOST ?? "0.0.0.0";
const controlPlaneUrl =
  process.env.WORKLIN_CONTROL_PLANE_INTERNAL_URL ?? "http://127.0.0.1:8082";
const gatewayUrl = process.env.WORKLIN_GATEWAY_URL ?? "http://127.0.0.1:7830";

const server = createPublicEdgeRouter({ controlPlaneUrl, gatewayUrl });
server.listen(port, host, () => {
  console.log(`Worklin public edge listening on ${host}:${port}`);
});
