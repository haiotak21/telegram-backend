import RuntimeConfig from "../models/RuntimeConfig";

export async function getFakeTopup(): Promise<boolean> {
  const doc = (await RuntimeConfig.findOne({ key: "FAKE_TOPUP" }).lean()) as any;
  if (doc) return !!doc.value;
  return process.env.FAKE_TOPUP === "true";
}

export async function setFakeTopup(value: boolean) {
  await RuntimeConfig.findOneAndUpdate({ key: "FAKE_TOPUP" }, { value }, { upsert: true, new: true });
}
