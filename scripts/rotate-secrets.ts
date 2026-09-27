import { closeDb } from "../src/db";
import { reencryptAllSecrets } from "../src/server/secrets-rotation";

reencryptAllSecrets()
  .then(async (res) => {
    console.log(`Re-encrypted ${res.rotated} of ${res.total} stored secrets with the current key.`);
    await closeDb();
  })
  .catch(async (err: unknown) => {
    console.error("Rotation failed:", err instanceof Error ? err.message : err);
    await closeDb();
    process.exit(1);
  });
