require('dotenv').config();
const bip39 = require('bip39');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SigningStargateClient } = require('@cosmjs/stargate');
const axios = require('axios');

// === Configuration from .env ===
const RPC_ENDPOINT      = process.env.RPC_ENDPOINT;                // RPC URL for Xion chain
const MNEMONIC          = process.env.MNEMONIC;                    // Keplr 24-word seed phrase
const PREFIX            = process.env.PREFIX || 'xion';            // Bech32 prefix
const RECIPIENT_BABYLON = process.env.RECIPIENT_BABYLON;           // e.g. babylon1...
const PORT_ID           = process.env.PORT_ID || 'transfer';       // IBC port
const CHANNEL_ID        = process.env.CHANNEL_ID || 'channel-7';   // IBC channel
typeof CHANNEL_ID;
const DENOM             = process.env.DENOM;                       // Token denom for send, e.g. ibc/...
const AMOUNT            = process.env.AMOUNT;                      // Amount in micro-denom, e.g. '1000000'
const FEE_DENOM         = process.env.FEE_DENOM || DENOM;           // Fee denom (can default to same)
const FEE_AMOUNT        = process.env.FEE_AMOUNT || '2000';        // Fee amount in micro-denom
const GAS_LIMIT         = process.env.GAS_LIMIT || '200000';       // Gas limit
const TIMEOUT_SECONDS   = parseInt(process.env.TIMEOUT_SECONDS || '300', 10); // IBC timeout seconds

// Union GraphQL polling config
const GRAPHQL_ENDPOINT = 'https://graphql.union.build/v1/graphql';
const POLL_MAX_RETRIES = 50;
const POLL_INTERVAL_MS = 5000;

/**
 * Poll Union GraphQL for packet_hash corresponding to txHash
 */
async function pollPacketHash(txHash) {
  const query = `query($submission_tx_hash:String!){ v2_transfers(args:{p_transaction_hash:$submission_tx_hash}) { packet_hash } }`;
  const variables = { submission_tx_hash: txHash };
  for (let i = 1; i <= POLL_MAX_RETRIES; i++) {
    console.log(`Polling Union ${i}/${POLL_MAX_RETRIES}...`);
    try {
      const res = await axios.post(GRAPHQL_ENDPOINT, { query, variables }, { headers: { 'Content-Type':'application/json' } });
      const ph = res.data?.data?.v2_transfers?.[0]?.packet_hash;
      if (ph) return ph;
    } catch (err) {
      console.warn('Poll error:', err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Packet_hash poll timeout');
}

async function main() {
  // Validate ENV
  if (!RPC_ENDPOINT || !MNEMONIC || !RECIPIENT_BABYLON || !DENOM || !AMOUNT) {
    console.error('Missing required .env values: ensure RPC_ENDPOINT, MNEMONIC, RECIPIENT_BABYLON, DENOM, AMOUNT are set');
    process.exit(1);
  }

  // Validate mnemonic
  if (!bip39.validateMnemonic(MNEMONIC.trim())) {
    console.error('Invalid mnemonic format: please provide your 24-word Keplr seed phrase without extra characters');
    process.exit(1);
  }

  console.log('🔑 Initializing wallet...');
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC.trim(), { prefix: PREFIX });
  const [account] = await wallet.getAccounts();
  console.log('📬 Sender address:', account.address);

  console.log('🔗 Connecting to RPC...');
  const client = await SigningStargateClient.connectWithSigner(RPC_ENDPOINT, wallet);
  console.log('✅ Connected to chain.');

  console.log('💰 Checking balances...');
  const balances = await client.getAllBalances(account.address);
  console.log(balances);
  const coin = balances.find(c => c.denom === DENOM);
  if (!coin) {
    console.error(`Denom ${DENOM} not found in account balances. Please check the denom or channel configuration.`);
    process.exit(1);
  }

  // Build IBC timeout parameters
  const latestHeight = await client.getHeight();
  const timeoutHeight = {
    revisionNumber: 0,
    revisionHeight: latestHeight + 1000
  };
  const timeoutTimestamp = Math.floor(Date.now() / 1000) + TIMEOUT_SECONDS;

  // Prepare send and fee objects
  const amount = [{ denom: DENOM, amount: AMOUNT }];
  const fee = { amount: [{ denom: FEE_DENOM, amount: FEE_AMOUNT }], gas: GAS_LIMIT };

  console.log(`🚀 Sending ${AMOUNT} of ${DENOM} to ${RECIPIENT_BABYLON} via IBC (${PORT_ID}/${CHANNEL_ID})...`);
  let res;
  try {
    res = await client.sendIbcTokens(
      account.address,
      RECIPIENT_BABYLON,
      amount,
      PORT_ID,
      CHANNEL_ID,
      timeoutHeight,
      timeoutTimestamp,
      fee
    );
  } catch (err) {
    console.error('IBC send error:', err.message);
    process.exit(1);
  }

  console.log('📨 Transaction Hash:', res.transactionHash);
  if (res.code !== 0) {
    console.error('IBC transfer failed:', res.rawLog);
    process.exit(1);
  }

  // Poll Union for packet
  try {
    const packetHash = await pollPacketHash(res.transactionHash);
    console.log('🧵 Packet Hash:', packetHash);
    console.log(`🔗 View on Union: https://app.union.build/explorer/transfers/${packetHash}`);
  } catch (err) {
    console.error('Polling Union failed:', err.message);
  }

  console.log('✅ Done.');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
