const htmlparser2 = require("htmlparser2");

function normalizeLabel(s) {
  return String(s)
    .toLowerCase()
    .replace(/[\n\r\t]/g, "")
    .replace(/\s+/g, "")
    .replace(/[.:]/g, "");
}

function cleanText(s) {
  return String(s)
    .replace(/[\n\r\t]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const FIELD_MAP = [
  { labels: ["የከፋይስም/payername", "payername"], key: "payer_name" },
  {
    labels: ["የከፋይቴሌብርቁ/payertelebirrno", "payertelebirrno"],
    key: "payer_phone",
  },
  {
    labels: ["የከፋይአካውንትአይነት/payeraccounttype", "payeraccounttype"],
    key: "payer_acc_type",
  },
  {
    labels: ["የገንዘብተቀባይስም/creditedpartyname", "creditedpartyname"],
    key: "credited_party_name",
  },
  {
    labels: ["የገንዘብተቀባይቴሌብርቁ/creditedpartyaccountno", "creditedpartyaccountno"],
    key: "credited_party_acc_no",
  },
  {
    labels: ["የክፍያውሁኔታ/transactionstatus", "transactionstatus"],
    key: "transaction_status",
  },
  {
    labels: ["የባንክአካውንትቁጥር/bankaccountnumber", "bankaccountnumber"],
    key: "bank_acc_no",
  },
  { labels: ["የክፍያቁጥር/receiptno", "receiptno"], key: "receiptNo" },
  { labels: ["የክፍያቀን/paymentdate", "paymentdate"], key: "date" },
  {
    labels: ["የተከፈለውመጠን/settledamount", "settledamount"],
    key: "settled_amount",
  },
  { labels: ["ቅናሽ/discountamount", "discountamount"], key: "discount_amount" },
  { labels: ["15%ቫት/vat", "vat"], key: "vat_amount" },
  { labels: ["servicefee", "የአገልግሎትክፍያ/servicefee"], key: "service_fee" },
  {
    labels: ["servicefeevat", "15%vatonservicefee", "15%vatonservicefee/vat"],
    key: "service_fee_vat",
  },
  {
    labels: ["ጠቅላላየተክፈለ/totalamountpaid", "totalamountpaid"],
    key: "total_amount",
  },
  {
    labels: ["የገንዘቡልክበፊደል/totalamountinword", "totalamountinword"],
    key: "amount_in_word",
  },
  { labels: ["የክፍያዘዴ/paymentmode", "paymentmode"], key: "payment_mode" },
  {
    labels: ["የክፍያምክንያት/paymentreason", "paymentreason"],
    key: "payment_reason",
  },
  {
    labels: ["የክፍያመንገድ/paymentchannel", "paymentchannel"],
    key: "payment_channel",
  },
];

function parseReceiptHTML(html, opts = {}) {
  const document = htmlparser2.parseDocument(html);
  const tds = htmlparser2.DomUtils.getElementsByTagName("td", document);
  const fields = {};
  const allText = cleanText(htmlparser2.DomUtils.textContent(document));

  function getCellText(i) {
    if (i < 0 || i >= tds.length) return "";
    return cleanText(htmlparser2.DomUtils.textContent(tds[i]));
  }

  function findRowNode(node) {
    let cur = node;
    while (cur && cur.name !== "tr") {
      cur = cur.parent || cur.parentNode;
    }
    return cur || null;
  }

  function getRowCells(row) {
    if (!row || !Array.isArray(row.children)) return [];
    return row.children.filter((n) => n && n.type === "tag" && n.name === "td");
  }

  function getNextValue(i) {
    const node = tds[i];
    const row = findRowNode(node);
    const rowCells = getRowCells(row);
    const idxInRow = rowCells.indexOf(node);
    if (idxInRow >= 0) {
      for (let j = idxInRow + 1; j < rowCells.length; j++) {
        const v = cleanText(htmlparser2.DomUtils.textContent(rowCells[j]));
        const maybeLabel = normalizeLabel(v);
        if (v && !labelLookup.has(maybeLabel)) return v;
      }
    }
    // Fallback to sequential cells if row structure isn't detected
    for (let k = i + 1; k < Math.min(tds.length, i + 5); k++) {
      const v = getCellText(k);
      const maybeLabel = normalizeLabel(v);
      if (v && !labelLookup.has(maybeLabel)) return v;
    }
    return "";
  }

  const labelLookup = new Map();
  for (const f of FIELD_MAP) {
    for (const raw of f.labels) {
      labelLookup.set(normalizeLabel(raw), f.key);
    }
  }

  for (let i = 0; i < tds.length; i++) {
    const label = normalizeLabel(getCellText(i));
    const key = labelLookup.get(label);
    if (!key) continue;

    let val = getNextValue(i);

    if (/amount$/i.test(key)) {
      const num = Number(
        String(val)
          .replace(/\b(?:birr|etb)\b/gi, "")
          .trim()
      );
      fields[key] = Number.isFinite(num) ? num : val;
    } else if (key === "bank_acc_no") {
      fields[key] = String(val).trim();
    } else {
      fields[key] = val;
    }
  }

  if (opts.receiptNo && !fields.receiptNo) {
    fields.receiptNo = String(opts.receiptNo);
  }

  if (fields.credited_party_name && !fields.to) {
    fields.to = fields.credited_party_name;
  }

  // Fallback heuristics for date and settled_amount
  if (
    !fields.date ||
    !/\b\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2}\b/.test(fields.date)
  ) {
    const m = allText.match(/\b(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})\b/);
    if (m) fields.date = m[1];
  }

  if (typeof fields.settled_amount !== "number") {
    const idx = allText.toLowerCase().indexOf("settled amount");
    let segment = allText;
    if (idx >= 0)
      segment = allText.slice(idx, Math.min(allText.length, idx + 300));
    const mAmt = segment.match(/\b(\d+(?:\.\d+)?)\b\s*(birr|etb)\b/i);
    if (mAmt) {
      const num = Number(mAmt[1]);
      if (Number.isFinite(num)) fields.settled_amount = num;
    }
  }

  // Heuristics for service fee, VAT on service fee, and total paid amount
  if (typeof fields.service_fee !== "number") {
    const mFee = allText.match(
      /service\s*fee\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(etb|birr)?/i
    );
    if (mFee) {
      const num = Number(mFee[1]);
      if (Number.isFinite(num)) fields.service_fee = num;
    }
  }

  if (typeof fields.service_fee_vat !== "number") {
    const mVat = allText.match(
      /(?:15%\s*vat\s*(?:on\s*the\s*service\s*fee)?|vat\s*on\s*service\s*fee)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(etb|birr)?/i
    );
    if (mVat) {
      const num = Number(mVat[1]);
      if (Number.isFinite(num)) fields.service_fee_vat = num;
    }
  }

  if (typeof fields.total_amount !== "number") {
    const mTotal = allText.match(
      /total\s*paid\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(etb|birr)?/i
    );
    if (mTotal) {
      const num = Number(mTotal[1]);
      if (Number.isFinite(num)) fields.total_amount = num;
    }
  }

  return fields;
}

module.exports = { parseReceiptHTML };
