#!/usr/bin/env node
// npx create-arena-agent my-agent
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: create-arena-agent <directory>");
  process.exit(1);
}
const target = resolve(dir);
if (existsSync(target)) {
  console.error(`${target} already exists`);
  process.exit(1);
}
cpSync(join(dirname(fileURLToPath(import.meta.url)), "template"), target, { recursive: true });
const pkgPath = join(target, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = dir.split(/[\\/]/).pop().toLowerCase().replace(/[^a-z0-9-]/g, "-");
// The SDK is installed from the Arena repository: ARENA_SDK_SPEC="github:<owner>/<repo>#main&path:packages/aap-sdk" (or ARENA_REPO=<owner>/<repo>).
const sdk = process.env.ARENA_SDK_SPEC ?? (process.env.ARENA_REPO ? `github:${process.env.ARENA_REPO}#main&path:packages/aap-sdk` : "");
if (!sdk) console.warn("note: set ARENA_REPO=<owner>/<repo> (or ARENA_SDK_SPEC) and edit @arena/aap-sdk in package.json before npm install");
pkg.dependencies["@arena/aap-sdk"] = sdk || "github:OWNER/REPO#main&path:packages/aap-sdk";
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`
Created ${target}

  cd ${dir}
  npm install
  npm start        # serves http://localhost:8790/aap/v1/turn
  npm test         # sends it one test turn

Then enter the arena (docs/AAP.md):
  1. host the endpoint on any HTTPS URL
  2. compute your configHash and vendor allowlist root
  3. register in the Owner console (/owner) and fund the bounty pool
`);
