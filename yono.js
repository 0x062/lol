require('dotenv').config();
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SigningStargateClient } = require('@cosmjs/stargate');
const axios = require('axios');

// Environment variables
const RPC_ENDPOINT       = process.env.RPC_ENDPOINT;
const MNEMONIC           = process.env.MNEMONIC;
const PREFIX             = process.env.PREFIX || 'xion';
const RECIPIENT_BABYLON  = process.env.RECIPIENT_BABYLON;
const PORT_ID            = process.env.PORT_ID || 'transfer';
const CHANNEL_ID         = process.env.CHANNEL_ID || 'channel-7';
const AMOUNT_UXION       = process.env.AMOUNT_UXION || '1000';
const FEE_UXION          = process.env.FEE_UXION || '200';
const GAS_LIMIT          = process.env.GAS_LIMIT || '200000';
const TIMEOUT_SECONDS    = parseInt(process.env.TIMEOUT_SECONDS || '300', 10);

// Union GraphQL polling
const GRAPHQL_ENDPOINT = 'https://graphql.union.build/v1/graphql';
const POLL_MAX_RETRIES = 50;
const POLL_INTERVAL_MS = 5000;

/**
 * Poll Union for packet_hash
 */
async function pollPacketHash(txHash) {
  const query = `query($hash:String!){v2_transfers(args:{p_transaction_hash:$hash}){packet_hash}}`;
  const vars = { hash: txHash };
  for (let i = 1; i <= POLL_MAX_RETRIES; i++) {
    console.log(`Polling Union ${i}/${POLL_MAX_RETRIES}...`);
    try {
      const res = await axios.post(
        GRAPHQL_ENDPOINT,
        { query, variables: vars },
        { headers: { 'Content-Type': 'application/json' } }
      );
      const ph = res.data?.data?.v2_transfers?.[0]?.packet_hash;
      if (ph) return ph;
    } catch (err) {
      console.log('Poll error:', err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Packet_hash poll timeout');
}

async function main() {
  if (!RPC_ENDPOINT || !MNEMONIC || !RECIPIENT_BABYLON) {
    console.error('Missing ENV: RPC_ENDPOINT, MNEMONIC, RECIPIENT_BABYLON');
    process.exit(1);
  }

  console.log('🔑 Initializing wallet...');
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: PREFIX });
  const [account] = await wallet.getAccounts();
  console.log('📬 Sender:', account.address);

  console.log('🔗 Connecting to RPC...');
  const client = await SigningStargateClient.connectWithSigner(RPC_ENDPOINT, wallet);
  console.log('✅ Connected.');

  console.log('💰 Checking balances...');
  const balances = await client.getAllBalances(account.address);
  console.log(balances);
  const coin = balances.find(c => c.denom === 'uxion');
  if (!coin) {
    console.error('Denom uxion not found. Check chain balances above.');
    process.exit(1);
  }

  // Build IBC timeout
  const latestHeight = await client.getHeight();
  const timeoutHeight = {
    revisionNumber: 0,
    revisionHeight: latestHeight + 1000
  };
  const timeoutTimestamp = Math.floor(Date.now() / 1000) + TIMEOUT_SECONDS;

  const amount = [{ denom: 'uxion', amount: AMOUNT_UXION }];
  const fee    = { amount: [{ denom: 'uxion', amount: FEE_UXION }], gas: GAS_LIMIT };

  console.log(`🚀 Sending ${AMOUNT_UXION} uxion to ${RECIPIENT_BABYLON} via IBC...`);
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

  console.log('📨 TxHash:', res.transactionHash);
  if (res.code !== 0) {
    console.error('IBC transfer failed:', res.rawLog);
    process.exit(1);
  }

  try {
    const packetHash = await pollPacketHash(res.transactionHash);
    console.log('🧵 PacketHash:', packetHash);
    console.log(`🔗 Union URL: https://app.union.build/explorer/transfers/${packetHash}`);
  } catch (err) {
    console.error('Polling failed:', err.message);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
