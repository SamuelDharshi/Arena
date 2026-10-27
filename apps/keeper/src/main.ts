import { getDb, isEmbedded } from "@arena/db";
import { startKeeper } from "./index";

if (isEmbedded()) {
  console.error(
    "Standalone keeper needs a shared Postgres (set DATABASE_URL). With the embedded DB the keeper runs inside the gateway.",
  );
  process.exit(1);
}
await startKeeper(await getDb());
