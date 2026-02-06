import express from "express";

const router = express.Router();

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const adminToken = process.env.ADMIN_API_TOKEN;
  if (!adminToken) return next();
  const provided = req.headers["x-admin-token"] as string | undefined;
  if (provided && provided === adminToken) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

router.get("/ip", requireAdmin, async (_req, res) => {
  try {
    const response = await fetch("https://api.ipify.org?format=json");
    const data = (await response.json()) as { ip?: string };
    return res.json({ ip: data?.ip });
  } catch {
    return res.status(500).json({ error: "Could not fetch IP" });
  }
});

export default router;
