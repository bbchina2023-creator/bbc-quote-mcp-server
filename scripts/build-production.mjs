import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STAGING_SOURCE = "src/staging.ts";
const OUTPUT = ".generated/production.ts";
const EXPECTED_STAGING_GIT_BLOB = "a998cb316209b696dec9ec180bf2cb176a9acac0";
const STAGING_ORIGIN = "https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev";
const PRODUCTION_ORIGIN = "https://bbc-quote-mcp-server.bbchina2023.workers.dev";

function gitBlobSha(content) {
  const size = Buffer.byteLength(content);
  return createHash("sha1").update(`blob ${size}\0`).update(content).digest("hex");
}

function replaceExactlyOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0) throw new Error(`${label}: expected source text not found`);
  if (source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`${label}: source text occurs more than once`);
  }
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

const staging = await readFile(STAGING_SOURCE, "utf8");
const stagingGitBlob = gitBlobSha(staging);
if (stagingGitBlob !== EXPECTED_STAGING_GIT_BLOB) {
  throw new Error(
    `Refusing production build: ${STAGING_SOURCE} is not the staging-tested blob. Expected ${EXPECTED_STAGING_GIT_BLOB}, got ${stagingGitBlob}`,
  );
}

let production = staging;
production = replaceExactlyOnce(
  production,
  'const SERVER_VERSION = "1.0.0-dev016.40-staging";',
  'const SERVER_VERSION = "1.0.0-dev016.40-production-rc2";',
  "SERVER_VERSION",
);
production = replaceExactlyOnce(
  production,
  `const MCP_ORIGIN = "${STAGING_ORIGIN}";`,
  `const MCP_ORIGIN = "${PRODUCTION_ORIGIN}";`,
  "MCP_ORIGIN",
);
production = replaceExactlyOnce(
  production,
  'environment: "staging",',
  'environment: "production",',
  "health environment",
);

if (production.includes(STAGING_ORIGIN)) {
  throw new Error("Refusing production build: staging Worker origin remains in generated source");
}
if (production.includes('environment: "staging"')) {
  throw new Error("Refusing production build: staging environment marker remains in generated source");
}

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, production, "utf8");

const generatedSha256 = createHash("sha256").update(production).digest("hex");
console.log(`Production source generated from staging-tested blob ${stagingGitBlob}`);
console.log(`Production origin: ${PRODUCTION_ORIGIN}`);
console.log(`Generated SHA-256: ${generatedSha256}`);
