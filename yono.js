require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const { toBech32 } = require('@cosmjs/encoding');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SigningStargateClient } = require('@cosmjs/stargate');
const axios = require('axios');

const RPC_ENDPOINT       = process.env.RPC_ENDPOINT;
const PREFIX             = "xion";
const AMOUNT_TO_SEND     = "1000"; // 0.001 XION = 1000 uxion
const GRAPHQL_ENDPOINT   = "https://graphql.union.build/v1/graphql";
const POLL_MAX_RETRIES   = 50;
const POLL_INTERVAL_MS   = 5000;

const amount = { denom: "uxion", amount: AMOUNT_TO_SEND };
const fee    = { amount: [{ denom: "uxion", amount: "200" }], gas: "200000" };

function generateXionAddress() {
  const randomBytes = crypto.randomBytes(20);
  return toBech32(PREFIX, randomBytes);
}

async function pollPacketHash(txHash) {
  const query = `
    query ($submission_tx_hash: String!) {
      v2_transfers(args: {p_transaction_hash: $submission_tx_hash}) {
        packet_hash
      }
    }
  `;
  const variables = { submission_tx_hash: txHash };
  const headers = { "Content-Type": "application/json" };

  for (let i = 0; i < POLL_MAX_RETRIES; i++) {
    try {
      const res = await axios.post(GRAPHQL_ENDPOINT, { query, variables }, { headers });
      const packetHash = res.data?.data?.v2_transfers?.[0]?.packet_hash;
      if (packetHash) {
        return {
          packetHash,
          explorerUrl: `https://app.union.build/explorer/transfers/${packetHash}`
        };
      }
    } catch (err) {
      console.error(`Polling error (${i+1}/${POLL_MAX_RETRIES}):`, err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Timeout: packet_hash not found within max retries");
}

async function main() {
  // 1. Generate dummy addresses
  const dummyAddresses = Array.from({ length: 10 }, generateXionAddress);
  fs.writeFileSync('wallet.txt', dummyAddresses.join('\n'));
  console.log("Generated 10 dummy XION addresses → wallet.txt");

  // 2. Load sender wallet
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    console.error("Error: MNEMONIC belum diset di .env");
    process.exit(1);
  }
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: PREFIX });
  const [account] = await wallet.getAccounts();
  const senderAddress = account.address;
  console.log("Sender address:", senderAddress);

  // 3. Connect client
  const client = await SigningStargateClient.connectWithSigner(RPC_ENDPOINT, wallet);

  // 4. Loop transaksi
  for (let i = 0; i < dummyAddresses.length; i++) {
    const to = dummyAddresses[i];
    console.log(`\n→ Tx ${i+1}: ${senderAddress} → ${to}`);

    try {
      const result = await client.sendTokens(
        senderAddress,
        to,
        [amount],
        fee,
        `Test tx ${i+1}`
      );
      if (result.code !== 0) {
        console.error(`  ✗ On-chain failed: code=${result.code}, log=${result.rawLog}`);
        continue;
      }
      console.log(`  ✓ On-chain TX Hash: ${result.transactionHash}`);

      // 5. Poll Union GraphQL for packet_hash
      try {
        const { packetHash, explorerUrl } = await pollPacketHash(result.transactionHash);
        console.log(`  ✓ packet_hash: ${packetHash}`);
        console.log(`  ✓ Explorer URL: ${explorerUrl}`);
      } catch (pollErr) {
        console.error(`  ✗ Polling failed: ${pollErr.message}`);
      }

    } catch (err) {
      console.error(`  ✗ Unexpected error:`, err.message);
    }
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
