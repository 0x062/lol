require('dotenv').config();
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SigningStargateClient } = require('@cosmjs/stargate');
const axios = require('axios');

// Environment variables
const XION_RPC_ENDPOINT = process.env.XION_RPC_ENDPOINT;
const MNEMONIC = process.env.MNEMONIC;
const RECIPIENT_BABYLON = process.env.RECIPIENT_BABYLON;
const AMOUNT_UXION = process.env.AMOUNT_UXION || '1000';
const PORT_ID = process.env.PORT_ID || 'transfer';
const CHANNEL_ID = process.env.CHANNEL_ID || '7';
const TIMEOUT_SECONDS = parseInt(process.env.TIMEOUT_SECONDS || '300', 10);

// Union GraphQL polling config
typeof GRAPHQL_ENDPOINT;
const GRAPHQL_ENDPOINT = 'https://graphql.union.build/v1/graphql';
const POLL_MAX_RETRIES = 50;
const POLL_INTERVAL_MS = 5000;

/**
 * Poll Union GraphQL endpoint for packet_hash
 */
async function pollPacketHash(txHash) {
  const query = `
    query($submission_tx_hash:String!) {
      v2_transfers(args:{p_transaction_hash:$submission_tx_hash}) {
        packet_hash
      }
    }
  `;
  const variables = { submission_tx_hash: txHash };
  const headers = { 'Content-Type': 'application/json' };

  for (let i = 0; i < POLL_MAX_RETRIES; i++) {
    console.log(`Polling Union ${i+1}/${POLL_MAX_RETRIES}...`);
    try {
      const res = await axios.post(
        GRAPHQL_ENDPOINT,
        { query, variables },
        { headers }
      );
      const ph = res.data?.data?.v2_transfers?.[0]?.packet_hash;
      if (ph) {
        return {
          packetHash: ph,
          explorerUrl: `https://app.union.build/explorer/transfers/${ph}`
        };
      }
    } catch (err) {
      console.log('Polling error:', err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Polling packet_hash timeout');
}

/**
 * Retry helper for broadcasting
 */
async function sendWithRetry(fn, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.log(`Broadcast attempt ${attempt} failed: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function main() {
  if (!XION_RPC_ENDPOINT || !MNEMONIC || !RECIPIENT_BABYLON) {
    console.error('Missing required ENV vars: XION_RPC_ENDPOINT, MNEMONIC, RECIPIENT_BABYLON');
    process.exit(1);
  }

  console.log('Initializing wallet...');
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'xion' });
  const [account] = await wallet.getAccounts();
  console.log('Sender address:', account.address);

  console.log('Connecting to Xion RPC...');
  const client = await SigningStargateClient.connectWithSigner(XION_RPC_ENDPOINT, wallet);
  console.log('Connected.');

  // Determine timeout heights
  const latestHeight = await client.getHeight();
  const timeoutHeight = {
    revisionNumber: 0,
    revisionHeight: latestHeight + 1000
  };
  const timeoutTimestamp = Math.floor(Date.now() / 1000) + TIMEOUT_SECONDS;

  // Build amount and fee
  const amount = [{ denom: 'uxion', amount: AMOUNT_UXION }];
  const fee = { amount: [{ denom: 'uxion', amount: '200' }], gas: '200000' };

  console.log(`Sending ${AMOUNT_UXION} uxion to ${RECIPIENT_BABYLON} via IBC...`);
  let result;
  try {
    result = await sendWithRetry(() =>
      client.sendIbcTokens(
        account.address,
        RECIPIENT_BABYLON,
        amount,
        PORT_ID,
        CHANNEL_ID,
        timeoutHeight,
        timeoutTimestamp,
        fee
      )
    );
  } catch (err) {
    console.error('IBC send failed:', err.message);
    process.exit(1);
  }

  console.log('Transaction hash:', result.transactionHash);
  console.log('Raw code:', result.code);
  if (result.code !== 0) {
    console.error('IBC transfer failed:', result.rawLog);
    process.exit(1);
  }

  // Poll for packet_hash on Union
  try {
    const { packetHash, explorerUrl } = await pollPacketHash(result.transactionHash);
    console.log('Packet hash:', packetHash);
    console.log('Union Explorer URL:', explorerUrl);
  } catch (err) {
    console.error('Polling failed:', err.message);
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
