import type { Response } from "express";

export function ok(res: Response, data: any, status = 200) {
  return res.status(status).json({ ok: true, data });
}

export function fail(res: Response, error: string, status = 400) {
  let errString: string;
  if (typeof error === "string") {
    errString = error;
  } else {
    try {
      errString = JSON.stringify(error);
    } catch {
      errString = String(error);
    }
  }
  return res.status(status).json({ ok: false, error: errString });
}
