```javascript
require('dotenv').config();
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SigningStargateClient } = require('@cosmjs/stargate');
const axios = require('axios');

// Environment variables
const XION_RPC_ENDPOINT    = process.env.XION_RPC_ENDPOINT;     // RPC endpoint Xion chain
const MNEMONIC             = process.env.MNEMONIC;              // Keplr-style mnemonic
const RECIPIENT_BABYLON    = process.env.RECIPIENT_BABYLON;     // address di Babylon chain
const AMOUNT_UXION         = process.env.AMOUNT_UXION || '1000'; // 1000 uxion = 0.001 XION
const CHANNEL_ID           = process.env.CHANNEL_ID || 'channel-7';
const TIMEOUT_SECONDS      = parseInt(process.env.TIMEOUT_SECONDS || '300'); // detik untuk timeout

// GraphQL Union polling (optional)
const GRAPHQL_ENDPOINT = 'https://graphql.union.build/v1/graphql';
const POLL_MAX_RETRIES = 50;
const POLL_INTERVAL_MS = 5000;

async function pollPacketHash(txHash) {
  const query = `
    query ($submission_tx_hash: String!) {
      v2_transfers(args: {p_transaction_hash: $submission_tx_hash}) {
        packet_hash
      }
    }
  `;
  const variables = { submission_tx_hash: txHash };
  const headers = { 'Content-Type': 'application/json' };

  for (let i = 0; i < POLL_MAX_RETRIES; i++) {
    try {
      const res = await axios.post(GRAPHQL_ENDPOINT, { query, variables }, { headers });
      const ph = res.data?.data?.v2_transfers?.[0]?.packet_hash;
      if (ph) {
        return { packetHash: ph, explorerUrl: `https://app.union.build/explorer/transfers/${ph}` };
      }
    } catch (e) {
      console.error(`Polling error ${i + 1}:`, e.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Timeout polling packet_hash');
}

async function main() {
  if (!XION_RPC_ENDPOINT || !MNEMONIC || !RECIPIENT_BABYLON) {
    console.error('Error: XION_RPC_ENDPOINT, MNEMONIC, and RECIPIENT_BABYLON must be set in .env');
    process.exit(1);
  }

  // Setup wallet & client
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'xion' });
  const [account] = await wallet.getAccounts();
  console.log('Sender address:', account.address);

  const client = await SigningStargateClient.connectWithSigner(XION_RPC_ENDPOINT, wallet);

  // Prepare IBC transfer amount & manual fee
  const amount = [{ denom: 'uxion', amount: AMOUNT_UXION }];
  const fee = { amount: [{ denom: 'uxion', amount: '200' }], gas: '200000' };

  console.log(`Sending IBC transfer of ${AMOUNT_UXION} uxion to ${RECIPIENT_BABYLON} via ${CHANNEL_ID}`);
  const timeoutTimestamp = Math.floor(Date.now() / 1000) + TIMEOUT_SECONDS;
  const result = await client.sendIbcTokens(
    account.address,
    RECIPIENT_BABYLON,
    amount,
    'transfer',
    CHANNEL_ID,
    timeoutTimestamp,
    fee
  );

  if (result.code !== 0) {
    console.error('IBC transfer failed:', result.rawLog);
    process.exit(1);
  }
  console.log('On-chain TX Hash:', result.transactionHash);

  // Optional: Poll GraphQL for Union packet_hash
  try {
    const { packetHash, explorerUrl } = await pollPacketHash(result.transactionHash);
    console.log('Packet Hash:', packetHash);
    console.log('Union Explorer URL:', explorerUrl);
  } catch (e) {
    console.error('Polling failed:', e.message);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
```
