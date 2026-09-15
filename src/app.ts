import express from "express";
import { isPostgres } from "./db";
import businessRoutes from "./routes/businesses";
import consentRoutes from "./routes/consents";
import personRoutes from "./routes/persons";
import clientRoutes from "./routes/clients";
import businessDataRoutes from "./routes/businessData";
import webhookRoutes from "./routes/webhooks";
import { rateLimit } from "./middleware/rateLimit";

/**
 * Builds the Express app without binding a port, so tests can drive the
 * real HTTP stack (routing, auth middleware, consent gating, status
 * codes) in-process instead of shelling out to curl against a live
 * server. index.ts owns migrate() + listen(); this file owns wiring.
 */
export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(rateLimit);

  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  });

  app.get("/v1/health", (_req, res) =>
    res.json({ status: "ok", service: "africore", phase: 7, db_engine: isPostgres ? "postgres" : "sqlite" })
  );

  app.use("/v1/businesses", businessRoutes);
  app.use("/v1/businesses/:id", businessDataRoutes);
  app.use("/v1/persons", personRoutes);
  app.use("/v1/consents", consentRoutes);
  app.use("/v1/clients", clientRoutes);
  app.use("/v1/webhooks", webhookRoutes);

  app.use((req, res) => res.status(404).json({ error: "not_found", path: req.originalUrl }));

  return app;
}