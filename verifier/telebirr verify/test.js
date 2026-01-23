const { createReceiptVerifier } = require("./src/index");
const { parseReceiptHTML } = require("./src/parser");
const { fetchReceipt } = require("./src/fetch");

(async () => {
  try {
    const receiptNo = "DAF1U26869";
    const html = await fetchReceipt({ receiptNo });
    const parsed = parseReceiptHTML(html, { receiptNo });
    console.log("Parsed:", parsed);
    const expected = { to: "Hayilemariyam Takele Mekonen" };
    const { verify, equals, verifyAll, verifyOnly } = createReceiptVerifier(parsed, expected);
    console.log("Receiver match:", verify((pf, ex) => equals(pf?.to, ex?.to)));
    console.log("Verify basic fields:", verifyOnly(["payer_name","credited_party_name","transaction_status","payment_mode"]));
  } catch (e) {
    console.error("Error:", e?.message || e);
    process.exit(1);
  }
})();
