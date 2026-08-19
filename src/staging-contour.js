// Compatibility shim. The audited Release C staging entrypoint lives in staging-contour-rc.js.
// Wrangler configs intentionally point directly to staging-contour-rc.js.
export { default } from "./staging-contour-rc.js";
export {
  OAuthStateDurableObject,
  RESOURCE_SCOPES,
  SUPPORTED_SCOPES,
  TOOL_CONTRACT,
} from "./staging-contour-rc.js";
