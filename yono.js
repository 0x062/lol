require('dotenv').config();
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SigningStargateClient } = require('@cosmjs/stargate');
const axios = require('axios');

const XION_RPC_ENDPOINT = process.env.XION_RPC_ENDPOINT;
const MNEMONIC = process.env.MNEMONIC;
const RECIPIENT_BABYLON = process.env.RECIPIENT_BABYLON;
const AMOUNT_UXION = process.env.AMOUNT_UXION || '1000';
const CHANNEL_ID = process.env.CHANNEL_ID || 'channel-7';
const TIMEOUT_SECONDS = parseInt(process.env.TIMEOUT_SECONDS || '300', 10);

const GRAPHQL_ENDPOINT = 'https://graphql.union.build/v1/graphql';
const POLL_MAX_RETRIES = 50;
const POLL_INTERVAL_MS = 5000;

async function pollPacketHash(txHash) {
  const query = `query($submission_tx_hash: String!){v2_transfers(args:{p_transaction_hash:$submission_tx_hash}){packet_hash}}`;
  const variables = { submission_tx_hash: txHash };
  for (let i = 0; i < POLL_MAX_RETRIES; i++) {
    try {
      const response = await axios.post(GRAPHQL_ENDPOINT, { query, variables }, { headers: { 'Content-Type': 'application/json' } });
      const ph = response.data?.data?.v2_transfers?.[0]?.packet_hash;
      if (ph) return { packetHash: ph, explorerUrl: `https://app.union.build/explorer/transfers/${ph}` };
    } catch (err) {}
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('Timeout');
}

async function main() {
  if (!XION_RPC_ENDPOINT || !MNEMONIC || !RECIPIENT_BABYLON) process.exit(1);
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'xion' });
  const [account] = await wallet.getAccounts();
  console.log(account.address);
  const client = await SigningStargateClient.connectWithSigner(XION_RPC_ENDPOINT, wallet);
  const amount = [{ denom: 'uxion', amount: AMOUNT_UXION }];
  const fee = { amount: [{ denom: 'uxion', amount: '200' }], gas: '200000' };
  const timeoutTimestamp = Math.floor(Date.now() / 1000) + TIMEOUT_SECONDS;
  const result = await client.sendIbcTokens(
    account.address,
    RECIPIENT_BABYLON,
    amount,
    'transfer',
    CHANNEL_ID,
    { revisionNumber: 0, revisionHeight: 0 }, // timeoutHeight
    timeoutTimestamp,                         // timeoutTimestamp
    fee
  );
  if (result.code !== 0) process.exit(1);
  console.log(result.transactionHash);
  try {
    const { packetHash, explorerUrl } = await pollPacketHash(result.transactionHash);
    console.log(packetHash, explorerUrl);
  } catch (err) {}
}

main().catch(() => process.exit(1));
