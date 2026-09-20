import { migrate, isPostgres } from "./db";
import { createApp } from "./app";

async function main() {
  await migrate();

  const app = createApp();
  const PORT = process.env.PORT || 4000;

  app.listen(PORT, () => {
    console.log(`AfriCore (Phase 9) listening on :${PORT} [db: ${isPostgres ? "postgres" : "sqlite"}]`);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});