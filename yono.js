require('dotenv').config();
const bip39 = require('bip39');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SigningStargateClient } = require('@cosmjs/stargate');
const axios = require('axios');

// === Configuration from .env ===
const RPC_ENDPOINT      = process.env.RPC_ENDPOINT;
const MNEMONIC          = process.env.MNEMONIC;
const RECIPIENT_BABYLON = process.env.RECIPIENT_BABYLON;
const PORT_ID           = process.env.PORT_ID || 'transfer';
const CHANNEL_ID        = process.env.CHANNEL_ID || 'channel-7';
const DENOM             = process.env.DENOM;
const AMOUNT            = process.env.AMOUNT;
const FEE_DENOM         = process.env.FEE_DENOM || 'uxion';
const FEE_AMOUNT        = process.env.FEE_AMOUNT || '2000';
const GAS_LIMIT         = process.env.GAS_LIMIT || '200000';
const TIMEOUT_SECONDS   = parseInt(process.env.TIMEOUT_SECONDS || '300', 10);
const GRAPHQL_ENDPOINT  = 'https://graphql.union.build/v1/graphql';
const POLL_MAX_RETRIES  = 50;
const POLL_INTERVAL_MS  = 5000;

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
  // Required ENV
  if (!RPC_ENDPOINT || !MNEMONIC || !RECIPIENT_BABYLON || !DENOM || !AMOUNT) {
    console.error('Missing .env values: RPC_ENDPOINT, MNEMONIC, RECIPIENT_BABYLON, DENOM, AMOUNT');
    process.exit(1);
  }

  // Validate mnemonic
  const mnemonic = MNEMONIC.trim();
  if (!bip39.validateMnemonic(mnemonic)) {
    console.error('Invalid mnemonic format. Ensure it is a BIP39 seed phrase (12/24 words).');
    process.exit(1);
  }

  // Static prefix
  const prefix = process.env.PREFIX || 'xion';
  console.log('🔑 Using prefix:', prefix);

  // Initialize wallet
  console.log('🔑 Initializing wallet from mnemonic...');
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix });
  const [account] = await wallet.getAccounts();
  console.log('📬 Sender address:', account.address);

  // Connect to RPC
  console.log('🔗 Connecting to RPC endpoint...');
  const client = await SigningStargateClient.connectWithSigner(RPC_ENDPOINT, wallet);
  console.log('✅ Connected to chain.');

  // Check balances
  console.log('💰 Fetching balances...');
  const balances = await client.getAllBalances(account.address);
  console.log('Balances:', balances);

  if (!balances.find(c => c.denom === DENOM)) {
    console.error(`Denom ${DENOM} not in balances. Check chain and channel configuration.`);
    process.exit(1);
  }

  // Build IBC timeout
  const latestHeight = await client.getHeight();
  const timeoutHeight = { revisionNumber: 0, revisionHeight: latestHeight + 1000 };
  const timeoutTimestamp = Math.floor(Date.now() / 1000) + TIMEOUT_SECONDS;

  // Prepare amount and fee
  const amount = [{ denom: DENOM, amount: AMOUNT }];
  const fee = { amount: [{ denom: FEE_DENOM, amount: FEE_AMOUNT }], gas: GAS_LIMIT };

  // Debug logs
  console.log('>> DEBUG amount:', amount);
  console.log('>> DEBUG fee:', fee);
  console.log('>> DEBUG timeoutHeight:', timeoutHeight);
  console.log('>> DEBUG timeoutTimestamp:', timeoutTimestamp);

  // Send IBC tokens
  console.log(`🚀 Sending ${AMOUNT} (${DENOM}) to ${RECIPIENT_BABYLON} via IBC (${PORT_ID}/${CHANNEL_ID})...`);
  let result;

  try {
    result = await client.sendIbcTokens(
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
    console.error('❌ IBC send failed:', err.message);
    process.exit(1);
  }

  console.log('📨 Tx Hash:', result.transactionHash);
  if (result.code !== 0) {
    console.error('❌ IBC transfer error:', result.rawLog);
    process.exit(1);
  }

  // Poll Union for packet_hash
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
