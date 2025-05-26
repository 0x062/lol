require('dotenv').config();
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SigningStargateClient, calculateFee } = require('@cosmjs/stargate');
const axios = require('axios');

// Environment variables
const XION_RPC_ENDPOINT    = process.env.XION_RPC_ENDPOINT;    // RPC endpoint Xion chain
const MNEMONIC             = process.env.MNEMONIC;             // Keplr-like mnemonic
const RECIPIENT_BABYLON    = process.env.RECIPIENT_BABYLON;    // address di Babylon chain
const AMOUNT_UXION         = process.env.AMOUNT_UXION || "1000"; // 1000 uxion = 0.001 XION

// IBC transfer config
const PORT_ID    = "transfer";
const CHANNEL_ID = process.env.CHANNEL_ID || "channel-7"; // channel connecting Xion→Babylon
const TIMEOUT_SECONDS = parseInt(process.env.TIMEOUT_SECONDS || "300"); // seconds

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
  for (let i = 0; i < POLL_MAX_RETRIES; i++) {
    try {
      const res = await axios.post(GRAPHQL_ENDPOINT, { query, variables });
      const ph = res.data?.data?.v2_transfers?.[0]?.packet_hash;
      if (ph) return { packetHash: ph, explorerUrl: `https://app.union.build/explorer/transfers/${ph}` };
    } catch (e) {
      console.error(`Polling error ${i+1}:`, e.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Timeout polling packet_hash');
}

async function main() {
  if (!XION_RPC_ENDPOINT || !MNEMONIC || !RECIPIENT_BABYLON) {
    console.error('Need XION_RPC_ENDPOINT, MNEMONIC, RECIPIENT_BABYLON in .env');
    process.exit(1);
  }

  // Setup wallet & client
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'xion' });
  const [account] = await wallet.getAccounts();
  console.log('Sender:', account.address);

  const client = await SigningStargateClient.connectWithSigner(XION_RPC_ENDPOINT, wallet);

  // Prepare IBC amount and fee
  const amount = { denom: 'uxion', amount: AMOUNT_UXION };
  const fee = calculateFee(200000, { denom: 'uxion', amount: '200' });

  console.log(`Sending IBC transfer to ${RECIPIENT_BABYLON} via ${PORT_ID}/${CHANNEL_ID}`);
  const result = await client.sendIbcTokens(
    account.address,
    RECIPIENT_BABYLON,
    [amount],
    PORT_ID,
    CHANNEL_ID,
    Math.floor(Date.now() / 1000) + TIMEOUT_SECONDS,
    fee
  );

  if (result.code !== 0) {
    console.error('IBC transfer failed:', result.rawLog);
    process.exit(1);
  }
  console.log('On-chain TX Hash:', result.transactionHash);

  // Optional: Poll GraphQL for union packet hash
  try {
    const { packetHash, explorerUrl } = await pollPacketHash(result.transactionHash);
    console.log('Packet Hash:', packetHash);
    console.log('Union Explorer:', explorerUrl);
  } catch (e) {
    console.error('Polling failed:', e.message);
  }
}

main().catch(console.error);
