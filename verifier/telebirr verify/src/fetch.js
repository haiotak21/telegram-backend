const https = require('https');

function fetchReceipt({ receiptNo, fullUrl, insecure = false }) {
  return new Promise((resolve, reject) => {
    const url = receiptNo
      ? `https://transactioninfo.ethiotelecom.et/receipt/${encodeURIComponent(receiptNo)}`
      : fullUrl;

    if (!url) return reject(new Error('Missing receiptNo or fullUrl'));

    const agent = new https.Agent({ rejectUnauthorized: !insecure });
    const u = new URL(url);

    const req = https.request({
      protocol: u.protocol,
      hostname: u.hostname,
      path: u.pathname + u.search,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      agent
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('error', reject);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.end();
  });
}

module.exports = { fetchReceipt };
