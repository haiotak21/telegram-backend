import express from "express";
import { ok, fail } from "../utils/apiResponse";

const router = express.Router();

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const adminToken = process.env.ADMIN_API_TOKEN;
  if (!adminToken) return next();
  const provided = req.headers["x-admin-token"] as string | undefined;
  if (provided && provided === adminToken) return next();
  return fail(res, "Unauthorized", 401);
}

router.get("/ip", requireAdmin, async (_req, res) => {
  try {
    const response = await fetch("https://api.ipify.org?format=json");
    const data = (await response.json()) as { ip?: string };
    return ok(res, { ip: data?.ip });
  } catch {
    return fail(res, "Could not fetch IP", 500);
  }
});

export default router;
