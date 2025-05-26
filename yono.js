require('dotenv').config();
const bip39 = require('bip39');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SigningStargateClient } = require('@cosmjs/stargate');
const axios = require('axios');

// === Configuration from .env ===
const RPC_ENDPOINT      = process.env.RPC_ENDPOINT;
const REST_ENDPOINT     = process.env.REST_ENDPOINT || RPC_ENDPOINT.replace(/rpc/, 'api');
const MNEMONIC          = process.env.MNEMONIC;
const ADDRESS_PREFIX    = process.env.ADDRESS_PREFIX || 'xion';
const RECIPIENT_BABYLON = process.env.RECIPIENT_BABYLON;
const PORT_ID           = process.env.PORT_ID || 'transfer';
const ENV_CHANNEL_ID    = process.env.CHANNEL_ID;
const DENOM             = process.env.DENOM || 'uxion';
const AMOUNT            = process.env.AMOUNT;
const FEE_DENOM         = process.env.FEE_DENOM || 'uxion';
const FEE_AMOUNT        = process.env.FEE_AMOUNT || '2000';
const GAS_LIMIT         = process.env.GAS_LIMIT || '200000';
const TIMEOUT_SECONDS   = parseInt(process.env.TIMEOUT_SECONDS || '300', 10);
const GRAPHQL_ENDPOINT  = 'https://graphql.union.build/v1/graphql';
const POLL_MAX_RETRIES  = 50;
const POLL_INTERVAL_MS  = 5000;

// Validate required env vars
if (!RPC_ENDPOINT || !MNEMONIC || !RECIPIENT_BABYLON || !AMOUNT) {
  console.error('❌ Missing env vars: RPC_ENDPOINT, MNEMONIC, RECIPIENT_BABYLON, AMOUNT');
  process.exit(1);
}

// Debug env values
console.log('> RPC_ENDPOINT    :', RPC_ENDPOINT);
console.log('> REST_ENDPOINT   :', REST_ENDPOINT);
console.log('> ADDRESS_PREFIX  :', ADDRESS_PREFIX);
console.log('> RECIPIENT       :', RECIPIENT_BABYLON);
console.log('> PORT_ID         :', PORT_ID);
console.log('> DENOM           :', DENOM);
console.log('> AMOUNT          :', AMOUNT);
console.log('> Fee Denom/Amount:', FEE_DENOM, '/', FEE_AMOUNT);
if (ENV_CHANNEL_ID) console.log('> Env CHANNEL_ID  :', ENV_CHANNEL_ID);

async function pollPacketHash(txHash) {
  const query = `query($submission_tx_hash:String!){v2_transfers(args:{p_transaction_hash:$submission_tx_hash}){packet_hash}}`;
  const variables = { submission_tx_hash: txHash };
  for (let i = 1; i <= POLL_MAX_RETRIES; i++) {
    console.log(`Polling Union ${i}/${POLL_MAX_RETRIES}...`);
    try {
      const res = await axios.post(
        GRAPHQL_ENDPOINT,
        { query, variables },
        { headers: { 'Content-Type': 'application/json' } }
      );
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
  // Validate mnemonic
  const mnemonic = MNEMONIC.trim();
  if (!bip39.validateMnemonic(mnemonic)) {
    console.error('❌ Invalid mnemonic format (BIP39 12/24 words).');
    process.exit(1);
  }

  // Initialize wallet
  console.log('🔑 Initializing wallet with prefix:', ADDRESS_PREFIX);
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: ADDRESS_PREFIX });
  const [account] = await wallet.getAccounts();
  console.log('📬 Sender address:', account.address);

  // Connect to RPC
  console.log('🔗 Connecting to RPC endpoint...');
  const client = await SigningStargateClient.connectWithSigner(RPC_ENDPOINT, wallet);
  console.log('✅ Connected to chain.');

  // Determine IBC channel
  let channelId;
  if (ENV_CHANNEL_ID) {
    channelId = ENV_CHANNEL_ID;
    console.log('ℹ️ Using CHANNEL_ID from env:', channelId);
  } else {
    console.log('🔎 Attempting to fetch IBC channels for port', PORT_ID);
    try {
      const url = `${REST_ENDPOINT.replace(/\/$/, '')}/cosmos/ibc/core/channel/v1/channels`;
      const res = await axios.get(url);
      const channels = res.data.channels || [];
      const portChannels = channels.filter(ch => ch.port_id === PORT_ID);
      if (!portChannels.length) throw new Error(`No channels for port ${PORT_ID}`);
      channelId = portChannels[0].channel_id;
      console.log('ℹ️ Detected IBC channel:', channelId);
    } catch (err) {
      console.warn('⚠️ Could not auto-fetch IBC channel:', err.message);
      console.error('❗ Please set CHANNEL_ID manually in .env');
      process.exit(1);
    }
  }

  // Fetch balances
  console.log('💰 Fetching balances...');
  const balances = await client.getAllBalances(account.address);
  console.log('Balances:', balances);
  if (!balances.find(c => c.denom === DENOM)) {
    console.error(`❌ Denom ${DENOM} not found in balances.`);
    process.exit(1);
  }

  // Build timeout
  const latestHeight = await client.getHeight();
  const timeoutHeight = { revisionNumber: 0, revisionHeight: latestHeight + 1000 };
  const timeoutTimestamp = (Math.floor(Date.now() / 1000) + TIMEOUT_SECONDS) * 1_000_000_000;
  // Prepare amount and fee
  const amount = [{ denom: DENOM, amount: AMOUNT }];
  const fee = { amount: [{ denom: FEE_DENOM, amount: FEE_AMOUNT }], gas: GAS_LIMIT };

  // Debug logs
  console.log('>> DEBUG amount         :', amount);
  console.log('>> DEBUG fee            :', fee);
  console.log('>> DEBUG timeoutHeight  :', timeoutHeight);
  console.log('>> DEBUG timeoutTimestamp:', timeoutTimestamp);

  // Send IBC tokens
  console.log(`🚀 Sending ${AMOUNT} (${DENOM}) to ${RECIPIENT_BABYLON} via IBC (${PORT_ID}/${channelId})...`);
  let result;
  try {
    result = await client.sendIbcTokens(
      account.address,
      RECIPIENT_BABYLON,
      amount,
      PORT_ID,
      channelId,
      timeoutHeight,
      timeoutTimestamp,
      fee
    );
  } catch (err) {
    console.error('❌ IBC send failed:', err.message);
    process.exit(1);
  }

  // Check results
  console.log('📨 Tx Hash:', result.transactionHash);
  if (result.code !== 0) {
    console.error('❌ Transfer error:', result.rawLog);
    process.exit(1);
  }

  // Poll Union for packet hash
  try {
    const packetHash = await pollPacketHash(result.transactionHash);
    console.log('🧵 Packet Hash:', packetHash);
    console.log(`🔗 View on Union: https://app.union.build/explorer/transfers/${packetHash}`);
  } catch (err) {
    console.error('❌ Union poll failed:', err.message);
  }

  console.log('✅ Done.');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
